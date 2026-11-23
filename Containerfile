# One image for the web app, the worker and the demo seed (`web`, `worker` or `demo-seed` as the command).
# Build with Podman: podman build -t localhost/devops-agent-manager:dev -f Containerfile .
# `./scripts/stack.sh up` and `./scripts/stack.sh demo` build it for you.

FROM docker.io/library/node:24-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# The license list is written before pruning, and only for the production dependencies the image ships.
RUN pnpm build \
  && pnpm licenses list --prod --json > THIRD_PARTY_LICENSES.json \
  && pnpm prune --prod

# AL2023 has no tini package, so Debian's static build is copied into the runtime.
FROM docker.io/library/node:24-trixie-slim AS tini
RUN apt-get update && apt-get install -y --no-install-recommends tini

# The runtime is Amazon Linux 2023 minimal (glibc, so the native addons built above load), not Debian 13, which still
# had 438 open CVEs with no fix. Only node, git, ssh and the user tools are installed; no npm, corepack or yarn.
# Pinned by digest; `microdnf upgrade` picks up fixes published after it.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal@sha256:75a2d4226d9b98c914d7eed878a03bef4f365ad548be5d28d464ccba504cec79 AS runtime
RUN microdnf -y upgrade --refresh && microdnf -y install --setopt=install_weak_deps=0 nodejs24 git-core openssh-clients shadow-utils \
  && microdnf clean all \
  && groupadd -g 10001 app && useradd --create-home --uid 10001 --gid 10001 app \
  && mkdir -p /data && chown app:app /data
COPY --from=tini /usr/bin/tini-static /usr/bin/tini
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DAM_HOST=127.0.0.1 PORT=3000 DAM_DATA_DIR=/data DAM_POLICY_DIR=/app/policy
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --from=build --chown=app:app /app/policy ./policy
# The demo seed reads the sample dataset; the demo stack's policy overlay turns off scheduled syncs (see its comment).
COPY --from=build --chown=app:app /app/sample-data ./sample-data
COPY --from=build --chown=app:app /app/scripts/demo-seed/policy ./demo-policy
COPY --from=build --chown=app:app /app/THIRD_PARTY_LICENSES.json ./THIRD_PARTY_LICENSES.json
COPY --from=build --chown=app:app /app/LICENSE ./LICENSE
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app scripts/entrypoint.sh ./entrypoint.sh
LABEL org.opencontainers.image.title="DevOps Agent Manager" \
      org.opencontainers.image.description="Manages an AWS DevOps Agent Space from outside the console: a git history of its assets, reviewed plans, releases, journal analysis and audits. Not an official AWS project." \
      org.opencontainers.image.licenses="MIT"
# org.opencontainers.image.source, .revision and .version are set when the image is published.
USER app
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["web"]
