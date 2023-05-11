import type { ChatRequest, ChatResponse } from "./api/openai/typing";
import {
  Message,
  ModelConfig,
  ModelType,
  SummaryLevel,
  useAccessStore,
  useAppConfig,
  useChatStore,
  ChatSession,
} from "./store";
import { showToast } from "./components/ui-lib";
import { ACCESS_CODE_PREFIX } from "./constant";
import { INCREMENTAL_SUMMARY_PREFIX } from "./constant";
import Locale from "./locales";

const TIME_OUT_MS = 60000;

const makeRequestParam = (
  messages: Message[],
  options?: {
    stream?: boolean;
    overrideModel?: ModelType;
    overrideTemperature?: number;
    overridePresencePenalty?: number;
  },
): ChatRequest => {
  let session = useChatStore.getState().currentSession();
  let summaryIntro: Message = {
    role: "system",
    content: `Note that any message prefixed by "${INCREMENTAL_SUMMARY_PREFIX}" has been previously summarized by you, so it does not appear in full or in the original form.`,
    date: "",
  };
  let sendMessages = [summaryIntro, ...messages]
    .map((message) => getMessageOrSummary(message, session))
    .map(([message, inSummary]) => {
      return {
        role: message.role,
        content: inSummary
          ? `${INCREMENTAL_SUMMARY_PREFIX} ${message.content}`
          : message.content,
      };
    });

  const modelConfig = {
    ...useAppConfig.getState().modelConfig,
    ...useChatStore.getState().currentSession().mask.modelConfig,
  };

  // override model config
  if (options?.overrideModel) {
    modelConfig.model = options.overrideModel;
  }
  if (options?.overrideTemperature != null) {
    modelConfig.temperature = options?.overrideTemperature;
  }
  if (options?.overridePresencePenalty != null) {
    modelConfig.presence_penalty = options?.overridePresencePenalty;
  }

  return {
    messages: sendMessages,
    stream: options?.stream,
    model: modelConfig.model,
    temperature: modelConfig.temperature,
    presence_penalty: modelConfig.presence_penalty,
  };
};

function getHeaders() {
  const accessStore = useAccessStore.getState();
  let headers: Record<string, string> = {};

  const makeBearer = (token: string) => `Bearer ${token.trim()}`;
  const validString = (x: string) => x && x.length > 0;

  // use user's api key first
  if (validString(accessStore.token)) {
    headers.Authorization = makeBearer(accessStore.token);
  } else if (
    accessStore.enabledAccessControl() &&
    validString(accessStore.accessCode)
  ) {
    headers.Authorization = makeBearer(
      ACCESS_CODE_PREFIX + accessStore.accessCode,
    );
  }

  return headers;
}

export function requestOpenaiClient(path: string) {
  const openaiUrl = useAccessStore.getState().openaiUrl;
  return (body: any, method = "POST") =>
    fetch(openaiUrl + path, {
      method,
      body: body && JSON.stringify(body),
      headers: getHeaders(),
    });
}

export async function requestChat(
  messages: Message[],
  options?: {
    model?: ModelType;
    temperature?: number;
    presencePenalty?: number;
  },
) {
  const req: ChatRequest = makeRequestParam(messages, {
    overrideModel: options?.model,
    overrideTemperature: options?.temperature,
    overridePresencePenalty: options?.presencePenalty,
    stream: false,
  });

  const res = await requestOpenaiClient("v1/chat/completions")(req);

  try {
    const response = (await res.json()) as ChatResponse;
    return response;
  } catch (error) {
    console.error("[Request Chat] ", error, res.body);
  }
}

