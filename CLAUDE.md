# CLAUDE.md — context for AI sessions

Reading order for a new session: this file, then the code. User-facing
instructions (installing, deploying, env variables) live in [README.md](README.md)
— do not duplicate them, link to them.

## What this is

**Unlimited Brain** — a host for **several chat assistants**. Each assistant has its own system
prompt, its own markdown knowledge base, its own model and settings, and its own
list of users. The model runs through OpenRouter. Only email addresses on the
user list can sign in — ordinary users via a magic link, admins with their email
plus `ADMIN_PASSWORD`; after signing in a user picks from the
assistants they were granted. Conversations and remembered facts are stored per
user *and* per assistant, so nothing crosses between them.

Admins manage everything on `/admin`: users, and one page per assistant
(`/admin/assistants/:id`) for its identity, settings, rights matrix and
knowledge base.

`ASSISTANT_NAME` and `ASSISTANT_LANGUAGE` now only seed the *first* assistant on
a fresh install; each assistant carries its own name and language afterwards.

Status: working, deployed on Railway from the private GitHub repo
`weirdfishes-co/aiassistant`. There is no mobile app — this is deliberately
web-only (see Decisions).

## Stack

Node 22 · TypeScript (ESM) · Express 5 · PostgreSQL (`pg`) · pino ·
`openai` (pointed at OpenRouter) · vanilla JS and hand-written CSS on the front end.
Hosted on Railway via a multi-stage Dockerfile, with Postgres as a separate service.

## Directories

```
src/
  server.ts          entrypoint: listen, cleanup timer, graceful shutdown
  app.ts             Express app: middleware, routers, error handling
  config.ts          read + validate env (fail fast at boot)
  auth.ts            magic-link tokens, cookie sessions, requireUser/requireAdmin
  llm.ts             OpenRouter client (OpenAI wire format), streams the answer
  models.ts          fetches + caches the OpenRouter model catalogue
  settings.ts        admin-controlled runtime settings, per assistant
  assistants.ts      slugs, per-assistant paths, first-run migration
  balance.ts         OpenRouter credit + key-limit status for /admin
  memory.ts          cross-conversation memory: extraction + prompt section
  compaction.ts      summarizes old turns once a conversation gets long
  content.ts         read/write the knowledge base + path validation + seeding
  context.ts         builds the system prompt from instr.md + context/*.md
  mail.ts            magic-link delivery over Brevo's HTTP API, or the log
  logger.ts          pino instance shared by every module
  rate-limit.ts      in-memory limiter for the login form
  views.ts           server-side HTML (everything through escapeHtml)
  routes/            auth.ts, chat.ts, admin.ts, content.ts
  db/
    index.ts         connection + migrations (in-process at boot)
    repo.ts          all SQL, parameterized
    migrations/      forward-only .sql files
public/              styles.css, app.js, upload.js (frontend, no build step)
scripts/build.mjs    esbuild bundle to dist/ + copy migrations
scripts/entrypoint.sh  takes ownership of /data, then drops to the node user
tests/               vitest: auth, content, context, settings, features
                     (memory + compaction), views, mail, assistants
                     (slugs, rights matrix, isolation)
instr.md             system prompt — the user owns its content
instr.example.md     neutral starting prompt, safe to copy over instr.md
context/*.md         knowledge base seeded into a brand-new assistant
<ASSISTANTS_DIR>/<slug>/   per-assistant instr.md + context/ (on the volume)
```

## Decisions (and why)

- **PostgreSQL, not SQLite.** The app grew into a multi-user, multi-assistant
  host, which is past the point where a single file on one volume is the right
  answer. All SQL still lives in `db/repo.ts`. The volume is still needed, but
  now only for the per-assistant knowledge bases — the database is a separate
  Railway service reached through `DATABASE_URL`.
