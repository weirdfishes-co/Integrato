# Unlimited Brain

A host for several configurable chat assistants, on any model OpenRouter offers.
Each assistant has its own instructions, knowledge base, model settings and list
of users. People sign in with a magic link — administrators with a password —
pick an assistant they have access to, and their conversations are kept per
assistant in PostgreSQL.

- **Stack**: Node 22, TypeScript, Express 5, PostgreSQL
- **Model access**: OpenRouter (OpenAI-compatible API), one key for every model
- **Email**: Brevo HTTP API
- **Hosting**: Railway (Dockerfile + a Postgres service + a volume for the knowledge bases)
- **Auth**: magic link over email for users, `ADMIN_PASSWORD` for admins,
  30-day cookie session
- **Admin**: `/admin` for users, assistants and the OpenRouter balance;
  `/admin/assistants/:id` for one assistant's settings, access and knowledge base

The product name and the answer language are configuration, not code: set
`ASSISTANT_NAME` and `ASSISTANT_LANGUAGE` and the interface, the sign-in email
and the system prompt follow.

For the architecture and the reasoning behind the choices: see [CLAUDE.md](CLAUDE.md).

## Running locally

```bash
docker run -d --name assistant-db -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=assistant -p 5432:5432 postgres:17-alpine

npm install
cp .env.example .env      # fill in DATABASE_URL, OPENROUTER_API_KEY,
                          # ADMIN_EMAILS, ADMIN_PASSWORD, mail
npm run dev               # http://localhost:3000
```

The schema is created automatically: migrations run in-process at startup
against `DATABASE_URL`. The addresses in `ADMIN_EMAILS` are written into the
user list as admins on every boot, so you can always get in: sign in on `/login`
with one of those addresses plus `ADMIN_PASSWORD`. No email is sent for an
admin, so the app is usable before any mail account exists.

`npm test` needs Docker too — it starts a throwaway PostgreSQL container and
runs the real migrations against it, so a mistake in the SQL fails in the suite
rather than in production.

**Sending mail.** Set `BREVO_API_KEY` and `MAIL_FROM`. Brevo's HTTP API is the
only transport: SMTP was removed after Railway proved unable to open a
connection to Brevo's SMTP port on 587, 2525 or 465, while port 443 worked
without trouble. Get a key from Brevo → SMTP & API → API Keys. Prefer the API key on a hosting platform: it runs
over 443, while outbound SMTP ports are often blocked — by the host or by the
mail provider — which surfaces as `Connection timeout` and no email.

**Signing in without a mail account.** Leave `BREVO_API_KEY` empty and the
sign-in link is written to the log instead of emailed:

```
SIGN-IN LINK (dev mode, not emailed)  link: http://localhost:3000/auth/callback?token=...
```

Paste that URL into your browser and you are in. This only works outside
production: with `NODE_ENV=production` `BREVO_API_KEY` is required, so a sign-in
link can never end up in a log file there.

Other scripts:

```bash
npm run build       # bundles the server to dist/server.js
npm start           # runs the built server
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

## Styling

The interface follows [STYLE.md](STYLE.md), reverse-engineered from
https://g.ieffe.dev. `public/styles.css` binds semantic names (`--bg`, `--text`,
`--accent`, …) to that palette, so changing the look means changing the tokens
and the type scale, not the components.

Montserrat and Lato are self-hosted from `public/fonts/` — no CDN request, and
the app works offline. There is no logo image anywhere, including in the
sign-in email: the product name is set as text, so nothing depends on a mail
client allowing images.

Three things STYLE.md's source does not provide were decided here and are marked
in the stylesheet: hover colours, a status palette for errors and confirmations,
and a dark theme. Every colour pairing clears WCAG AA.

Two conventions are worth knowing before you change anything:

- **Links are bold and coloured rather than underlined**, because most of them
  stand alone — a row of actions, a breadcrumb, a name in a table. A link
  *inside* a sentence keeps its underline, since weight and colour alone do not
  pick it out of a paragraph.
- **The sidebar runs on a lighter step of the brand blue**, with bold white
  links on it. Its rows have no hover fill: the conversation you are in is the
  only one marked, and hovering a row reveals its delete button instead.

## Assistants

An admin creates assistants on **`/admin`**. Each one gets:

- its own **address**, `/<slug>`, derived from the name when it is created.
  Names that would collide with a built-in path (`admin`, `api`, `login`, …)
  get a numbered slug instead, so the assistant stays reachable. The old
  `/a/<slug>` form redirects to the new one
- its own **welcome message**, shown in an empty conversation (500 characters;
  empty falls back to a built-in sentence)
- its own **instructions and knowledge base**, under
  `<ASSISTANTS_DIR>/<slug>/instr.md` and `<ASSISTANTS_DIR>/<slug>/context/*.md`
- its own **model, effort, web search, memory, citations and compaction**
- its own **user list** — the rights matrix on the assistant's admin page

**Access.** Admins may use every assistant. Everyone else sees only what they
were granted; an assistant a user may not use answers 404, so the names of other
assistants are not exposed. After signing in a user lands on a picker showing
their assistants — or goes straight into the chat when they have exactly one.

**Isolation.** Conversations and remembered facts are stored per user *and* per
assistant. Nothing a user tells one assistant reaches another.

**Deleting** an assistant — the Delete beside Open in the assistants table, or
the button on its own page — removes its conversations, memories, settings and
grants. Its knowledge-base files are deliberately left on disk, so a mistaken
click does not destroy documents that took work to write. Nothing stops you
deleting the last assistant; a fresh one is created on the next boot, but the
deleted conversations are gone.

## Changing the instructions and context

Each assistant has its own copy of these; edit them on its admin page under
**Knowledge base**. The files in the repo are only the seed for a *newly
created* assistant.

- **`instr.md`** is the system prompt. The rule "always answer in the
  assistant's language" is appended automatically — you do not need to put it in
  there. [`instr.example.md`](instr.example.md) holds a neutral starting point.
- **`context/*.md`** are sent along as knowledge base, alphabetically by file
  name. The directory ships empty; add documents on the assistant's Knowledge
  base page.
- A placeholder such as `{Global.Guidelines}` in `instr.md` is replaced by the
  content of `context/Guidelines.md`.

Both are re-read on every question as soon as the file changes — no restart
needed.

### Through the admin page

An admin does not need file access for this: on an assistant's **Knowledge
base** page (`/admin/assistants/:id/content`) you can read
and edit the base prompt, and create, upload (several `.md` files at once), edit
and delete context documents. The matching `{Global.…}` placeholder is listed
next to each document.

File names may only contain letters, digits, `-` and `_` and must end in `.md` —
the same character range that works in a placeholder. Maximum 512 kB per
document.

**Where those files land** is decided by `CONTEXT_DIR` and `INSTRUCTIONS_PATH`.
Locally these default to the files in the repo. In the Docker image they live in
`/data` — so on the Railway volume, because otherwise every admin change would
disappear on the next deploy. If that location is still empty, the bundled files
are copied there once; existing content is never overwritten.

## Running on free models

OpenRouter carries ~20 models priced at zero (`:free` suffix, plus a few
previews). They work here with no credit balance at all — `MODEL_MAX_TOKENS=8000`
is accepted, because the request costs nothing to reserve. Limits are 20 requests
per minute and 50 per day; buying $10 of credits raises the daily cap to 1000.

Two caveats:

- **A negative balance can still block you.** OpenRouter returns 402 on free
  models too once the account is overdrawn, so keep it at zero or above.
- **Web search is billed separately**, even on a free model — roughly $0.007 per
  search. It is the one setting on `/admin` that costs money regardless of the
  model.

**Quality varies far more than on paid models.** Some free reasoning models write
their chain of thought into the answer itself rather than into the reasoning
channel, which shows up as an answer that reads like a monologue about the
question — `nvidia/nemotron-3.5-lightning:free` does exactly that. If you see it,
switch model; no setting can fix it from this side. Models that behaved well in
testing: `nvidia/nemotron-3-ultra-550b-a55b:free`, `poolside/laguna-s-2.1:free`,
`dots-studio/dots-3-note-preview:free`.

## When an answer fails

The chat screen names the cause rather than showing one generic error:

| Message | What to do |
| --- | --- |
| …too little credit for this request | Add credit at OpenRouter, or lower `MODEL_MAX_TOKENS` |
| The OpenRouter key was rejected | Check `OPENROUTER_API_KEY` in the environment |
| This model is not available on OpenRouter | Pick another model on the assistant's page |
| Too many requests at once | Wait a moment and retry |
| The model provider is unavailable | Retry shortly; the fault is upstream |

A telling pattern: if a `:free` model answers but a paid one fails, the key is
out of credit — free models run on an empty balance, paid ones do not. Note that
a deployed instance can hold a *different* key from your local `.env`.

The full provider error, including its metadata, is always in the server log.

## Watching the balance

`/admin` shows what is left at OpenRouter, because an empty account is the most
likely reason for the assistant to stop answering. Two numbers appear, and they
are not the same thing:

- **Remaining** — credits added minus everything spent. This is the number a
  402 measures. Green above $1, amber below, red at zero or less.
- **Key cap** — an optional spending limit on the API key. A key can show plenty
  of headroom here while the account itself is empty, so never read this one
  alone.

The figures are cached for 30 seconds. If OpenRouter cannot be reached the panel
says so and the rest of the page still works.

## Assistant settings

Everything below lives on an assistant's page under **`/admin`** and is stored in
the database *per assistant*, so a change applies from the next message on — no
restart, no redeploy.

| Setting | What it does |
| --- | --- |
| **Model** | Any model OpenRouter offers, with context size and price shown |
| **Identity** | The chatbot's name, description, answer language and welcome message |
| **Reasoning effort** | `low` … `max`. Models without reasoning support ignore it |
| **Show thinking** | Streams the model's reasoning above the answer, collapsed |
| **Web search** | Look things up beyond the knowledge base; billed per search |
| **Domain limits** | Restrict search to, or exclude, specific domains |
| **Memory** | Remember durable facts about a user across their conversations |
| **Citations** | Ask the assistant to mark which document a statement came from |
| **Compaction** | Summarize long threads instead of dropping the oldest messages |

Three of these are built in this app rather than provided by OpenRouter, which
is worth knowing when judging how reliable they are:

- **Memory** is a second, cheap model call after each answer that extracts
  durable facts ("Works as a recruiter at Acme.") into the `memories` table, per
  user *and* per assistant. They are prepended to the system prompt in later
  conversations. At most 10 facts per exchange and the 40 most recent are sent.
  It costs one extra call per message and never blocks the reply — a failure is
  logged and ignored.

  Two limits worth knowing before switching it on: **deleting a conversation
  does not erase facts already extracted from it**, and there is no page yet to
  see or delete what an assistant remembers about someone. With memory off,
  deleting a conversation really is complete forgetting.
- **Citations** are prompt-enforced, not API-guaranteed: the model is asked to
  write `[Guidelines.md]` after a sentence drawn from that document. A model can
  forget or invent one, unlike a provider-level citation API.
- **Compaction** folds everything older than the last 20 messages into a running
  summary once a thread passes 40 messages, and carries that summary as context.
  Without it the oldest messages are simply dropped.

**Web search domains.** Fill in "only these domains" to whitelist, or "never
these domains" to blacklist — one per line, wildcards allowed (`*.substack.com`).
Some search engines accept only one of the two lists, so the whitelist wins when
both are filled in. Google's engine ignores domain filtering entirely.

## Choosing the model

`OPENROUTER_MODEL` only sets the *starting* model. An admin picks the actual one
on **`/admin`** from a live list of everything OpenRouter offers, with context
size and price per million tokens shown next to each. The choice is stored in the
database, so it survives a redeploy and takes effect on the next message — no
restart needed.

If the model list cannot be fetched, the picker falls back to a text field where
you can type an OpenRouter model id (`vendor/model`) by hand.

`MODEL_EFFORT` and `MODEL_MAX_TOKENS` are the environment's starting values;
effort is editable on `/admin` afterwards. Note that OpenRouter rejects a request
when `MODEL_MAX_TOKENS` exceeds what your remaining credit can cover, so a large
value on a nearly empty key fails with a 402 before the model is ever called. A
burst of requests can hit the same 402 through the separate in-flight budget,
which the `Retry-After` header times.

## Deploying on Railway

1. **Create a service** from this repo. Railway picks up `railway.json` and
   builds with the `Dockerfile`.
2. **Add a PostgreSQL service** from Railway's plugin list. It provides
   `DATABASE_URL`; reference it from the app service and the schema is created
   on the first boot.
3. **Attach a volume** with mount path `/data`. The database no longer lives
   here, but the per-assistant knowledge bases do — without a volume every
   document an admin writes is gone on the next deploy.
4. **Set the environment variables** (see `.env.example`):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `DATABASE_URL` | yes | PostgreSQL connection string; Railway's Postgres service supplies it |
   | `OPENROUTER_API_KEY` | yes | API key from [openrouter.ai/keys](https://openrouter.ai/keys) |
   | `ADMIN_EMAILS` | yes | Comma-separated admins; always granted rights at boot |
   | `ADMIN_PASSWORD` | yes | Shared password for those addresses. Admins sign in with it instead of a magic link; at least 12 characters in production |
   | `BREVO_API_KEY` | yes | Brevo HTTP API key; the only way the app sends mail |
   | `MAIL_FROM` | no | Sender, e.g. `Unlimited Brain <noreply@yourdomain.com>`. Must be a sender Brevo has verified |
   | `ASSISTANT_NAME` | no | Name of the *first* assistant on a fresh install, and the sign-in email's sender name |
   | `ASSISTANT_LANGUAGE` | no | Answer language of the first assistant; each assistant carries its own afterwards |
   | `APP_URL` | yes | Public URL, e.g. `https://assistant.up.railway.app`. Magic links are built on this; `https://` sets the Secure flag on the cookie |
   | `ASSISTANTS_DIR` | no | Default `/data/assistants` in the image — one directory per assistant. Keep it on the volume, or every knowledge base is lost on deploy |
   | `OPENROUTER_MODEL` | no | Starting model, default `anthropic/claude-opus-5`. An admin's choice on `/admin` overrides it |
   | `MODEL_EFFORT` / `MODEL_MAX_TOKENS` | no | Default `high` and `8000`. Effort is `low`–`max`; only reasoning models act on it |
   | `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` | no | Optional attribution on the openrouter.ai rankings |
   | `SESSION_DAYS` / `LOGIN_TOKEN_MINUTES` | no | Default 30 days and 30 minutes. `LOGIN_TOKEN_MINUTES` only affects the magic links non-admins receive |
   | `LOG_LEVEL` | no | pino level, default `info` |

   Railway sets `PORT` itself; the server binds on `0.0.0.0`. Do not set
   `ASSISTANTS_DIR` to a relative path — the image already points it at the
   volume, and a relative value resolves inside `/app`, where the server cannot
   write. `DATABASE_PATH`, `CONTEXT_DIR` and `INSTRUCTIONS_PATH` are gone; remove
   them if they are still set.
5. **Volume ownership is handled for you.** The mounted volume arrives owned by
   root; `scripts/entrypoint.sh` takes ownership of it and then runs the server
   as the unprivileged `node` user.
6. **The health check** is on `/healthz`. Migrations run inside the server
   process, so there is no separate migration command.

Test the container locally the way Railway runs it:

```bash
docker build -t ai-assistant .
docker run --rm -p 3000:3000 \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  -e ADMIN_EMAILS=you@example.com \
  -e ADMIN_PASSWORD=a-long-password \
  -e BREVO_API_KEY=xkeysib-... \
  -e APP_URL=http://localhost:3000 \
  -v "$PWD/data:/data" \
  ai-assistant
```

## Security

- Sign-in tokens and session tokens are stored as a SHA-256 hash only.
- A sign-in link works once and expires after `LOGIN_TOKEN_MINUTES`.
- `ADMIN_PASSWORD` is compared in constant time and is never written to the log.
  It is shared by every address in `ADMIN_EMAILS`, so the audit trail says
  *which admin* signed in but not that they alone knew the password — rotate it
  whenever someone stops being an admin.
- The login form never reveals whether an address exists, and is limited to
  5 attempts per fifteen minutes per address and per IP. Submitting a password
  returns one message for every failure, so it cannot be used to test addresses;
  submitting an *empty* password does reveal whether an address is an admin,
  which is the price of telling admins to use their password instead of waiting
  for an email that never comes.
- Session cookies are `httpOnly` + `sameSite=lax`, and `secure` as soon as
  `APP_URL` is on `https://`.
- A session lasts `SESSION_DAYS` (30) from signing in and is **not** extended by
  activity, so an active user still signs in again after 30 days. Expiry is
  checked against the database on every request as well as by the cookie, so a
  copied cookie stops working too. Signing out deletes the row immediately.
  Sessions are per browser: phone and laptop expire independently.
- Conversation history is walled off per user: the owner is part of the SQL
  query, not a check afterwards.
- The knowledge base page only writes inside the context directory: file names
  are validated *and* the resolved path is checked against the base directory,
  so `../` or an absolute path cannot write outside it.
- Remembered facts and conversations are read with both the owner and the
  assistant in the SQL, so nothing crosses between users or between assistants.
- An assistant a user may not use is indistinguishable from one that does not
  exist: both answer 404.
- The server runs as the unprivileged `node` user; only the entrypoint that
  takes ownership of the volume runs as root, for a moment at startup.
- Secrets stay in the environment: `.env`, the database and the `data/` directory
  are all in `.gitignore` and never enter the image or the repository.