export async function requestUsage() {
  const formatDate = (d: Date) =>
    `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
      .getDate()
      .toString()
      .padStart(2, "0")}`;
  const ONE_DAY = 1 * 24 * 60 * 60 * 1000;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = formatDate(startOfMonth);
  const endDate = formatDate(new Date(Date.now() + ONE_DAY));

  const [used, subs] = await Promise.all([
    requestOpenaiClient(
      `dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
    )(null, "GET"),
    requestOpenaiClient("dashboard/billing/subscription")(null, "GET"),
  ]);

  const response = (await used.json()) as {
    total_usage?: number;
    error?: {
      type: string;
      message: string;
    };
  };

  const total = (await subs.json()) as {
    hard_limit_usd?: number;
  };

  if (response.error && response.error.type) {
    showToast(response.error.message);
    return;
  }

  if (response.total_usage) {
    response.total_usage = Math.round(response.total_usage) / 100;
  }

  if (total.hard_limit_usd) {
    total.hard_limit_usd = Math.round(total.hard_limit_usd * 100) / 100;
  }

  return {
    used: response.total_usage,
    subscription: total.hard_limit_usd,
  };
}

export async function requestChatStream(
  messages: Message[],
  options?: {
    modelConfig?: ModelConfig;
    overrideModel?: ModelType;
    onMessage: (message: string, done: boolean) => void;
    onError: (error: Error, statusCode?: number) => void;
    onController?: (controller: AbortController) => void;
  },
) {
  const req = makeRequestParam(messages, {
    stream: true,
    overrideModel: options?.overrideModel,
  });

  console.log("[Request] ", req);

  const controller = new AbortController();
  const reqTimeoutId = setTimeout(() => controller.abort(), TIME_OUT_MS);

  try {
    const openaiUrl = useAccessStore.getState().openaiUrl;

    const futureRes = fetch(openaiUrl + "v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getHeaders(),
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    const concatedMessages: string = messages
      .map((message) => message.content)
      .join("\n");

    const res = await futureRes;

    clearTimeout(reqTimeoutId);

    let responseText = "";

    const finish = () => {
      options?.onMessage(responseText, true);
      controller.abort();
    };

    if (res.ok) {
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      options?.onController?.(controller);

      while (true) {
        const resTimeoutId = setTimeout(finish, TIME_OUT_MS);
        const content = await reader?.read();
        clearTimeout(resTimeoutId);

        if (!content || !content.value) {
          break;
        }

        const text = decoder.decode(content.value, { stream: true });
        responseText += text;

        const done = content.done;
        options?.onMessage(responseText, false);

        if (done) {
          break;
        }
      }

      finish();
    } else if (res.status === 401) {
      console.error("Unauthorized");
      options?.onError(new Error("Unauthorized"), res.status);
    } else {
      console.error("Stream Error", res.body);
      options?.onError(new Error("Stream Error"), res.status);
    }
  } catch (err) {
    console.error("NetWork Error", err);
    options?.onError(err as Error);
  }
}

export async function requestWithPrompt(
  messages: Message[],
  prompt: string,
  options?: {
    model?: ModelType;
    temperature?: number;
    presencePenalty?: number;
  },
) {
  messages = messages.concat([
    {
      role: "user",
      content: prompt,
      date: new Date().toLocaleString(),
    },
  ]);

  const res = await requestChat(messages, options);

  return res?.choices?.at(0)?.message?.content ?? "";
}

export function annotateTokenCount(
  message: Message,
): Promise<Message | undefined | null> {
  if (!message.content) {
    return Promise.resolve(message);
  }
  const shuffledText = shuffleWords(message.content);
  return requestChat(
    [
      {
        role: "user",
        content: `${shuffledText}\nNevermind`,
        date: "",
      },
    ],
    {
      model: "gpt-3.5-turbo",
      temperature: 0.2,
      presencePenalty: 0,
    },
  ).then((response) => {
    let nTokens = response?.usage?.prompt_tokens;
    if (nTokens) {
      message.nTokens = nTokens;
      return message;
    }
    return message;
  });
}

export function isMessageInSummaryMode(
  message: Message,
  session: ChatSession,
  checkFlag: boolean = false,
): boolean {
  return (message.summary && (!checkFlag || message.useSummary)) || false;
}

export function getMessageOrSummary(
  message: Message,
  session: ChatSession,
  checkFlag: boolean = false,
): [Message, boolean] {
  let inSummaryMode = isMessageInSummaryMode(message, session, checkFlag);
  return [
    {
      role: message.role,
      content: (inSummaryMode ? message.summary : message.content) || "",
      date: message.date,
    },
    inSummaryMode,
  ];
}

export function summarizeMessageIncrementally(
  message: Message,
  session: ChatSession,
): Promise<Message | undefined | null> {
  if (session.mask.modelConfig.summaryLevel != SummaryLevel.Incremental) {
    return Promise.resolve(message);
  }

  if (
    message.content.length <
    session.mask.modelConfig.compressMessageLengthThreshold
  ) {
    return Promise.resolve(message);
  }

  let systemMessages: Message[] = session.mask.context.filter(
    (message) => message.role == "system",
  );
  const i = session.messages.indexOf(message);
  if (i == -1) {
    return Promise.resolve(message);
  }
  return requestChat(
    [
      ...systemMessages,
      {
        role: "system",
        content: Locale.Store.Prompt.SummarizeIncremental,
        date: "",
      },
      ...session.messages
        .slice(0, i + 1)
        .map((message) => getMessageOrSummary(message, session, false))
        .map(([message, inSummaryMode]) => message),
    ],
    {
      model: "gpt-4",
      temperature: 0.7,
      presencePenalty: 0,
    },
  ).then((response) => {
    let summary = response?.choices?.at(0)?.message?.content;
    if (summary) {
      message.summary = summary;
      message.useSummary = true;
      message.nSummaryTokens = response?.usage?.completion_tokens;
      console.log("Summary:");
      console.log("Summary:");
    }
    return message;
  });
}

function shuffleWords(input: string): string {
  // Split string into words
  let words = input.split(" ");

  // Shuffle array in-place
  for (let i = words.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }

  // Rejoin words into a string
  return words.join(" ");
}

// To store message streaming controller
export const ControllerPool = {
  controllers: {} as Record<string, AbortController>,

  addController(
    sessionIndex: number,
    messageId: number,
    controller: AbortController,
  ) {
    const key = this.key(sessionIndex, messageId);
    this.controllers[key] = controller;
    return key;
  },

  stop(sessionIndex: number, messageId: number) {
    const key = this.key(sessionIndex, messageId);
    const controller = this.controllers[key];
    controller?.abort();
  },

  stopAll() {
    Object.values(this.controllers).forEach((v) => v.abort());
  },

  hasPending() {
    return Object.values(this.controllers).length > 0;
  },

  remove(sessionIndex: number, messageId: number) {
    const key = this.key(sessionIndex, messageId);
    delete this.controllers[key];
  },

  key(sessionIndex: number, messageIndex: number) {
    return `${sessionIndex},${messageIndex}`;
  },
};
