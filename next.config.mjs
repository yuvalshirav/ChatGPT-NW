/** @type {import('next').NextConfig} */

const nextConfig = {
  experimental: {
    appDir: true,
    asyncWebAssembly: true,
    syncWebAssembly: true
  },
  async rewrites() {
    const ret = [];

    const apiUrl = process.env.API_URL;
    if (apiUrl) {
      console.log("[Next] using api url ", apiUrl);
      ret.push({
        source: "/api/:path*",
        destination: `${apiUrl}/:path*`,
      });
    }

    return {
      beforeFiles: ret,
    };
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ["@svgr/webpack"],
    });
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'webassembly/sync',
      use: {
        loader: 'wasm-loader',
    }});

    return config;
  },
  output: "standalone",
};

export default nextConfig;
