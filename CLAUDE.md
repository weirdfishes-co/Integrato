# CLAUDE.md — context for AI sessions

Reading order for a new session: this file, then the code. User-facing
instructions (installing, deploying, env variables) live in [README.md](README.md)
— do not duplicate them, link to them.

## What this is

A chatbot that answers on the basis of a fixed system prompt (`instr.md`) plus
markdown files as knowledge base (`context/`). The model runs through
OpenRouter and is chosen by an admin on `/admin`. Only email addresses on the user
list can sign in, via a magic link. Conversations are stored per user in SQLite
and are available again after signing in. Admins manage the user list on
`/admin` and the knowledge base on `/admin/content`.

The app is generic: the product name (`ASSISTANT_NAME`) and the answer language
(`ASSISTANT_LANGUAGE`) are configuration, not hard-coded strings.

Status: working and complete. There is no mobile app — this is deliberately
web-only (see Decisions).

## Stack

Node 22 · TypeScript (ESM) · Express 5 · better-sqlite3 · nodemailer · pino ·
`openai` (pointed at OpenRouter) · vanilla JS and hand-written CSS on the front end.
Hosted on Railway via a multi-stage Dockerfile.

## Directories

```
src/
  server.ts          entrypoint: listen, cleanup timer, graceful shutdown
  app.ts             Express app: middleware, routers, error handling
  config.ts          read + validate env (fail fast at boot)
  auth.ts            magic-link tokens, cookie sessions, requireUser/requireAdmin
  llm.ts             OpenRouter client (OpenAI wire format), streams the answer
  models.ts          fetches + caches the OpenRouter model catalogue
  settings.ts        admin-controlled runtime settings (typed, DB-backed)
  balance.ts         OpenRouter credit + key-limit status for /admin
  memory.ts          cross-conversation memory: extraction + prompt section
  compaction.ts      summarizes old turns once a conversation gets long
  content.ts         read/write the knowledge base + path validation + seeding
  context.ts         builds the system prompt from instr.md + context/*.md
  mail.ts            SMTP delivery of the magic link
  rate-limit.ts      in-memory limiter for the login form
  views.ts           server-side HTML (everything through escapeHtml)
  routes/            auth.ts, chat.ts, admin.ts, content.ts
  db/
    index.ts         connection + migrations (in-process at boot)
    repo.ts          all SQL, parameterized
    migrations/      forward-only .sql files
public/              styles.css, app.js, upload.js (frontend, no build step)
scripts/build.mjs    esbuild bundle to dist/ + copy migrations
tests/               vitest: context.test.ts, auth.test.ts, content.test.ts,
                     settings.test.ts
instr.md             system prompt — the user owns its content
instr.example.md     neutral starting prompt, safe to copy over instr.md
context/*.md         knowledge base
```

## Decisions (and why)

- **SQLite, not Postgres.** Small single-service app with few concurrent
  writers. All SQL lives in `db/repo.ts`, so a move to Postgres stays a local
  change. WAL is on. This does require a Railway volume on `/data` — without a
  volume the data is gone on every deploy.
- **Dockerfile instead of Nixpacks.** `better-sqlite3` is a native module and
  Nixpacks regularly trips over it. The build stage runs on `node:22` (full
  toolchain), the runtime on `node:22-bookworm-slim` with `--omit=dev`.
- **Bundle the server with esbuild, no `tsx` in production.** Transpiling at
  startup costs enough time to fail Railway's health check. `tsx` is a dev
  dependency only. `scripts/build.mjs` copies `src/db/migrations/` to
  `dist/migrations/`, because `db/index.ts` looks for them next to the bundle.
- **Migrations in-process at boot.** One cold start fewer than a separate
  migration command, so `/healthz` comes up sooner.
- **Magic link, no passwords.** Nothing to leak, nothing to reset. Tokens are
  stored as a SHA-256 hash only; the plaintext lives solely in the email
  (sign-in) or the cookie (session).
- **Server-rendered HTML + vanilla JS.** Four screens; a frontend framework
  would cost more build time and dependencies than it returns.
- **SSE over a POST request** for streaming answers. `EventSource` can only do
  GET, so `public/app.js` reads the body stream itself.
- **OpenRouter instead of the Anthropic SDK.** One key and one wire format for
  every model, so the admin can switch provider without a code change. The cost
  is Anthropic-specific features: the Messages API's server tools (web search),
  the memory tool, document citations and `stop_reason: 'refusal'` are not
  available. A refusal now arrives as `finish_reason: 'content_filter'`.
- **Prompt caching**: `cache_control: ephemeral` is sent as a top-level request
  field; OpenRouter forwards it to providers that cache (Anthropic) and the rest
  ignore it. That is why context files are always read in alphabetical order — a
  shifting order would invalidate the cache on every request. Cache hits show up
  in `usage.prompt_tokens_details.cached_tokens`.
- **Admin settings live in the database, not in the environment.** The env vars
  are only the fallback for a fresh install; the `settings` table wins once an
  admin saves on `/admin`, so nothing needs a redeploy. Read them through
  `loadSettings(repo, config)` — never `config` directly in a request path.
- **Three features are ours, not OpenRouter's.** Memory, citations and compaction
  have no provider support here, so they are built in the app and work on any
  model. Memory and compaction each cost one extra `chat.complete()` call and run
  *after* the answer has been streamed, so they can never delay or break a reply
  — both swallow their errors by design. Citations are prompt-enforced
  (`CITATION_RULE` in `context.ts`), so a model can forget or invent one; that is
  a known weakness against Anthropic's native citations, not a bug.
