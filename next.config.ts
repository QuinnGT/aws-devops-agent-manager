import type { NextConfig } from "next";

// Every page in this app reads the signed-in user and live data, so there is
// almost nothing to prerender. Cache Components is left off to keep the
// classic request-time rendering model (see AGENTS.md, "Rendering").
const allowedOrigins = (process.env.DAM_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["pg-boss", "simple-git", "pg"],
  experimental: {
    serverActions: {
      allowedOrigins,
      bodySizeLimit: "50mb",
    },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
