# Multi-stage build: more deterministic than Nixpacks, and it keeps the build
# toolchain out of the runtime image.
#
# Every dependency is now pure JavaScript — moving from better-sqlite3 to pg
# removed the one native module — so this no longer has to work around a
# compiler. The split is kept because the runtime image stays smaller for it.

FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Strip dev dependencies; the compiled native binaries stay in place.
FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY instr.md ./instr.md
COPY context ./context

# Default location of the database and the knowledge base; attach a volume here
# on Railway. The knowledge base is editable through the admin page, so it has
# to live on the volume — otherwise every change is gone on the next deploy.
# The database is a separate Postgres service (DATABASE_URL); the volume now
# holds only the per-assistant knowledge bases.
ENV ASSISTANTS_DIR=/data/assistants
RUN mkdir -p /data && chown -R node:node /data /app/context /app/instr.md

# The volume is mounted over /data at runtime and arrives owned by root, so the
# chown above no longer applies to it. entrypoint.sh fixes that as root and then
# drops to `node` — which is why there is no USER instruction here.
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]