- **Memory goes after the knowledge base in the system prompt**, never before.
  The knowledge base is the cached prefix shared by every user; putting a
  per-user block in front of it would invalidate the cache for everyone on every
  request.
- **Knowledge base on the volume, not in the image.** `/admin/content` lets an
  admin edit `instr.md` and the context documents. That only works durably when
  the files live outside the image, so the image sets `CONTEXT_DIR=/data/context`
  and `INSTRUCTIONS_PATH=/data/instr.md`. If the target location is empty,
  `seedContent()` copies the bundled files there once; existing content is never
  overwritten.
- **Uploads as JSON, not multipart.** The browser reads the `.md` file with
  `file.text()` and POSTs it as JSON — saves a multer dependency for what is
  always text.
- **Views are built by a factory** (`createViews`), not free functions, so
  `ASSISTANT_NAME` reaches every page without a module-level global. Routers
  take `views` as a dependency, matching the `createX(deps)` idiom used
  everywhere else.
- **No Capacitor/Android.** Deliberately skipped: cookie sessions and magic
  links work poorly in a WebView. If it is ever wanted, the route is token auth
  alongside cookies + a static build of the frontend.

## Pitfalls

- `instr.md` belongs to the user (currently: a Dutch "Coach Suzy" prompt for
  Talent&Pro, written before the app was made generic). **Never overwrite it** —
  suggest at most. `instr.example.md` exists for that purpose.
- That prompt is written for another platform and refers to tools
  (`CoachSuzy_OphalenGeheugen`, `CoachSuzy_OpslaanGeheugen`) this app does not
  have. It is also in Dutch, while `ASSISTANT_LANGUAGE` now defaults to English —
  the two will fight until the prompt is replaced or the variable is set to
  `Dutch`. The `{Global.X}` placeholders *are* resolved: `context.ts` replaces
  them with `context/X.md`. As long as those files are missing they stay literal
  in the prompt and a warning appears in the log.
- Conversation memory runs through the database, not through tools:
  `routes/chat.ts` sends the last `HISTORY_LIMIT` (40) messages along.
- Authorization on conversations lives in the SQL (`WHERE ... AND user_id = ?`),
  not in a separate check. Keep it that way for new queries.
- File names on the knowledge base page come from a user. `safePath()` in
  `content.ts` validates the name **and** checks the resolved path against the
  base directory; never hand a name straight to `fs`. `tests/content.test.ts`
  covers ten traversal variants — extend it when you change things.
- `app.set('trust proxy', 1)` is needed for `req.ip` and secure cookies behind
  the Railway proxy.
- New user-facing text in English, in line with the rest of the app. Never
  hard-code the assistant's name — read it from config.
- `MODEL_MAX_TOKENS` is validated by OpenRouter against your *remaining credit*,
  not just against the model: a value your balance cannot cover fails the whole
  request with a 402 before the model runs.
- **SMTP has explicit timeouts** (`mail.ts`). Nodemailer waits on the OS
  otherwise, so a blocked outbound port leaves `POST /login` hanging for minutes
  with no response — the user sees an endless spinner rather than an error. The
  timeouts turn that into a 502 with a readable message in ten seconds.
- **The container starts as root on purpose.** Railway bind-mounts the volume
  over `/data` at runtime and it arrives owned by root, which hides the
  build-time `chown`. `scripts/entrypoint.sh` therefore fixes ownership and then
  drops to `node` with `setpriv` — do not add a `USER node` instruction back, and
  do not assume the build-time chown covers the volume. Symptom if this breaks:
  `SqliteError: unable to open database file` (`SQLITE_CANTOPEN`) on boot.
- **`context/.gitkeep` must stay.** The Dockerfile does `COPY context ./context`,
  and git does not track empty directories — delete the last file in `context/`
  and the *image build* fails with `"/context": not found`, even though the app
  runs fine without any context documents. The knowledge base on a deployed
  instance lives on the volume (`/data/context`), so deleting documents through
  `/admin/content` is safe; deleting them from the repo is not.
- The model catalogue is a live network call (`models.ts`, cached one hour). The
  admin page must keep working when it fails — it degrades to a text field.
- **Two different OpenRouter limits, easily confused** (`balance.ts` reports
  both): `/v1/credits` is the account balance a 402 actually measures, while
  `/v1/key`'s `limit_remaining` is only a spending cap on the key. A key showing
  $11.86 of $12 left while `total_credits` is 0 is exactly the state that makes
  every request fail — do not read the key limit alone.
- OpenRouter has a second 402 besides "not enough credit": an *in-flight budget*
  that a burst of concurrent requests exhausts. It carries `Retry-After` and
  clears on its own — do not mistake it for a broken key.
- Web search accepts `include_domains` **or** `exclude_domains`, not both, on
  some engines (Anthropic's native search among them). `webPlugin()` in `llm.ts`
  therefore sends the include list alone when an admin fills in both.
- Memory rows are per user and read with `user_id` in the SQL, like conversations.
  Keep it that way — a leak here crosses users.
- **Never parse a background completion as free text.** Some models (several free
  ones especially) write their chain of thought into `message.content`. Memory
  extraction stored that reasoning as "facts" until `parseFacts` was changed to
  read only what is inside `<facts>` tags, with no fallback — a missing block
  means no facts. `parseSummary` does the same with `<summary>`, but may fall
  back, since a stray sentence there pollutes one conversation rather than a
  permanent store. `complete()` also sends `reasoning: {enabled: false}`.
- Free models (`:free`) need no credit balance and accept a large `max_tokens`,
  but a *negative* balance blocks them too, and web search still bills (~$0.007 a
  search) whatever the model costs.

## Checks before committing

```bash
npm run typecheck && npm test && npm run build
```