- **The whole data layer is async, because the driver is.** `better-sqlite3` was
  synchronous; `pg` is not. Every repo method returns a promise, and so do
  `loadSettings`, `memorySection` and `auth.currentUser`. `requireUser` and
  `requireAdmin` are async middleware — Express 5 forwards a rejected promise to
  the error handler, so they need no wrapper. `views.ts` imports only *types*
  from the repo, so the view layer stayed synchronous and untouched.
- **Read the whole settings row set in one query.** `loadSettings` used to call
  `getSetting` ten times, which was free on SQLite and would be ten round trips
  here. `repo.allSettings()` fetches them as a map; this runs on every message.
- **`touchUser` is deliberately not awaited.** "Last seen" feeds the admin table
  only, and awaiting it would add a round trip to every authenticated request.
  It is fired with `void` and its failure swallowed.
- **Statements that wrote a row return it.** Postgres `RETURNING` (and a CTE for
  `addMessage`, which also bumps `conversations.updated_at`) removed the
  insert-then-select pairs SQLite needed. `consumeLoginToken` is one statement
  for the same reason: a CTE updates the token and returns its user, so a link
  cannot be redeemed twice even under two simultaneous requests.
- **One baseline migration, not the old four.** The engine changed and no data
  was carried across, so replaying a chain of SQLite ALTERs to arrive at a shape
  we can state directly would have been pure ceremony. `001_baseline.sql` is
  that shape; everything after it is forward-only again, numbered from 002.
- **Dockerfile instead of Nixpacks**, for a deterministic build and a runtime
  image without the toolchain. Moving from `better-sqlite3` to `pg` removed the
  last native module, so the build no longer has to work around a compiler —
  the stage split is kept only because it keeps the runtime image small.
- **Bundle the server with esbuild, no `tsx` in production.** Transpiling at
  startup costs enough time to fail Railway's health check. `tsx` is a dev
  dependency only. `scripts/build.mjs` copies `src/db/migrations/` to
  `dist/migrations/`, because `db/index.ts` looks for them next to the bundle.
- **Migrations in-process at boot.** One cold start fewer than a separate
  migration command, so `/healthz` comes up sooner.
- **Magic link for users, a password for admins.** For ordinary users there is
  nothing to leak and nothing to reset: tokens are stored as a SHA-256 hash
  only, and the plaintext lives solely in the email (sign-in) or the cookie
  (session). Admins are the exception — they sign in with their address plus the
  shared `ADMIN_PASSWORD` from the environment and are never mailed a link, so
  the admin pages stay reachable when mail is down, unconfigured, or slow, which
  is exactly the state a fresh install is in. The password is compared as a
  SHA-256 digest through `timingSafeEqual` (`verifyAdminPassword` in `auth.ts`):
  comparing the raw strings would throw on a length mismatch and leak the
  length. `ADMIN_PASSWORD` is **required** — an empty one locks the owner out of
  `/admin` entirely — and must be 12 characters or more in production.
- **One message for every failed password, but an empty password is honest.**
  `POST /login` answers wrong-password, non-admin and unknown-address alike, so
  a password cannot be used to probe the user list. Leaving the password empty
  as an admin *does* answer "Administrators sign in with the password", which
  reveals that one address is an admin. That is deliberate: the alternative is
  an admin waiting forever for an email that is never sent. The rate limiter
  (5 per 15 minutes per address *and* per IP) covers the brute force.
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
- **Mail over Brevo's HTTP API, and nothing else.** Railway could open no TCP
  connection to Brevo's SMTP port — `Connection timeout` at the `CONN` stage on
  587, 2525 and 465 alike, before any credential was exchanged, while the
  identical configuration worked from a laptop. Port 443 has no such problem.
  SMTP was kept for a while as a local-development fallback and then removed: a
  second transport that only works in one environment is a second way to fail,
  and `nodemailer` went with it. Without a key, outside production, the link is
  written to the log instead.
