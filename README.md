# Integrato

**[integrato.cc](https://integrato.cc)** · [MIT licensed](LICENSE)

A self-hosted host for **several chat assistants**, on any model
[OpenRouter](https://openrouter.ai) offers. Each assistant has its own
instructions, knowledge base, model and settings, and its own list of users.
People sign in with a magic link — administrators with a password — pick an
assistant they have access to, and their conversations are kept per assistant in
PostgreSQL.

- **Stack**: Node 22, TypeScript (ESM), Express 5, PostgreSQL. Server-rendered
  HTML, vanilla JS and hand-written CSS on the front end — no build step for the
  browser, no frontend framework.
- **Models**: one OpenRouter key for every model, switchable per assistant from
  the admin page without a redeploy.
- **Email**: Brevo or Mailjet, over HTTPS.
- **Runs** as a Docker image anywhere that can give it PostgreSQL and a
  persistent volume.

The product name and the answer language are configuration, not code. For the
architecture and the reasoning behind the choices, see [CLAUDE.md](CLAUDE.md);
for the visual design, [STYLE.md](STYLE.md).

## Quick start

```bash
docker run -d --name integrato-db -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=integrato -p 5432:5432 postgres:17-alpine

npm install
cp .env.example .env     # DATABASE_URL, OPENROUTER_API_KEY, ADMIN_EMAILS,
                         # ADMIN_PASSWORD, EMAIL_ENCRYPTION_KEY
npm run dev              # http://localhost:3000
```

The schema creates itself: migrations run in-process at startup. The addresses
in `ADMIN_EMAILS` are written into the user list as admins on every boot, so you
can always get in — sign in on `/login` with one of them plus `ADMIN_PASSWORD`.
Admins are never emailed a link, so the app is usable before any mail account
exists.

**Signing in with no mail account at all.** Leave both providers' keys empty and
the sign-in link is written to the log instead:

```
SIGN-IN LINK (dev mode, not emailed)  link: http://localhost:3000/auth/callback?token=...
```

Paste it into the browser. This works only outside production: with
`NODE_ENV=production` a mail provider is required, so a link can never end up in
a log file there.

```bash
npm run dev         # watch mode
npm run build       # bundle the server to dist/server.js
npm start           # run the built server
npm run typecheck   # tsc --noEmit
npm test            # vitest — needs Docker; see Development
```

## Configuration

Read once at startup; anything missing or contradictory fails the boot rather
than the first request. [`.env.example`](.env.example) is the template.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `OPENROUTER_API_KEY` | yes | From [openrouter.ai/keys](https://openrouter.ai/keys) |
| `ADMIN_EMAILS` | yes | Comma-separated; always granted admin rights at boot |
| `ADMIN_PASSWORD` | yes | Shared by those addresses; ≥ 12 characters in production |
| `EMAIL_ENCRYPTION_KEY` | yes | Encrypts stored addresses; ≥ 32 characters (`openssl rand -base64 32`). **Back it up** — lose or change it and no stored address can be read again |
| `APP_URL` | no, but set it | Public URL, default `http://localhost:3000`. **Magic links are built on it**, so an unset value in production emails links pointing at localhost. `https://` sets the Secure cookie flag |
| `BREVO_API_KEY` | one provider | Brevo HTTP API key |
| `MAILJET_API_KEY` + `MAILJET_SECRET_KEY` | one provider | Mailjet's key pair; half a pair is refused |
| `MAIL_PROVIDER` | only if both | `brevo` or `mailjet`. With both configured the app refuses to start until this says which one sends |
| `MAIL_FROM` | no | e.g. `Integrato <noreply@example.com>`. Must be a sender the provider has verified |
| `ASSISTANTS_DIR` | no | Where knowledge bases live, default `/data/assistants` in the image. **Keep it on a volume**, and never relative when deployed |
| `ASSISTANT_NAME` / `ASSISTANT_LANGUAGE` | no | Seed the *first* assistant only; each carries its own afterwards |
| `OPENROUTER_MODEL` | no | Starting model until an admin picks one |
| `MODEL_EFFORT` / `MODEL_MAX_TOKENS` | no | `high`, `8000` |
| `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME` | no | Attribution on the OpenRouter rankings |
| `SESSION_DAYS` / `LOGIN_TOKEN_MINUTES` | no | 30 days, 30 minutes |
| `TRUST_PROXY` | behind a proxy | Number of proxies in front, or `true`. **Off by default**: with nothing in front, trusting `X-Forwarded-For` lets a caller pick their own `req.ip`. Unset behind a proxy means the per-IP login limit counts every visitor as one client — the log warns when it sees the header |
| `PORT` / `NODE_ENV` / `LOG_LEVEL` | no | `3000`, `development`, `info` |

Both mail providers are HTTP APIs on port 443. There is no SMTP transport:
outbound SMTP ports are blocked often enough — by hosts and by mail providers —
that a transport which works in one environment and silently times out in
another is worse than not having it.

## Assistants

An admin creates them on **`/admin`**. Each gets:

- an **address**, `/<slug>`, derived from its name. A name that would collide
  with a built-in path (`admin`, `api`, `login`, …) gets a numbered slug, so the
  assistant stays reachable. The address is editable later: the knowledge-base
  folder moves with it and the old address keeps redirecting. Open chat pages
  need a reload afterwards.
- a **welcome message** for an empty conversation (500 characters)
- its **instructions and knowledge base**, under
  `<ASSISTANTS_DIR>/<slug>/instr.md` and `<slug>/context/*.md`
- its own **model and settings** (below), and its own **user list**

**Access.** Admins may use every assistant. Everyone else sees only what they
were granted, and an assistant a user may not use answers **404** — so the names
of other assistants are not exposed. After signing in a user lands on a picker,
or goes straight into the chat when they have exactly one.

**Isolation.** Conversations, remembered facts and users' own documents are
stored per user *and* per assistant. Nothing crosses between them.

**Deleting** an assistant removes its conversations, memories, settings and
grants, but deliberately leaves its knowledge-base files on disk, so a mistaken
click does not destroy documents that took work to write.

### Instructions and knowledge base

Each assistant has its own copy; edit them on its admin page under **Knowledge
base** — no file access needed. The files in the repo are only the seed for a
*newly created* assistant.

- **`instr.md`** is the system prompt. "Always answer in the assistant's
  language" is appended automatically. [`instr.example.md`](instr.example.md) is
  a neutral starting point.
- **`context/*.md`** are sent as the knowledge base, alphabetically by file name.
- `{Global.Guidelines}` in the prompt is replaced by `context/Guidelines.md`.

Both are re-read as soon as they change — no restart. File names may contain
letters, digits, `-` and `_` and must end in `.md`; 512 kB per document. A new
assistant is seeded from the bundled files once, and existing content is never
overwritten.

**PDFs** can be uploaded too, on the knowledge base page and in a user's
document editor. They are converted to Markdown on the server (headings,
paragraphs, lists and simple tables are kept; running headers and page numbers
are dropped). Limits: 10 MB and 200 pages, and no OCR — a scanned PDF has no
text to read and is refused. Check the result: complex or multi-column layouts
convert imperfectly.

## Four types of chatbot

Every chatbot has a **type**, chosen when it is created and changeable later on
its identity page. The type decides which models it can use and which settings
it has.

| Type | What it does | Models | State |
| --- | --- | --- | --- |
| **Text → text** | The ordinary chatbot | ~460 | works |
| **Text → image** | The user describes a picture, the model draws it | 12 | works |
| **Speech → text** | The user uploads a recording, the model writes out what was said | 42 | works |
| **Text → speech** | The user writes, the model reads it aloud | 4 | works |

The model counts come from OpenRouter's own catalogue: each model declares what
it accepts and produces, so the picker asks the catalogue rather than carrying a
list someone has to maintain. For anything but text that filter is the
difference between a usable picker and a wall of models that would fail on the
first message.

**Settings follow the type.** An image chatbot has no web search, memory,
citations or compaction — all four exist to carry text between turns, which an
image generator does not do — and gains an **image shape** instead. A
speech-to-text chatbot has no anonymization: that rewrites outgoing *text*, and
here the user sends audio, so offering the toggle would promise a protection
that cannot reach the input that matters. A setting that is visible but inert is
worse than one that is absent.

**Text → speech is thin on OpenRouter.** Of the four models that output audio,
two are music generators, leaving `openai/gpt-audio` and `gpt-audio-mini` — and
the mini is about 27 times cheaper per audio token, so start there.

### Text → image

Pick a shape from the ratios OpenRouter accepts — `1:1`, `16:9`, `9:16`, `21:9`
and ten others — or leave it on *model default*. Those are the only values the
API takes; it refuses anything else.

**`MODEL_MAX_TOKENS` applies to neither an image nor speech**, deliberately. It is an
answer-*length* budget, and an image costs on the order of 1,300 completion
tokens whatever it depicts — so a cap set for prose (800 is a reasonable one)
truncates the response and returns no image and no text at all. Nothing is
uncapped by leaving it out: one request yields one image, so the cost is bounded
by the request rather than by a token count.

An image arrives whole rather than streamed, which is why there is no typing
indicator for this type: half a picture is not worth showing. It is stored
beside the message and served from its own address behind the same ownership
check as the conversation, so a megabyte of PNG is fetched once and cached
rather than carried in every reload of the conversation.

Images are **never sent back to the model**. The history replay is text only, so
a picture costs its tokens once.

### Text → speech

Pick a **voice** — `alloy`, `nova`, `onyx`, `shimmer` and seven others — or leave
it on *model default*. The catalogue does not publish voices, so the list is
maintained here; the provider refuses a name it does not have rather than
ignoring it, so a wrong one surfaces as an error instead of silence.

The answer arrives as text *and* a player under it. Nothing autoplays: a voice
starting by itself is startling, and a browser would block it anyway.

Two constraints come from the API rather than from choice. Audio **must** be
streamed — ask for it without streaming and the reply is "Audio output requires
stream: true" — and while streaming the only format available is raw `pcm16`,
because a container cannot be written incrementally. The samples are therefore
wrapped into a 24 kHz mono WAV by the app before they are stored.

### Speech → text

The composer gains a **Choose a recording** control. Upload `.wav`, `.mp3`,
`.m4a`, `.ogg`, `.flac` or `.webm` up to about 6 MB — a few minutes of speech —
and the answer is the transcript. Anything typed alongside the file is sent as
an instruction, so "translate this into Dutch" works as well as a plain
transcription.

The recording itself is not stored: the conversation keeps the file name and the
transcript, which is what anyone rereading it needs.

## Settings, per assistant

Stored in the database, so a change applies from the next message — no restart.

| Setting | What it does |
| --- | --- |
| **Model** | Any model OpenRouter offers, with context size and price shown. Falls back to a text field if the catalogue cannot be fetched |
| **Identity** | Name, address, description, answer language, welcome message |
| **Reasoning effort** | `low` … `max`; models without reasoning ignore it |
| **Show thinking** | Streams the reasoning above the answer, collapsed |
| **Image shape** | *Text → image only.* The aspect ratio asked of the model |
| **Voice** | *Text → speech only.* Which voice reads the answer aloud |
| **Temperature / Top-P** | Empty — the default — sends nothing, so the model uses the one its provider tuned. Several reasoning models reject a temperature outright. Applies to answers only, never to memory or compaction |
| **Web search** | Look things up beyond the knowledge base. Billed per search (~$0.007), whatever the model costs |
| **Domain limits** | One domain per line, wildcards allowed. Some engines accept only one of the two lists, so "only these" wins when both are filled in |
| **EU-only routing** | See below |
| **Anonymization** | See below |
| **Own documents** | See below |
| **Memory** | A second, cheap call after each answer extracts durable facts into the database, per user and per assistant, and prepends them to later prompts. Never blocks a reply. **Deleting a conversation does not erase facts already taken from it**, and there is no page yet to see or clear them |
| **Citations** | Asks the model to mark the document a statement came from. Prompt-enforced, so a model can forget or invent one |
| **Compaction** | Past 40 messages, folds everything older than the last 20 into a running summary instead of dropping it |
| **Admins can read conversations** | Adds a *Conversations* page under the assistant in `/admin`, listing every user's threads. **Off by default**, and the chat tells users which way it is set. Messages are shown as stored; it does not cover users' own documents |

### EU-only routing

OpenRouter serves most models from several places — `azure/eu`,
`amazon-bedrock/eu-west-1` and `google-vertex/europe` are separate endpoints
from their American siblings. With this on:

- the model picker shows only models OpenRouter can serve from Europe
- every request carries that model's European endpoints with fallbacks off, so
  OpenRouter **refuses rather than reroutes** when they are busy
- saving is refused if no European provider serves the chosen model, with the
  reason on the page, instead of failing later on every message

An endpoint tagged `global` does not count: it includes Europe without being
limited to it. This is about where a request is *served* — it says nothing about
where OpenRouter sits, or about a provider's retention policy.

### Anonymization

A user's message is rewritten before it goes to the model. Each match becomes a
placeholder (`<IBAN_1>`, `<EMAIL_ADDRESS_2>`), and one value keeps one
placeholder for the whole conversation, so the model can still tell two
accounts apart.

| Recognized | Verified by |
| --- | --- |
| Email address | pattern |
| IBAN | mod-97 — a string that passes *is* an IBAN |
| Card number | Luhn, 13–19 digits |
| BSN | Dutch 11-proef |
| Phone number | shape: country code or trunk zero, 9–15 digits |
| IP address | pattern |
| Dutch postcode | four digits, two capitals |

It runs in-process: nothing to deploy, nothing to reach over the network.

**It does not catch names.** Recognizing that "Priya Raghunathan" is a person
needs a trained model, and no regular expression does it — so this is a stated
limit rather than a silent one. Everything it does find it finds exactly: every
rule above has a checksum or a strict shape behind it, and it is tested against
the false positives that matter — years, order numbers, prices, version strings,
ISBNs and room numbers all pass through untouched.

Two more things: the **original is still stored** (only the copy sent to the
model is rewritten), and the **answer comes back in placeholders** — nothing
substitutes them back. The knowledge base and system prompt are not anonymized.

### Users' own documents

With this on, users get a **Documents** link in the chat sidebar: a Markdown
editor to use instead of asking a question. A document is named, tagged and
dated, and from then on travels with every question that user asks that
assistant, as:

```
<document name="Q3 goals" tags="goals, planning" written="2026-10-02">
...what they wrote...
</document>
```

They are **per user and per assistant** — nobody else sees them, not even an
admin, and they never reach another assistant. The prompt states that they are
the user's material and not instructions, so a document that reads like an order
is not followed as one; being prompt-enforced, that is a strong default rather
than a guarantee.

Limits: 20,000 characters per document, 40,000 characters of documents in one
prompt. Past that the **oldest are left out** and the prompt names them, so the
assistant can say a document was not loaded. Deleting a document removes it from
the next question on; it does not rewrite past conversations.

## The chat screen

**Answers are rendered as Markdown**, because models write it whether or not you
ask. The renderer is [`public/markdown.js`](public/markdown.js) — about 200
lines, no dependency. It escapes the text *first* and applies the Markdown rules
to the escaped result, so nothing a model writes can become HTML; a
`javascript:` link, a `<script>` tag and a quote smuggled into a URL all stay
inert, with a test for each. A user's own message is shown exactly as typed.

**Under every answer**: `1,234 in · 567 out · $0.0031`, with reasoning and
cached tokens added when the provider reports them. The cost is OpenRouter's own
figure from the end of the stream, not a price computed from a rate card, so it
already accounts for cache discounts and per-provider pricing. Memory extraction
and compaction are separate calls and are **not** in it, so with those on an
exchange costs more than the line says. No line at all means no usage was
reported — deliberately blank rather than zero.

**A closed strip, "How this chatbot is set up"**, lists the model, language,
effort, sampling, EU routing, anonymization and the feature toggles. It is shown
to every user, not only admins: which model answers, and whether a message is
anonymized or may leave the EU, are things the person typing has a fair claim to
know. Nothing in it is a secret — no key, no system prompt, no user list.

## Deploying

The app is a Docker image with two requirements: **a PostgreSQL database** and
**a persistent volume** for the knowledge bases.

1. Build from the [`Dockerfile`](Dockerfile). Migrations run inside the server
   process at boot, so there is no separate migration step.
2. Provide `DATABASE_URL` pointing at PostgreSQL.
3. Mount a volume at **`/data`**. The database does not live there, but the
   per-assistant knowledge bases do — without it, every document an admin writes
   is gone on the next deploy. The volume arrives owned by root on most hosts;
   [`scripts/entrypoint.sh`](scripts/entrypoint.sh) takes ownership and then
   drops to the unprivileged `node` user.
4. Set the environment (above). The server binds `0.0.0.0` on `PORT`, which
   hosts usually set themselves.
5. Health check: **`/healthz`**.

Any container host works. A [`railway.json`](railway.json) is included for
Railway, which needs no further configuration beyond a Postgres service and a
volume; Fly, Render, Cloud Run, Kubernetes or a plain Docker host need only the
five points above.

Run it locally exactly as a host would:

```bash
docker build -t integrato .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgres://postgres:dev@host.docker.internal:5432/integrato \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  -e ADMIN_EMAILS=you@example.com \
  -e ADMIN_PASSWORD=a-long-password \
  -e EMAIL_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  -e APP_URL=http://localhost:3000 \
  -v "$PWD/data:/data" \
  integrato
```

## When something fails

The chat names the cause instead of showing one generic error:

| Message | What to do |
| --- | --- |
| …too little credit for this request | Add credit at OpenRouter, or lower `MODEL_MAX_TOKENS` |
| The OpenRouter key was rejected | Check `OPENROUTER_API_KEY` |
| …not available, or not from the region… | Pick another model, or switch EU-only routing off |
| …may only use providers in the EU, and this model has none | Pick a model with a European endpoint |
| Too many requests at once | Wait and retry |
| The model provider is unavailable | Retry; the fault is upstream |

If a `:free` model answers but a paid one fails, the key is out of credit — free
models run on an empty balance, paid ones do not. A deployed instance can hold a
different key from your local `.env`. The full provider error is always in the
server log.

`MODEL_MAX_TOKENS` is checked against your *remaining credit*, not just the
model: a large value on a nearly empty account fails with a 402 before the model
runs. A burst of concurrent requests can hit a second, separate 402 for the
in-flight budget, which clears on its own.

**`/admin` shows the OpenRouter balance**, since an empty account is the likeliest
reason answers stop. Two numbers appear and they are not the same thing:
*Remaining* is credits minus spend, which is what a 402 measures; *Key cap* is an
optional spending limit on the key, which can show plenty of headroom while the
account itself is empty. Never read the cap alone.

Free models (`:free`) need no balance, but a *negative* balance blocks them too,
and web search still bills whatever the model costs.

## Security

- Sign-in and session tokens are stored as a SHA-256 hash only. A sign-in link
  works once and expires after `LOGIN_TOKEN_MINUTES`.
- **User email addresses are encrypted at rest** (AES-256-GCM) and looked up
  through an HMAC of the address, both keyed from `EMAIL_ENCRYPTION_KEY`. The key
  is not recoverable — back it up. Addresses still appear in the server log on
  failed sign-ins and mail errors; encrypting the table does not cover logs.
- `ADMIN_PASSWORD` is compared in constant time and never logged. It is shared by
  every address in `ADMIN_EMAILS`, so the audit trail says *which* admin signed
  in but not that they alone knew the password — rotate it when someone stops
  being an admin.
- The login form never reveals whether an address exists and allows 5 attempts
  per 15 minutes, per address and per IP. Submitting an *empty* password does
  reveal whether an address is an admin, which is the price of telling admins to
  use their password rather than wait for an email that never comes.
- Session cookies are `httpOnly` + `sameSite=lax`, and `secure` once `APP_URL`
  is `https://`. A session lasts `SESSION_DAYS` from sign-in and is **not**
  extended by activity. Expiry is checked against the database on every request,
  so a copied cookie stops working too.
- Conversations, memories and documents are walled off per user *and* per
  assistant in the SQL itself, not by a check afterwards.
- The knowledge-base page validates file names **and** checks the resolved path
  against the base directory, so `../` cannot write outside it.
- The server runs as the unprivileged `node` user.
- **A state-changing request must come from this origin.** `Origin` (or
  `Referer`) is checked against the site's own host on every POST and DELETE.
  The session cookie is `sameSite=lax`, which already blocks a cross-*site*
  POST; this closes what SameSite leaves open, since it treats every subdomain
  of one domain as the same site — so a sibling host cannot post with an
  admin's cookie.
- **A strict Content-Security-Policy**: `'self'` for everything, no
  `unsafe-inline`, `frame-ancestors 'none'`, `object-src 'none'`. The app
  fetches nothing from anywhere — self-hosted fonts, no CDN, no inline script or
  `style=` attribute — so the policy needs no escape hatch. It is the second
  line behind the Markdown renderer's escaping. Sent with `nosniff`,
  `X-Frame-Options: DENY` and `Referrer-Policy: same-origin` (nothing is sent
  to another origin, so a sign-in token cannot leave in a Referer).
- **Confirmation prompts carry no code.** A delete confirmation is a
  `data-confirm` attribute read as text, never an `onsubmit` handler — an HTML
  attribute holding JavaScript needs JavaScript escaping, and HTML escaping
  there is a hole rather than a defence.
- **Messages are rate-limited per user** (30 per five minutes), because every
  message spends OpenRouter credit, and users may keep at most 200 documents per
  chatbot. The login form allows 5 attempts per 15 minutes per address and per
  IP. These limits live in memory, so they are per process and reset on restart.
- `.env`, the database and `data/` are gitignored and never enter the image.

## Development

```bash
npm run typecheck && npm test && npm run build
```

`npm test` **needs Docker**: the suite starts one throwaway PostgreSQL container
and runs the real migrations against it, each test getting its own schema. An
in-memory stand-in was rejected because it would accept SQL that PostgreSQL
rejects, which is the one thing these tests exist to catch.

The front end has no build step — `public/` is served as written, so a browser
file can be edited and reloaded. Server-side HTML lives in `src/views.ts` and
goes through `escapeHtml`.

## License

[MIT](LICENSE) © WeirdFishes. Project site: [integrato.cc](https://integrato.cc).

The bundled `instr.md` and `context/` are only seeds for a newly created
assistant; what a deployment actually runs lives on its own volume.
