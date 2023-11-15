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
import { ChatCompletionRequestMessage } from "openai";
import { useSubmit } from "react-router-dom";

const TIME_OUT_MS = 60000;

export type SummaryResponse = {
  messageId?: number;
  summary?: string;
  nSummaryTokens?: number;
};

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
  let baseMessages = messages.map((message) => {
    return {
      role: message.role,
      content: message.useSummary
        ? `${INCREMENTAL_SUMMARY_PREFIX} ${message.summary}`
        : message.content,
    };
  });
  let sendMessages = [
    {
      role: "system",
      content:
        "You are a Swifty! Answer any questions and conduct conversations carefully and to the point, addressing an intelligent teenager. But whenever possible, also insert a relevant(-ish) Taylor Swift quote or trivia (don't make these up). Ideally, the (relative) relevance of the quote/trivia, or the way you introduce it, should be sly, funny or ridiculous. BTW, you're favorite album is 1989, but you can change your mind as to your favorite song. And you hate Olivia Rodrigo - be funny about that too. Good luck!",
    },
    ...baseMessages,
  ];

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

export function requestTokenCount(message: Message): Promise<number | null> {
  if (!message.content) {
    return Promise.resolve(0);
  }
  const sortedText = message.content
    .toLowerCase()
    .replaceAll(",", "!")
    .split(" ")
    .sort()
    .join(",");
  return requestChat(
    [
      {
        role: "user",
        content: `Is the following word list sorted?\n\n${sortedText}`,
        date: "",
      },
    ],
    {
      model: "gpt-3.5-turbo",
      temperature: 0.7,
      presencePenalty: 0,
    },
  ).then((response) => {
    let nTokens = response?.usage?.prompt_tokens;
    if (nTokens) {
      return nTokens;
    }
    return null;
  });
}

export function summarizeMessageIncrementally(
  message: Message,
  session: ChatSession,
): Promise<SummaryResponse> {
  // if (session.mask.modelConfig.summaryLevel != SummaryLevel.Incremental) {
  //   return Promise.resolve(message);
  // }

  // if (message.content.length < 100) {
  //   return Promise.resolve(message);
  // }

  let systemMessages: Message[] = session.mask.context.filter(
    (message) => message.role == "system",
  );
  const i = session.messages.indexOf(message);
  if (i == -1) {
    return Promise.resolve({ messageId: message.id });
  }
  return requestChat(
    [
      ...systemMessages,
      ...session.messages.slice(0, i).filter((message) => !message.hidden),
      {
        role: "system",
        content: Locale.Store.Prompt.SummarizeIncremental,
        date: message.date,
      },
      message,
    ],
    {
      model: "gpt-4",
      temperature: 0.7,
      presencePenalty: 0,
    },
  ).then((response) => {
    return {
      messageId: message.id,
      summary: response?.choices?.at(0)?.message?.content,
      nSummaryTokens: response?.usage?.completion_tokens,
    };
  });
}

export function summarizeMessage(
  messageForSummary: Message,
  session: ChatSession,
) {
  summarizeMessageIncrementally(messageForSummary, session).then(
    (summaryResponse) => {
      if (!summaryResponse.summary) return;
      let message: Message = session.messages.filter(
        (m) => m.id == summaryResponse.messageId,
      )[0];
      if (message) {
        message.summary = summaryResponse.summary;
        message.useSummary = true;
        message.nSummaryTokens = summaryResponse.nSummaryTokens;
      }
    },
  );
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
