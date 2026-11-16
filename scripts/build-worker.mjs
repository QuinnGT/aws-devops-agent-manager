// Bundles the worker (src/worker/index.ts), the migration runner and the demo seed into dist/ for the container image.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const empty = fileURLToPath(new URL("../test/setup/empty.ts", import.meta.url));

// Packages imported through a CommonJS deep path with no "exports" map (for
// example "ajv/dist/2020") don't resolve under Node's ESM loader, so they are
// bundled. Every other npm package stays a runtime import from node_modules.
const BUNDLED_PACKAGES = ["ajv"];

// The demo seed also uses a development-only package (the mocked Agent Space), which the
// image's production install doesn't have, so it is bundled into dist/demo-seed.mjs too.
const DEMO_SEED_BUNDLED_PACKAGES = [...BUNDLED_PACKAGES, "aws-sdk-client-mock"];

/**
 * @param {string[]} bundled packages to bundle instead of importing at runtime
 * @returns {import("esbuild").Plugin}
 */
function externalizeNodeModules(bundled) {
  return {
    name: "externalize-node-modules",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith("@/") || args.path.startsWith("node:")) return undefined;
        // "server-only" throws outside a React server build; the alias below swaps in an empty module.
        if (args.path === "server-only") return undefined;
        // Imports made from inside a bundled package (its own dependencies) are bundled too:
        // with pnpm they aren't resolvable from dist/ at runtime.
        if (args.importer.includes("/node_modules/")) return undefined;
        const pkg = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0];
        if (bundled.includes(pkg)) return undefined;
        return { path: args.path, external: true };
      });
    },
  };
}

const requireShim =
  "import { createRequire as __damCreateRequire } from 'node:module'; const require = __damCreateRequire(import.meta.url);";

// test/helpers/fixtures.ts, which the demo seed imports, finds sample-data/ through __dirname, which an ES
// module doesn't have. Point it at <app>/test/helpers so "../../sample-data" is <app>/sample-data
// (the image copies sample-data/ next to dist/). The folder itself doesn't need to exist.
const dirnameShim =
  "import { fileURLToPath as __damFileURLToPath } from 'node:url'; globalThis.__dirname ??= __damFileURLToPath(new URL('../test/helpers/', import.meta.url));";

const shared = {
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  alias: { "server-only": empty },
  logLevel: "info",
};

await build({
  ...shared,
  entryPoints: { worker: "src/worker/index.ts", migrate: "src/server/db/migrate.ts" },
  plugins: [externalizeNodeModules(BUNDLED_PACKAGES)],
  banner: { js: requireShim },
});

await build({
  ...shared,
  entryPoints: { "demo-seed": "scripts/demo-seed/all.ts" },
  plugins: [externalizeNodeModules(DEMO_SEED_BUNDLED_PACKAGES)],
  banner: { js: `${requireShim} ${dirnameShim}` },
});