- **One directory per assistant** under `ASSISTANTS_DIR`
  (`<slug>/instr.md`, `<slug>/context/*.md`). The slug is derived from the name
  once, at creation, and never changes — it is both the URL (`/<slug>`) and the
  directory name, so renaming an assistant must not move its files.
- **An assistant lives at the root, `/<slug>`**, which makes its slug compete
  with every fixed path. `RESERVED_SLUGS` in `assistants.ts` therefore refuses
  `admin`, `api`, `login` and the rest: Express matches the fixed routes first,
  so a clash would not break the app — it would silently make that assistant
  unreachable, which is harder to notice. Adding a top-level route means adding
  its path to that set. Static files cannot clash; they all contain a dot, which
  the slug pattern rejects. `/a/<slug>` still answers, with a 301 to the new
  shape, so older links keep working.
  `assistantPaths()` validates the slug *and* checks the resolved path against
  the root, the same defence `content.ts` applies to document names.
- **Admins may use every assistant; everyone else needs a grant.** The
  `assistant_users` table is the rights matrix and holds no rows for admins —
  `canUseAssistant()` short-circuits on `isAdmin`. An assistant a user may not
  use answers **404, not 403**, so the list of assistant names does not leak.
- **Upgrading from the single-assistant era happens once, at boot.**
  `bootstrapAssistants()` creates an assistant from `ASSISTANT_NAME`, copies the
  old global `settings` rows onto it, attaches every conversation and memory
  that still has `assistant_id IS NULL`, grants it to all existing users and
  seeds its knowledge base from the old location. Migration `004` deliberately
  leaves those columns nullable so the SQL stays pure and nothing is lost.
- **Knowledge base on the volume, not in the image.** `/admin/content` lets an
  admin edit `instr.md` and the context documents. That only works durably when
  the files live outside the image, so the image sets `CONTEXT_DIR=/data/context`
  and `INSTRUCTIONS_PATH=/data/instr.md`. If the target location is empty,
  `seedContent()` copies the bundled files there once; existing content is never
  overwritten.
- **Uploads as JSON, not multipart.** The browser reads the `.md` file with
  `file.text()` and POSTs it as JSON — saves a multer dependency for what is
  always text.
- **The picker's background is generated once, not per request.**
  `buildBackgroundPaths()` in `views.ts` builds the circuit-board artwork at
  module load and the picker reuses the string; it adds about 2 kB to that one
  page. It is decoration: `aria-hidden`, `pointer-events: none`, and reduced to
  a still, fully drawn board under `prefers-reduced-motion`. Animation is CSS
  only — `pathLength="1"` normalises every trace so one keyframe set draws them
  all — so no animation library is needed. Theme switching is done by
  overriding `stroke`/`fill`/`filter` with the dark gradient and glow in a
  `prefers-color-scheme` block, because `url(#id)` references cannot be themed
  from the attribute alone.
- **A background must not flicker.** The first attempt faded every line to zero
  opacity on each cycle, which read as noise rather than motion. Keyframes here
  keep a floor (0.25 and up) and end fully lit.
- **Static assets carry a per-boot version** (`ASSET_VERSION` in `views.ts`,
  appended as `?v=` to the script and stylesheet URLs). `express.static` caches
  them for an hour in production, so the deploy that moved the API to
  `/api/a/:slug/...` left browsers running the previous `app.js` against the new
  routes; it requested `/api/conversations`, hit the catch-all and reported
  "Loading failed: Not found". Any change to the frontend/API contract has the
  same failure mode, so leave the version in place.
- **Views are built by a factory** (`createViews`), not free functions, so
  `ASSISTANT_NAME` reaches every page without a module-level global. Routers
  take `views` as a dependency, matching the `createX(deps)` idiom used
  everywhere else.
- **No Capacitor/Android.** Deliberately skipped: cookie sessions and magic
  links work poorly in a WebView. If it is ever wanted, the route is token auth
  alongside cookies + a static build of the frontend.

## Pitfalls

