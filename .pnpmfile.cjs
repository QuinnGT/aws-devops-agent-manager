// better-auth lists drizzle-kit and vitest as optional peers, which only its test-utils import. Both are
// devDependencies here, so pnpm linked them into better-auth's production tree and `pnpm prune --prod` kept
// them, shipping esbuild, vite and tsx (and their CVEs) in the image. Dropping the two peers keeps them dev-only.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "better-auth") {
        for (const name of ["drizzle-kit", "vitest"]) {
          delete pkg.peerDependencies?.[name];
          delete pkg.peerDependenciesMeta?.[name];
        }
      }
      return pkg;
    },
  },
};
