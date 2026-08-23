# Multi-stage build: more deterministic than Nixpacks and safe for native modules.
#
# better-sqlite3 falls back to compiling from source when there is no prebuilt
# binary for this Node version. That is why the production dependencies are
# installed in the build stage too (which has a full toolchain) and copied as a
# whole into the slim runtime. `npm ci` in the slim image would fail on a
# missing Python/compiler.

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
ENV DATABASE_PATH=/data/app.db \
    CONTEXT_DIR=/data/context \
    INSTRUCTIONS_PATH=/data/instr.md
RUN mkdir -p /data && chown -R node:node /data /app/context /app/instr.md

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