- **A failed answer must name its cause.** `describeChatError()` in `llm.ts`
  maps the provider's status onto something a reader can act on — 402 credit,
  401/403 key, 404 model, 429 rate limit — because the fix differs per case and
  a single "something went wrong" sends everyone to the server log. The
  provider's own message is deliberately not echoed to the browser. A real
  example: paid models failed on Railway while a `:free` model worked, which is
  the signature of a key with no credit; the generic message hid that for two
  rounds of guessing.
- **`ADMIN_PASSWORD` is shared by every address in `ADMIN_EMAILS`.** The session
  still records *which* admin signed in, so the admin table stays meaningful,
  but the secret does not distinguish them: rotate it when someone stops being
  an admin. Per-admin passwords would need a column, hashing and a reset flow —
  a deliberate non-goal for an app this size.
- **Sessions are a fixed 30-day window, not a sliding one.** `expires_at` is
  written once in `createSession` and never extended, so an active user is still
  signed out on day 30. It is enforced twice: the cookie's own `expires`, and
  `expires_at > datetime('now')` in the session lookup, so a copied cookie dies
  with the row. Making it sliding means updating the row *and* re-issuing the
  cookie in `findUserBySessionToken`.

- `instr.md` in the repo belongs to the user and is only a **seed**: it is
  copied into each newly created assistant, after which that assistant's own
  copy under `ASSISTANTS_DIR` is what runs. Editing the repo file changes
  nothing for an assistant that already exists. **Never overwrite it** — suggest
  at most; `instr.example.md` exists for that purpose.
- `{Global.X}` placeholders are resolved per assistant: `context.ts` replaces
  them with that assistant's `context/X.md`. While a file is missing the
  placeholder stays literal in the prompt and a warning appears in the log.
- Two different kinds of memory, both database-backed and neither using tools.
  *Within* a conversation, `routes/chat.ts` replays the last `HISTORY_LIMIT`
  (40) messages. *Across* conversations, `memory.ts` extracts durable facts into
  the `memories` table — off unless an admin enables it, and scoped to one
  assistant.
- **The prompt cache in `context.ts` is a Map keyed by instructions path**, not
  a single entry. With one entry several assistants would evict each other on
  every request and the OpenRouter prompt cache would never hit.
- Every conversation and memory query carries **both** `user_id` and
  `assistant_id`. Dropping either one crosses a boundary: users, or assistants.
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
- **`MAIL_FROM` is not an SMTP setting** and survived the removal: it is parsed
  into Brevo's `sender` object, and the address must be one Brevo has verified.
  Left unset it becomes `noreply@localhost`, which Brevo rejects.
- **The Brevo call has a 15-second timeout.** `fetch` has none by default, and a
  hanging send leaves `POST /login` with no response — the user sees an endless
  spinner rather than an error. This is the same failure SMTP used to produce
  when its port was blocked.
- **Never set `ASSISTANTS_DIR` to a relative path in a deployed environment.**
  The image points it at `/data`; a value copied from `.env` such as
  `./data/assistants` resolves inside `/app`, which the `node` user cannot
  write. `DATABASE_PATH`, `CONTEXT_DIR` and `INSTRUCTIONS_PATH` no longer exist
  — delete them wherever they are still set.
- **Tests run against a real PostgreSQL in Docker.** `tests/global-setup.ts`
  starts one container for the whole run and each case gets its own schema
  (`tests/helpers/db.ts`), which costs milliseconds where a container each would
  cost seconds. Docker must therefore be available to run the suite. An
  in-memory emulation was rejected: it would pass SQL that production rejects,
  which is the one thing this move needed protection against.
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
- **Deleting a conversation does not erase what was remembered from it.**
  `memories` rows live independently of `conversations`, so a user who deletes a
  thread keeps its extracted facts in every later prompt. There is also no page
  to view or delete memories — `clearMemories()` exists in the repo and nothing
  calls it. Both are known gaps, not oversights to "fix" silently: a memories
  panel per user is the intended shape.
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
