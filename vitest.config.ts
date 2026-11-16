import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two projects:
//   unit         *.test.ts(x)      no database, no network, no AWS
//   integration  *.int.test.ts     needs TEST_DATABASE_URL (a disposable database)
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // fileURLToPath, not URL.pathname: pathname keeps a space in the checkout path as %20.
    alias: { "server-only": fileURLToPath(new URL("./test/setup/empty.ts", import.meta.url)) },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "node_modules/**"],
          setupFiles: ["test/setup/unit.ts"],
          // Git-backed tests build small repositories in beforeAll; under a loaded host that can pass 10 s.
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.int.test.ts", "test/**/*.int.test.ts"],
          setupFiles: ["test/setup/integration.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
