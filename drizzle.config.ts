import { defineConfig } from "drizzle-kit";
import { readFileSync } from "node:fs";

function databaseUrl(): string {
  if (process.env.DATABASE_URL_FILE) return readFileSync(process.env.DATABASE_URL_FILE, "utf8").trim();
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new Error("Set DATABASE_URL or DATABASE_URL_FILE");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl() },
  strict: true,
  verbose: false,
});
