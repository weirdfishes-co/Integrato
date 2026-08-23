# AI Assistant

A configurable chat assistant on any model OpenRouter offers. Users sign in with a magic link
sent to their email address, their conversations are stored in SQLite and are
available again after signing in later. The personality and instructions live in
`instr.md`; the knowledge base is the set of markdown files in `context/`.

- **Stack**: Node 22, TypeScript, Express 5, SQLite (better-sqlite3), nodemailer
- **Model access**: OpenRouter (OpenAI-compatible API), one key for every model
- **Hosting**: Railway (Dockerfile + persistent volume for the database)
- **Auth**: magic link over email, 30-day cookie session
- **Admin**: `/admin` to add users and pick the model, `/admin/content` for the knowledge base

The product name and the answer language are configuration, not code: set
`ASSISTANT_NAME` and `ASSISTANT_LANGUAGE` and the interface, the sign-in email
and the system prompt follow.

For the architecture and the reasoning behind the choices: see [CLAUDE.md](CLAUDE.md).

## Running locally

```bash
npm install
cp .env.example .env      # fill in OPENROUTER_API_KEY, ADMIN_EMAILS and SMTP_*
npm run dev               # http://localhost:3000
```

The database is created automatically at `DATABASE_PATH` (default
`./data/app.db`) and migrations run at startup. The addresses in `ADMIN_EMAILS`
are written into the user list as admins on every boot, so you can always get in.

**Signing in without a mail server.** Leave `SMTP_HOST` empty and the sign-in
link is written to the log instead of emailed:

```
SIGN-IN LINK (dev mode, not emailed)  link: http://localhost:3000/auth/callback?token=...
```

Paste that URL into your browser and you are in. This only works outside
production: with `NODE_ENV=production` `SMTP_HOST` is required, so a sign-in
link can never end up in a log file there.

Other scripts:

```bash
npm run build       # bundles the server to dist/server.js
npm start           # runs the built server
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

## Changing the instructions and context

- **`instr.md`** is the system prompt. The rule "always answer in
  `ASSISTANT_LANGUAGE`" is appended automatically — you do not need to put it in
  there. [`instr.example.md`](instr.example.md) holds a neutral starting point.
- **`context/*.md`** are sent along as knowledge base, alphabetically by file
  name. The directory ships empty; add documents through `/admin/content` or by
  dropping `.md` files in there.
- A placeholder such as `{Global.Guidelines}` in `instr.md` is replaced by the
  content of `context/Guidelines.md`.

Both are re-read on every question as soon as the file changes — no restart
needed.

### Through the admin page

An admin does not need file access for this: on **`/admin/content`** you can read
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

Everything below lives on **`/admin`** and is stored in the database, so a change
applies from the next message on — no restart, no redeploy.

| Setting | What it does |
| --- | --- |
| **Model** | Any model OpenRouter offers, with context size and price shown |
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
  user. They are prepended to the system prompt in later conversations. It costs
  one extra call per message and never blocks the reply — a failure is logged and
  ignored.
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
2. **Attach a volume** with mount path `/data`. Without a volume the database is
   gone on every deploy — the container file system is ephemeral.
3. **Set the environment variables** (see `.env.example`):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `OPENROUTER_API_KEY` | yes | API key from [openrouter.ai/keys](https://openrouter.ai/keys) |
   | `ADMIN_EMAILS` | yes | Comma-separated admins; always granted rights at boot |
   | `SMTP_HOST` | yes | SMTP server for the magic links |
   | `SMTP_PORT` / `SMTP_SECURE` | no | Default 587 with STARTTLS; `SMTP_SECURE=true` for port 465 |
   | `SMTP_USER` / `SMTP_PASS` | no | Leave empty for a relay without authentication |
   | `MAIL_FROM` | no | Sender, e.g. `AI Assistant <noreply@yourdomain.com>` |
   | `ASSISTANT_NAME` | no | Default `AI Assistant`; shown in the UI and the sign-in email |
   | `ASSISTANT_LANGUAGE` | no | Default `English`; the answer language rule appended to the prompt |
   | `APP_URL` | yes | Public URL, e.g. `https://assistant.up.railway.app`. Magic links are built on this; `https://` sets the Secure flag on the cookie |
   | `DATABASE_PATH` | no | Default `/data/app.db` in the image |
   | `CONTEXT_DIR` / `INSTRUCTIONS_PATH` | no | Default `/data/context` and `/data/instr.md` in the image — keep these on the volume, or admin changes vanish on every deploy |
   | `OPENROUTER_MODEL` | no | Starting model, default `anthropic/claude-opus-5`. An admin's choice on `/admin` overrides it |
   | `MODEL_EFFORT` / `MODEL_MAX_TOKENS` | no | Default `high` and `8000`. Effort is `low`–`max`; only reasoning models act on it |
   | `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` | no | Optional attribution on the openrouter.ai rankings |
   | `SESSION_DAYS` / `LOGIN_TOKEN_MINUTES` | no | Default 30 days and 30 minutes |

   Railway sets `PORT` itself; the server binds on `0.0.0.0`.
4. **Volume ownership is handled for you.** The mounted volume arrives owned by
   root; `scripts/entrypoint.sh` takes ownership of it and then runs the server
   as the unprivileged `node` user.
5. **The health check** is on `/healthz`. Migrations run inside the server
   process, so there is no separate migration command.

Test the container locally the way Railway runs it:

```bash
docker build -t ai-assistant .
docker run --rm -p 3000:3000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e ADMIN_EMAILS=you@example.com \
  -e SMTP_HOST=smtp.example.com \
  -e APP_URL=http://localhost:3000 \
  -v "$PWD/data:/data" \
  ai-assistant
```

## Security

- Sign-in tokens and session tokens are stored as a SHA-256 hash only.
- A sign-in link works once and expires after `LOGIN_TOKEN_MINUTES`.
- The login form never reveals whether an address exists, and is limited to
  5 attempts per fifteen minutes per address and per IP.
- Session cookies are `httpOnly` + `sameSite=lax`, and `secure` as soon as
  `APP_URL` is on `https://`.
- Conversation history is walled off per user: the owner is part of the SQL
  query, not a check afterwards.
- The knowledge base page only writes inside the context directory: file names
  are validated *and* the resolved path is checked against the base directory,
  so `../` or an absolute path cannot write outside it.
