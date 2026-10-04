# CLAUDE.md — context for AI sessions

Reading order for a new session: this file, then the code. User-facing
instructions (installing, deploying, env variables) live in [README.md](README.md)
— do not duplicate them, link to them.

## What this is

**Integrato** — a host for **several chat assistants**. Each assistant has its own system
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

Status: working. MIT-licensed, at `weirdfishes-co/Integrato`. Deployed with
Docker; a `railway.json` is included because that is where it runs, but nothing
in the app is tied to one host. There is no mobile app — this is deliberately
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
  anonymize.ts       masks personal data in user text, in-process
  notes.ts           the user's own documents: validation + prompt section
  memory.ts          cross-conversation memory: extraction + prompt section
  compaction.ts      summarizes old turns once a conversation gets long
  content.ts         read/write the knowledge base + path validation + seeding
  context.ts         builds the system prompt from instr.md + context/*.md
  mail.ts            magic-link delivery over Brevo's or Mailjet's HTTP API, or the log
  crypto.ts          AES-256-GCM + HMAC blind index for stored email addresses
  logger.ts          pino instance shared by every module
  rate-limit.ts      in-memory limiter for the login form
  views.ts           server-side HTML (everything through escapeHtml)
  routes/            auth.ts, chat.ts, admin.ts, content.ts, notes.ts
    access.ts        resolves :slug against the rights matrix, shared
  db/
    index.ts         connection + migrations (in-process at boot)
    repo.ts          all SQL, parameterized
    migrations/      forward-only .sql files
public/              styles.css, app.js, upload.js (frontend, no build step)
  markdown.js        renders an answer's Markdown; escapes first, always
  format.js          tokens and cost as text; its own module so it is testable
  editor.js          the document editor's live preview, via markdown.js
public/fonts/        Montserrat + Lato, self-hosted — no CDN font request
STYLE.md             styleguide of record; public/styles.css implements it
scripts/build.mjs    esbuild bundle to dist/ + copy migrations
scripts/entrypoint.sh  takes ownership of /data, then drops to the node user
tests/               vitest: auth, content, context, settings, features
                     (memory + compaction), views, mail, assistants
                     (slugs, rights matrix, isolation), privacy
                     (anonymization + EU routing), markdown, usage, notes
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
- **A promise is kept where the request is built, not by the callers.** EU-only
  routing and anonymization are applied inside `llm.ts`, in `stream()` and
  `complete()` alike, rather than by the routes that call them. A caller that
  forgot either one would not fail loudly — it would send the data anyway. That
  is also why `complete()` takes the whole `AssistantSettings` instead of a
  model id: memory extraction and compaction carry the user's own words, so
  they have to be anonymized and routed exactly like the conversation they came
  from. The knobs that are only preferences — sampling — are not applied there.
- **EU-only routing is a routing rule, not a filter on a dropdown.**
  `provider.only` carries the model's European endpoint tags with
  `allow_fallbacks: false`, so OpenRouter refuses rather than reroutes when they
  are busy. The tags come from `/models/:id/endpoints`; a tag is European when
  its shard matches `^(eu|europe)(-|$)` — `azure/eu`, `amazon-bedrock/eu-west-1`,
  `google-vertex/europe`. `global` does **not** count: it includes Europe
  without being limited to it. `/providers` adds the handful whose every listed
  data centre is in the EEA and which therefore carry no regional shard; losing
  that call degrades to the shards alone rather than failing. Unknown is treated
  as none — the request stops. OpenRouter answers an impossible `provider.only`
  with a **404**, which is why `describeChatError` names the region there.
  The picker uses OpenRouter's own `?region=eu` catalogue (~70 models of ~460),
  and the admin route refuses to *save* a combination that has no EU endpoint,
  so the failure lands on the admin who caused it and not on every user.
- **Anonymization runs in this process, and catches no names.** `anonymize.ts`
  is patterns plus checksums — mod-97 for an IBAN, Luhn for a card, the 11-proef
  for a BSN — so it needs no service, no model, no network call and no error
  path. It cannot recognize a name, and the admin page says so.
  **That gap is the design, not a todo.** It was weighed against the two
  alternatives and both were rejected: Presidio (built first, then removed)
  needs a Python service whose stock image is English-only, and `compromise`
  works off a name lexicon — measured here, it found "Ann Smith", "Jeroen van
  der Berg" and "De Vries" but missed "Priya Raghunathan", which is the failure
  mode that disqualifies it. A privacy control that fails invisibly, and fails
  hardest on non-Western names, is worse than one with a stated limit.
  `transformers.js` would work but brings back a native module (`onnxruntime`),
  ~400 MB of RAM and a model to cache on the volume.
  One value keeps one placeholder across the batch, so a conversation is
  anonymized in one call and the model can follow the thread. Only user turns
  are rewritten; the system prompt is the admin's own text and is the cached
  prefix of every request.
- **The recognizers are a net, not a classifier.** Overlaps are settled by
  priority (email > IBAN > card > BSN > phone > IP > postcode), because an
  IBAN's digits are also card-shaped and phone-shaped and carving one account
  number into three placeholders would be worse than any of them. A *rejected*
  IBAN is not thereby innocent either — its digits can still be a phone number,
  and are then masked as one. Where the shape is ambiguous, err towards masking:
  a 9-digit number passes the 11-proef one time in eleven, so an order number
  is occasionally masked, and that is the right direction for this setting.
  Any new recognizer needs its false positives in `tests/privacy.test.ts` —
  the years, prices, KvK numbers, ISBNs and room numbers already there are what
  keeps this usable in ordinary prose.
- **An empty sampling field is not zero.** `temperature` and `topP` are
  `number | null`, and null means "send nothing". A number we picked would be
  worse than the default the provider tuned, and several reasoning models reject
  a temperature outright. The settings table has no nulls, so unset is stored as
  the empty string — which is what keeps it distinguishable from 0, a
  temperature an admin may well want.
- **Answers are Markdown, and the escaping comes first.** `public/markdown.js`
  escapes the text and then applies the Markdown rules *to the escaped result*,
  so nothing a model writes can become a tag — by the time the rules run, a `<`
  is already `&lt;`. **Do not reorder that**: it is the entire defence, and it is
  why a `.innerHTML` write here needs no sanitizer. Links are the one place an
  attribute is built, so the scheme is checked (http, https, mailto only) and the
  URL is escaped like everything else. It re-runs on the whole answer for each
  streamed chunk, because a chunk can arrive inside `**bold**` and only the full
  text says whether a marker has closed. Only assistant messages are rendered:
  a user's own text is shown as typed, and an error is our sentence, not the
  model's.
- **The setup strip under the chat is for users, not admins.** Which model
  answers, whether a message is anonymized and whether it may leave the EU are
  things the person typing has a claim to know, and a setting nobody can see is
  one nobody can be held to. It is a native `<details>`, so the accordion needs
  no script. Nothing in it is a secret — no key, no system prompt, no user list —
  and anything added to it must stay that way.
- **The cost of an answer is the provider's number, not ours.** OpenRouter puts
  `usage.cost` in the last chunk of the stream, already accounting for cache
  discounts and the endpoint actually used; deriving it from a rate card would
  drift the moment either changed. It takes **two** request flags that are easy
  to confuse: `stream_options: {include_usage: true}` is the OpenAI-standard way
  to get a usage chunk at all, and `usage: {include: true}` is OpenRouter's way
  to put `cost` inside it. The usage chunk carries **no choices**, so it must be
  read before the loop gives up on an empty delta.
  Usage is stored on the assistant message and is **null, never zero**, when
  nothing was reported: zero claims an answer was free, which is a different
  statement from "not recorded". `cost` is `NUMERIC` and the driver returns it as
  a **string** — `toUsage` converts it, and without that every sum would
  concatenate. What is *not* counted: memory extraction and compaction are
  separate calls, so an exchange's true cost is higher than the line under it
  says. That is documented in the README rather than papered over.
- **"Notes" in the code, "documents" on the screen.** The same split as chatbot
  and assistant, and for the same reason: `content.ts` already owns the word
  document for the *admin's* knowledge base, which lives on the volume and is
  shared by everyone who may use a chatbot. A user's own documents are a
  different thing with a different owner — one user, one chatbot — so they are
  `notes` in the table, the repo and `notes.ts`, and "My documents" in the
  interface. Keep new user-facing text on documents and the identifiers on notes.
- **A user's documents live in the database, not on the volume.** The
  per-assistant directories under `ASSISTANTS_DIR` are shared by every user of
  that chatbot, which is the wrong boundary: these reach nobody but their
  author. Every statement in the repo carries `user_id` **and** `assistant_id`,
  like conversations and memories, and `updateNote` returns null rather than
  throwing when the row is not the caller's — the route reads that as a 404.
- **The documents go after the cached knowledge base**, exactly like memory, and
  for the same reason: a per-user block in front of the shared prefix would
  invalidate the prompt cache for everyone on every request. `routes/chat.ts`
  builds both in one `Promise.all` and joins what is not null.
- **A document is the user's material, not an instruction.** `notesSection` says
  so in the prompt, because a model otherwise follows a document that happens to
  read like an order. It is prompt-enforced, so it is a strong default and not a
  guarantee — the same class of thing as `CITATION_RULE`.
- **A full prompt drops the oldest document, not the request.**
  `MAX_NOTES_PROMPT_CHARS` is a budget filled newest-first, and the names of
  what was left out go into the prompt so the chatbot can say a document is not
  loaded. Letting the prompt grow instead would fail a request months after the
  document that caused it was written, which is close to undiagnosable.
- **A chatbot without the setting answers 404, not 403**, on the document
  addresses — `resolveWritable` in `routes/notes.ts`. Whether a feature is
  switched on is not worth telling an unauthorized caller, and it keeps those
  paths indistinguishable from a chatbot that does not exist, which is already
  the rule for the chatbot itself.
- **`createAssistantResolver` is shared, deliberately.** The 404-not-403 rule
  for `:slug` is encoded once in `routes/access.ts` and used by both the chat
  and the document routes. It was duplicated for about an hour and that is
  exactly the kind of check that drifts when it exists twice — a new router
  under `/<slug>` should use it rather than writing its own.
- **Email addresses are encrypted at rest, and looked up by a blind index.**
  `users.email_enc` holds AES-256-GCM (`crypto.ts`, random IV, so every
  ciphertext differs); `users.email_hash` is an HMAC of the normalized address
  under a *second* key derived from the same secret, which is what lookups and
  the UNIQUE constraint use. Encryption alone could not do either. Consequences:
  the user list is sorted in JS after decrypting, nothing can `LIKE`-search an
  address in SQL, and `EMAIL_ENCRYPTION_KEY` is required — **lose or change it
  and every address is gone** (the hash would no longer match either). The
  plaintext `email` column is a leftover: `protectEmails()` converts pre-006 rows
  at boot and nulls it. It does not hide who is a user from someone with both the
  database *and* the key, and addresses are still written to the log by `routes/auth.ts` (failed
  admin attempts, unknown addresses, mail failures) and, in development, by
  the mailer — encrypting the table does not cover the logs.
- **The confirmation on a delete is `data-confirm`, never `onsubmit`.** An
  inline handler is a *JavaScript* context inside an HTML attribute, and
  `escapeHtml` is the wrong escaping for it: the parser turns `&#39;` back into
  a real quote before the handler compiles, so a name with an apostrophe broke
  out of the string and executed. That was proven, not theorised — a document
  name was enough, and a chatbot name reached other admins the same way.
  `public/confirm.js` reads the text through `dataset`, where HTML escaping is
  exactly right. `tests/views.test.ts` fails if any page renders an inline
  handler again, which is also what keeps the CSP free of `unsafe-inline`.
- **Three HTTP defences live in `security.ts`, not in a route.** A strict CSP
  (`'self'` throughout, no `unsafe-inline`, `frame-ancestors 'none'`) is
  possible only because the app fetches nothing external — self-hosted fonts, no
  CDN, no inline script or `style=`. An **origin guard** refuses a POST or
  DELETE whose `Origin` matches neither `APP_URL` nor the request's own `Host`;
  it exists because `sameSite=lax` treats every subdomain of one registrable
  domain as the same site, so a sibling host could otherwise post with an
  admin's cookie. It accepts the request's own Host as well, because `APP_URL`
  is routinely wrong in development and rejecting every form then would protect
  nothing. A request with neither `Origin` nor `Referer` is allowed: browsers
  always send one on a POST, so that is a non-browser client with no ambient
  cookie.
- **`trust proxy` is configuration, and defaults to off.** Believing
  `X-Forwarded-For` with nothing in front lets any caller choose their own
  `req.ip` and walk past the per-IP login limit. The opposite mistake — off
  while a proxy *is* in front — makes that limit count every visitor as one
  client, so `warnAboutProxy` logs once when it sees the header without
  `TRUST_PROXY`. Loud beats silent in both directions.
- **Messages are rate-limited per user, because they cost money.** 30 per five
  minutes, keyed on the user and not the IP: the spend follows the account, and
  a household behind one address should not share a budget. Documents are capped
  at `MAX_NOTES_PER_USER` per chatbot — the prompt budget already bounds what is
  *sent*, but nothing bounded what is *stored*. Both limiters are in memory, so
  they are per process and reset on restart; shared limits would need Postgres.
- **Memory goes after the knowledge base in the system prompt**, never before.
  The knowledge base is the cached prefix shared by every user; putting a
  per-user block in front of it would invalidate the cache for everyone on every
  request.
- **Mail over an HTTP API, and nothing else** — Brevo or Mailjet, chosen by
  which credentials are set. With both set the app refuses to boot unless
  `MAIL_PROVIDER` names one (`chooseMailProvider` in `config.ts`): a silent pick
  would leave the other key looking live in the environment. Railway could open no TCP
  connection to Brevo's SMTP port — `Connection timeout` at the `CONN` stage on
  587, 2525 and 465 alike, before any credential was exchanged, while the
  identical configuration worked from a laptop. Port 443 has no such problem.
  SMTP was kept for a while as a local-development fallback and then removed: a
  second transport that only works in one environment is a second way to fail,
  and `nodemailer` went with it. Without a key, outside production, the link is
  written to the log instead.
- **A chatbot's identity is a row; its behaviour is settings.** Name,
  description, answer language and the welcome message live on the `assistants`
  row and are edited together; the model and the feature toggles live in
  `assistant_settings`. That split is why the welcome message became migration
  `002` rather than another settings key.
- **One directory per assistant** under `ASSISTANTS_DIR`
  (`<slug>/instr.md`, `<slug>/context/*.md`). The slug is derived from the name
  at creation, and the *name* can change freely without touching it. An admin
  can edit the slug itself on the identity form; it is both the URL (`/<slug>`)
  and the directory name, so `renameAssistantSlug()` in `assistants.ts` moves the
  folder first and the row second, and moves the folder back if the row is
  refused. The old address goes into `assistant_slug_history` and
  `createAssistantResolver` 301-redirects GET pages from it (never `/api/`, which
  a reload fixes) — only to a user who may use that chatbot, so the redirect
  leaks nothing a 404 would hide. A live slug always beats a history row. A
  deleted chatbot's folder stays on the volume, so a rename onto an existing
  folder is refused rather than merging two knowledge bases.
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
- **Knowledge base on the volume, not in the image.** An admin edits `instr.md`
  and the context documents through the web page, which only works durably when
  the files live outside the image — hence `ASSISTANTS_DIR=/data/assistants`.
  A new chatbot is seeded from the bundled `instr.md` and `context/`;
  `seedContent()` never overwrites existing content.
- **Uploads as JSON, not multipart.** The browser reads the `.md` file with
  `file.text()` and POSTs it as JSON — saves a multer dependency for what is
  always text.
- **Static assets carry a per-boot version** (`ASSET_VERSION` in `views.ts`,
  appended as `?v=` to the script and stylesheet URLs). `express.static` caches
  them for an hour in production, so the deploy that moved the API under a slug
  left browsers running the previous `app.js` against the new routes; it
  requested `/api/conversations`, hit the catch-all and reported
  "Loading failed: Not found". Any change to the frontend/API contract has the
  same failure mode, so leave the version in place.
- **The styling follows STYLE.md, through a token layer.** `public/styles.css`
  names the five palette colours once and binds everything else to them
  semantically (`--bg`, `--text`, `--accent`, …), so a restyle touches the
  tokens and the type scale and nothing below them — the move from the Dev Ieffe
  blue-and-brown to Forest Green and Brown was 60 lines of tokens and no
  component at all. Colour comes from the palette; **type, shape and
  breakpoints are still the reverse-engineered g.ieffe.dev values**, which is
  why STYLE.md says so at the top.
  What the palette does not supply was decided here and is marked where it
  appears: the page ground and every tint (all five palette colours are dark —
  there is no light tone in it), hover states, a red and an amber for status,
  and the dark theme.
- **Brown is the button, green is the link.** The palette's two usable hues
  split between the two roles rather than sharing one, so a primary action and a
  link are distinguishable without reading either. Two places cannot follow the
  button colour, both for contrast: in dark mode the brown sits at **1.48:1**
  against the ink ground, so it lightens to `#a89b84` and takes *dark* text
  (white on a brown light enough to see is about 3:1). The label being the
  ground colour means one figure covers both the label on the fill and the fill
  on the page: 4.95:1, which has to clear 4.5 because a 14px bold button label
  is not "large text"; and the sidebar's new-conversation button sits
  on the sage, where the brown is **1.76:1**, so it takes a white fill with a
  forest glyph (9.65:1). **Check contrast before changing any of these** — most
  pairings here are chosen, not inherited, and this palette has no slack: its
  five colours span 5.18:1 to 13.53:1 on white and the widest gap between any
  two of them is 2.61:1, so no palette colour can sit on another.
- **A link is bold and coloured, not underlined** — except inside a sentence.
  `.link` (the rows of actions, the breadcrumbs, the names in a table) carries
  its affordance in weight and colour, because it stands alone with no prose to
  blend into. A bare `<a>` in running text keeps the browser's underline, since
  bold blue alone is not enough to pick it out of a paragraph. On the sidebar
  the same rule holds in white; there hover has no colour left to move to, so
  it is the one place that underlines.
- **The sidebar takes the sage** (`--sidebar-bg`, `#5f725d`), the lightest of
  the five, in both themes. White on it is **5.18:1**, which is what keeps the
  bold white links AA — **do not lighten it further**, that figure is the floor
  and the palette offers nothing between sage and white. Conversation rows have
  **no hover fill**: only the row you are in is marked, and a second highlight
  following the pointer made the list restless. The pointer still reveals that
  row's delete button, which is the affordance that mattered.
- **Controls size themselves, and so does a chat message.** STYLE.md puts body
  copy at 20px, which is right for prose and far too big for a form or a long
  answer. Buttons, fields, tables and `.message` set their own size rather than
  inheriting it; a table matches the links inside it.
- **The sign-in email repeats the brand colours as literals** (`BRAND` in
  `mail.ts`). No mail client fetches a stylesheet and many strip `<style>`
  blocks, so these cannot come from the token layer — which means a palette
  change has to be made in two places, and `tests/mail.test.ts` pins the hexes
  so the second one is not forgotten.
- **Fonts are self-hosted** from `public/fonts/` (Montserrat 700, Lato 400/700,
  65 kB). No CDN request, and it works offline. There is no logo: the product
  name is set as text, which is also why the sign-in email carries no image at
  all and so does not depend on a client allowing them.
- **"Chatbot" is the word users see; "assistant" is the word the code uses.**
  The table, the `assistant_id` columns, `AssistantSettings` and the routes all
  say assistant. Renaming those is churn no reader benefits from — keep new
  user-facing text on "chatbot" and leave the identifiers alone.
- **Views are built by a factory** (`createViews`), not free functions, so the
  product name reaches every page without a module-level global. Routers
  take `views` as a dependency, matching the `createX(deps)` idiom used
  everywhere else.
- **No Capacitor/Android.** Deliberately skipped: cookie sessions and magic
  links work poorly in a WebView. If it is ever wanted, the route is token auth
  alongside cookies + a static build of the frontend.

## Configuration reference

Environment (read once in `config.ts`, failing fast; the template is
`.env.example`, the table for operators is in [README.md](README.md)):

| Variable | Default | Rule |
| --- | --- | --- |
| `DATABASE_URL`, `OPENROUTER_API_KEY`, `ADMIN_EMAILS`, `ADMIN_PASSWORD`, `EMAIL_ENCRYPTION_KEY` | — | required; password ≥ 12 chars in production, key ≥ 32 chars always |
| `APP_URL` | — | public URL; `https://` sets the Secure cookie flag |
| `BREVO_API_KEY` / `MAILJET_API_KEY` + `MAILJET_SECRET_KEY` | — | one provider required in production; half a Mailjet pair is refused |
| `MAIL_PROVIDER` | — | `brevo` \| `mailjet`; required only when both are configured |
| `MAIL_FROM` | `<name> <noreply@localhost>` | must be provider-verified |
| `ASSISTANT_NAME`, `ASSISTANT_LANGUAGE` | — / `English` | seed the first assistant only |
| `ASSISTANTS_DIR` | `./data/assistants` (`/data/assistants` in the image) | keep on the volume; never relative when deployed |
| `OPENROUTER_MODEL`, `MODEL_EFFORT`, `MODEL_MAX_TOKENS` | `anthropic/claude-opus-5`, `high`, `8000` | fallback until an admin saves settings |
| `OPENROUTER_SITE_URL`, `OPENROUTER_SITE_NAME` | — / assistant name | attribution only |
| `SESSION_DAYS`, `LOGIN_TOKEN_MINUTES` | `30`, `30` | |
| `PORT`, `NODE_ENV`, `LOG_LEVEL` | `3000`, `development`, `info` | |

Per-assistant settings (the `assistant_settings` table, `settings.ts`, saved on
`/admin/assistants/:id`; read with `loadSettings`, never from `config`):
`model`, `effort`, `show_thinking`, `web_search`, `web_search_max_results`
(≤ 20, default 5), `web_search_include_domains` / `_exclude_domains`, `memory`,
`citations`, `compaction`, `notes` (users' own documents), `eu_only`,
`anonymize`, `admin_conversation_log`, `temperature`, `top_p` (the last two
empty = send nothing). Identity lives on the `assistants` row instead: `name`,
`slug`, `description`, `language`, `welcome`. A new key needs its entry in
`KEYS`, `loadSettings`, `saveSettings`, the form in `views.ts`, the route in
`routes/admin.ts`, and a row in the README table.

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
  `expires_at > now()` in the session lookup, so a copied cookie dies
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
  into the provider's sender object, and the address must be one the provider
  has verified. Left unset it becomes `noreply@localhost`, which both reject.
  Mailjet can answer 200 and still refuse a message inside the body; `mail.ts`
  reads that per-message outcome.
- **The mail call has a 15-second timeout.** `fetch` has none by default, and a
  hanging send leaves `POST /login` with no response — the user sees an endless
  spinner rather than an error. This is the same failure SMTP used to produce
  when its port was blocked.
- **EU-only routing is checked when an admin saves**, in `unusable()` in
  `routes/admin.ts`. Without that the first user to send a message discovers the
  misconfiguration and the admin never sees it. Any new setting that depends on
  something outside the app belongs in that function — anonymization does not,
  which is the point of it running in here.
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
  the server cannot write the assistants directory on boot.
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
