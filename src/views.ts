import { MAX_WELCOME_LENGTH } from './assistants.js';
import type { Balance } from './balance.js';
import { COMPACT_THRESHOLD } from './compaction.js';
import type { DocumentSummary } from './content.js';
import type { Assistant, User } from './db/repo.js';
import type { ModelOption } from './models.js';
import type { AssistantSettings } from './settings.js';

/**
 * Minimal server-side templating. Every dynamic value goes through escapeHtml;
 * unescaped user input is never placed in the HTML.
 *
 * The pages are built by a factory so the assistant's name (ASSISTANT_NAME)
 * appears everywhere without a module-level global.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface LayoutOptions {
  title: string;
  body: string;
  bodyClass?: string;
  scripts?: string[];
}

/**
 * Changes on every boot, and so on every deploy. Static assets are cached for an
 * hour in production; without a version in the URL a deploy that changes app.js
 * leaves browsers running the previous one against the new API, which surfaces
 * as "Loading failed: Not found".
 */
const ASSET_VERSION = Date.now().toString(36);

function layout({ title, body, bodyClass, scripts = [] }: LayoutOptions): string {
  const scriptTags = scripts
    .map((src) => `<script type="module" src="${src}?v=${ASSET_VERSION}" defer></script>`)
    .join('\n    ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%92%AC%3C/text%3E%3C/svg%3E">
    ${scriptTags}
  </head>
  <body${bodyClass ? ` class="${bodyClass}"` : ''}>
${body}
  </body>
</html>`;
}

export interface NoticeOptions {
  message?: string;
  error?: string;
}

function notice({ message, error }: NoticeOptions): string {
  if (error) return `<p class="notice notice--error" role="alert">${escapeHtml(error)}</p>`;
  if (message) return `<p class="notice notice--ok" role="status">${escapeHtml(message)}</p>`;
  return '';
}

function money(amount: number): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/**
 * Two independent limits, both shown: the account's credits (what a 402
 * actually measures) and the key's own spending cap, which can look healthy
 * while the account is empty.
 */
function balancePanel(balance: Balance | null | undefined): string {
  if (balance === undefined) return '';
  if (balance === null) {
    return `      <section class="panel">
        <h2>OpenRouter balance</h2>
        <p class="muted small">Could not reach OpenRouter. The balance is unavailable; the chatbot itself may still work.</p>
      </section>`;
  }

  const empty = balance.remaining <= 0;
  const low = !empty && balance.remaining < 1;
  const state = empty ? 'balance--empty' : low ? 'balance--low' : 'balance--ok';

  const warning = empty
    ? `<p class="balance__warning">Out of credits — every message will fail with a 402 until you top up.
         <a href="https://openrouter.ai/settings/credits" target="_blank" rel="noopener noreferrer">Add credits</a>.</p>`
    : low
      ? '<p class="balance__warning">Running low.</p>'
      : '';

  const keyLimit =
    balance.limit === null
      ? '<p class="muted small">No spending cap on this key.</p>'
      : `<p class="muted small">Key cap: ${escapeHtml(money(balance.limitRemaining ?? 0))} left of
         ${escapeHtml(money(balance.limit))}${
           balance.limitReset ? ` per ${escapeHtml(balance.limitReset.replace(/ly$/, ''))}` : ''
         }. This is a cap on the key, not money in the account.</p>`;

  return `      <section class="panel">
        <h2>OpenRouter balance</h2>
        <div class="balance ${state}">
          <div class="balance__figure">
            <span class="balance__amount">${escapeHtml(money(balance.remaining))}</span>
            <span class="muted small">remaining</span>
          </div>
          <dl class="balance__detail">
            <dt>Credits added</dt><dd>${escapeHtml(money(balance.totalCredits))}</dd>
            <dt>Spent</dt><dd>${escapeHtml(money(balance.totalUsage))}</dd>
          </dl>
        </div>
        ${warning}
        ${keyLimit}
        ${balance.isFreeTier ? '<p class="muted small">This account is on the free tier.</p>' : ''}
      </section>`;
}

/** e.g. "Anthropic: Claude Opus 5 — 1000K ctx · $5/$25 per Mtok" */
function modelLabel(model: ModelOption): string {
  const parts: string[] = [model.name];
  if (model.contextLength > 0) {
    parts.push(`${Math.round(model.contextLength / 1000)}K ctx`);
  }
  const { inputPricePerMillion: input, outputPricePerMillion: output } = model;
  parts.push(
    input === null && output === null
      ? 'free'
      : `$${(input ?? 0).toFixed(2)}/$${(output ?? 0).toFixed(2)} per Mtok`,
  );
  return parts.join(' — ');
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}

export interface ContentPageOptions extends NoticeOptions {
  /** URL prefix of this assistant's knowledge base, e.g. /admin/assistants/3/content. */
  base: string;
  assistant: Assistant;
}

export interface AssistantPageOptions extends NoticeOptions {
  models?: readonly ModelOption[];
  settings?: AssistantSettings;
  effortLevels?: readonly string[];
  maxSearchResults?: number;
  maxTemperature?: number;
  maxTopP?: number;
  /** Every user, with a tick for those granted this assistant. */
  users?: readonly User[];
  grantedUserIds?: readonly number[];
}

export interface AdminPageOptions extends NoticeOptions {
  /** null when OpenRouter could not be reached. */
  balance?: Balance | null;
  assistants?: readonly Assistant[];
}

export interface ViewOptions {
  /** Product name shown in titles, the sidebar and message labels. */
  readonly assistantName: string;
  /** Language the assistant answers in; mentioned on the prompt editor page. */
  readonly assistantLanguage: string;
}

/** Extra state the login form carries back after a failed attempt. */
export interface LoginPageOptions extends NoticeOptions {
  email?: string;
  /** Puts the cursor in the password field, after an admin left it empty. */
  focusPassword?: boolean;
}

export interface Views {
  loginPage(options?: LoginPageOptions): string;
  linkSentPage(email: string): string;
  /** Assistant list for a signed-in user; only what they may use. */
  pickerPage(user: User, assistants: readonly Assistant[]): string;
  chatPage(user: User, assistant: Assistant, showBackToPicker: boolean): string;
  adminPage(users: readonly User[], currentUser: User, options?: AdminPageOptions): string;
  /** One assistant: its identity, settings and who may use it. */
  assistantPage(assistant: Assistant, options?: AssistantPageOptions): string;
  contentPage(
    documents: readonly DocumentSummary[],
    instructionsChars: number,
    options: ContentPageOptions,
  ): string;
  editorPage(options: {
    heading: string;
    description: string;
    action: string;
    content: string;
    /** Where Cancel and the breadcrumb go back to. */
    base: string;
    notice?: NoticeOptions;
  }): string;
  errorPage(status: number, message: string): string;
}

export function createViews({ assistantName, assistantLanguage }: ViewOptions): Views {
  const name = escapeHtml(assistantName);

  return {
    loginPage(options = {}) {
      // Only an administrator is ever asked for a password, and only after the
      // route has recognised the address they typed. Everyone else sees one
      // field and never learns a password exists.
      const passwordField = options.focusPassword
        ? `        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
        </div>`
        : '';

      return layout({
        title: `Sign in — ${assistantName}`,
        bodyClass: 'centered',
        body: `    <main class="card">
      <h1 class="wordmark">${name}</h1>
      <p class="muted">Enter your email address. If it is on the user list, we will send you a sign-in link.</p>
      ${notice(options)}
      <form method="post" action="/login" class="stack">
        <div class="field">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" autocomplete="email" required
                 inputmode="email" placeholder="you@example.com" value="${escapeHtml(options.email ?? '')}"${
                   options.focusPassword ? '' : ' autofocus'
                 }>
        </div>
${passwordField}
        <button type="submit">Sign in</button>
      </form>
    </main>`,
      });
    },

    linkSentPage(email) {
      return layout({
        title: `Check your inbox — ${assistantName}`,
        bodyClass: 'centered',
        body: `    <main class="card">
      <p class="wordmark wordmark--small">${name}</p>
      <h1>Check your inbox</h1>
      <p class="muted">
        If <strong>${escapeHtml(email)}</strong> is on the user list, a sign-in link is on its way.
        The link can be used once.
      </p>
      <p><a class="link" href="/login">Try another address</a></p>
    </main>`,
      });
    },

    chatPage(user, assistant, showBackToPicker) {
      const label = escapeHtml(assistant.name);
      return layout({
        title: assistant.name,
        scripts: ['/app.js'],
        body: `    <div class="app" data-email="${escapeHtml(user.email)}" data-assistant="${label}"
         data-slug="${escapeHtml(assistant.slug)}"
         data-welcome="${escapeHtml(assistant.welcome)}">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__head">
          <div class="sidebar__brand">
            <span class="brand__assistant">${label}</span>
          </div>
          <button type="button" class="icon-button" id="new-conversation" title="New conversation" aria-label="New conversation">+</button>
        </div>
        <nav class="conversations" id="conversations" aria-label="Conversations"></nav>
        <div class="sidebar__foot">
          <span class="muted small" title="${escapeHtml(user.email)}">${escapeHtml(user.email)}</span>
          <div class="row">
            ${showBackToPicker ? '<a class="link small" href="/">Chatbots</a>' : ''}
            ${user.isAdmin ? '<a class="link small" href="/admin">Admin</a>' : ''}
            <form method="post" action="/logout"><button type="submit" class="link small">Sign out</button></form>
          </div>
        </div>
      </aside>

      <main class="chat">
        <header class="chat__head">
          <button type="button" class="icon-button only-mobile" id="toggle-sidebar" aria-label="Show conversations">☰</button>
          <h1 id="conversation-title">New conversation</h1>
        </header>

        <div class="messages" id="messages" aria-live="polite"></div>

        <form class="composer" id="composer">
          <label class="visually-hidden" for="prompt">Your message</label>
          <textarea id="prompt" name="prompt" rows="1" placeholder="Ask your question…" autocomplete="off"></textarea>
          <button type="submit" id="send" aria-label="Send">Send</button>
        </form>
      </main>
    </div>`,
      });
    },

    pickerPage(user, assistants) {
      const cards =
        assistants.length === 0
          ? `        <p class="muted">You do not have access to a chatbot yet. Ask an administrator to give you access.</p>`
          : `        <ul class="picker">
${assistants
  .map(
    (assistant) => `          <li>
            <a class="picker__card" href="/${escapeHtml(assistant.slug)}">
              <span class="picker__name">${escapeHtml(assistant.name)}</span>
              ${
                assistant.description.length > 0
                  ? `<span class="picker__description">${escapeHtml(assistant.description)}</span>`
                  : ''
              }
            </a>
          </li>`,
  )
  .join('\n')}
        </ul>`;

      return layout({
        title: `Chatbots — ${assistantName}`,
        body: `    <main class="page page--picker">
      <header class="page__head">
        <div class="page__brand">
          <p class="wordmark wordmark--small">${assistantName}</p>
          <h1>Choose a chatbot</h1>
        </div>
        <div class="row">
          ${user.isAdmin ? '<a class="link" href="/admin">Admin</a>' : ''}
          <form method="post" action="/logout"><button type="submit" class="link">Sign out</button></form>
        </div>
      </header>
${cards}
    </main>`,
      });
    },

    adminPage(users, currentUser, options = {}) {
      const rows = users
        .map(
          (user) => `          <tr>
            <td>${escapeHtml(user.email)}</td>
            <td>${user.isAdmin ? 'Admin' : 'User'}</td>
            <td>${escapeHtml(user.lastSeenAt ?? 'never')}</td>
            <td class="actions">${
              user.id === currentUser.id
                ? '<span class="muted small">you</span>'
                : `<form method="post" action="/admin/users/${user.id}/delete" onsubmit="return confirm('Delete ${escapeHtml(
                    user.email,
                  )}? Their conversation history will be removed as well.')"><button type="submit" class="link small danger">Delete</button></form>`
            }</td>
          </tr>`,
        )
        .join('\n');

      const assistants = options.assistants ?? [];
      const assistantRows =
        assistants.length === 0
          ? `          <tr><td colspan="3" class="muted">No chatbots yet. Create the first one below.</td></tr>`
          : assistants
              .map(
                (assistant) => `          <tr>
            <td><a class="link" href="/admin/assistants/${assistant.id}">${escapeHtml(assistant.name)}</a></td>
            <td class="muted small">/${escapeHtml(assistant.slug)}</td>
            <td class="actions">
              <a class="link small" href="/${escapeHtml(assistant.slug)}">Open</a>
              <form method="post" action="/admin/assistants/${assistant.id}/delete"
                    onsubmit="return confirm('Delete ${escapeHtml(
                      assistant.name,
                    )}? Its conversations, memories and settings are removed. The knowledge-base files stay on disk.')"><button type="submit" class="link small danger">Delete</button></form>
            </td>
          </tr>`,
              )
              .join('\n');

      return layout({
        title: `Admin — ${assistantName}`,
        body: `    <main class="page">
      <header class="page__head">
        <h1>Administration</h1>
        <div class="row">
          <a class="link" href="/">← Chatbots</a>
          <form method="post" action="/logout"><button type="submit" class="link">Sign out</button></form>
        </div>
      </header>
      ${notice(options)}

${balancePanel(options.balance)}

      <section class="panel">
        <h2>Chatbots</h2>
        <p class="muted small">Each chatbot has its own knowledge base, settings and users.</p>
        <table class="table">
          <thead><tr><th>Name</th><th>Address</th><th></th></tr></thead>
          <tbody>
${assistantRows}
          </tbody>
        </table>

        <form method="post" action="/admin/assistants" class="row row--form">
          <label class="visually-hidden" for="new-assistant">Name</label>
          <input id="new-assistant" name="name" type="text" required placeholder="New chatbot name">
          <button type="submit" class="secondary">Create</button>
        </form>
      </section>

      <section class="panel">
        <h2>Users</h2>
        <p class="muted small">Admins may use every chatbot. Other users are granted access per chatbot.</p>
        <form method="post" action="/admin/users" class="row row--form">
          <label class="visually-hidden" for="new-email">Email address</label>
          <input id="new-email" name="email" type="email" required placeholder="new@example.com">
          <label class="checkbox"><input type="checkbox" name="is_admin" value="1"> Admin</label>
          <button type="submit" class="secondary">Add</button>
        </form>

        <table class="table">
          <thead>
            <tr><th>Email</th><th>Role</th><th>Last seen</th><th></th></tr>
          </thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </section>
    </main>`,
      });
    },

    assistantPage(assistant, options = {}) {
      const settings = options.settings;
      const models = options.models ?? [];
      const selected = settings?.model ?? '';
      const granted = new Set(options.grantedUserIds ?? []);

      const modelField =
        models.length === 0
          ? `<input id="model" name="model" type="text" required value="${escapeHtml(selected)}"
             placeholder="anthropic/claude-opus-5">
             <p class="muted small">The model list could not be loaded — enter an OpenRouter model id by hand.</p>`
          : `<select id="model" name="model" required>
${models
  .map(
    (model) => `            <option value="${escapeHtml(model.id)}"${
      model.id === selected ? ' selected' : ''
    }>${escapeHtml(modelLabel(model))}</option>`,
  )
  .join('\n')}
            </select>`;

      const effortField = `<select id="effort" name="effort">
${(options.effortLevels ?? [])
  .map(
    (level) => `            <option value="${escapeHtml(level)}"${
      level === settings?.effort ? ' selected' : ''
    }>${escapeHtml(level)}</option>`,
  )
  .join('\n')}
            </select>`;

      /*
       * A model that supports neither knob is worth saying out loud: the
       * fields would otherwise look like they had been ignored.
       */
      const chosen = models.find((model) => model.id === selected);
      const samplingWarning =
        chosen && !chosen.supportsSampling
          ? ' <strong>This model accepts neither setting</strong> — both are ignored for it.'
          : '';

      const userRows = (options.users ?? [])
        .map(
          (user) => `          <tr>
            <td>${escapeHtml(user.email)}</td>
            <td>${
              user.isAdmin
                ? '<span class="muted small">admin — always allowed</span>'
                : `<label class="checkbox"><input type="checkbox" name="user" value="${user.id}"${
                    granted.has(user.id) ? ' checked' : ''
                  }> may use this chatbot</label>`
            }</td>
          </tr>`,
        )
        .join('\n');

      return layout({
        title: `${assistant.name} — admin`,
        body: `    <main class="page">
      <header class="page__head">
        <h1>${escapeHtml(assistant.name)}</h1>
        <div class="row">
          <a class="link" href="/admin/assistants/${assistant.id}/content">Knowledge base</a>
          <a class="link" href="/${escapeHtml(assistant.slug)}">Open chat</a>
          <a class="link" href="/admin">← Admin</a>
        </div>
      </header>
      ${notice(options)}

      <section class="panel">
        <h2>Identity</h2>
        <form method="post" action="/admin/assistants/${assistant.id}" class="settings">
          <div class="field">
            <label for="name">Name</label>
            <input id="name" name="name" type="text" required value="${escapeHtml(assistant.name)}">
          </div>
          <div class="field">
            <label for="description">Description</label>
            <input id="description" name="description" type="text"
                   value="${escapeHtml(assistant.description)}" placeholder="Shown on the assistant picker">
          </div>
          <div class="field">
            <label for="language">Answer language</label>
            <input id="language" name="language" type="text" required value="${escapeHtml(assistant.language)}">
          </div>
          <div class="field">
            <label for="welcome">Welcome message</label>
            <textarea id="welcome" name="welcome" rows="4" maxlength="${MAX_WELCOME_LENGTH}"
                      placeholder="Ask your first question — answers are based on the supplied context."
                      >${escapeHtml(assistant.welcome)}</textarea>
            <p class="muted small">Shown in an empty conversation, at most ${MAX_WELCOME_LENGTH} characters. Leave it empty for the default sentence.</p>
          </div>
          <p class="muted small">Address: <code>/${escapeHtml(assistant.slug)}</code> — fixed once created.</p>
          <button type="submit">Save identity</button>
        </form>
      </section>

      <section class="panel">
        <h2>Chatbot settings</h2>
        <p class="muted small">Applies to this chatbot only, from the next message on.</p>
        <form method="post" action="/admin/assistants/${assistant.id}/settings" class="settings">

          <div class="field">
            <label for="model">Model</label>
            ${modelField}
            ${
              settings?.euOnly
                ? '<p class="muted small">Only models OpenRouter can serve from the EU are listed, because this chatbot is restricted to European providers.</p>'
                : ''
            }
          </div>

          <div class="field">
            <label for="effort">Reasoning effort</label>
            ${effortField}
            <p class="muted small">Deeper reasoning costs more and answers slower. Models without reasoning support ignore this.</p>
          </div>

          <label class="checkbox">
            <input type="checkbox" name="show_thinking" value="1"${settings?.showThinking ? ' checked' : ''}>
            Show the model's thinking above the answer
          </label>

          <hr>

          <div class="field">
            <label for="temperature">Temperature</label>
            <input id="temperature" name="temperature" type="number" step="0.05"
                   min="0" max="${options.maxTemperature ?? 2}"
                   value="${settings?.temperature ?? ''}" placeholder="model default">
            <p class="muted small">How freely the model picks its words: low is predictable, high is inventive. Leave it empty to use the model's own default.</p>
          </div>

          <div class="field">
            <label for="top_p">Top-P</label>
            <input id="top_p" name="top_p" type="number" step="0.05"
                   min="0" max="${options.maxTopP ?? 1}"
                   value="${settings?.topP ?? ''}" placeholder="model default">
            <p class="muted small">Narrows the words it may choose from. Usually you set this <em>or</em> the temperature, not both.${samplingWarning}</p>
          </div>

          <hr>

          <label class="checkbox">
            <input type="checkbox" name="web_search" value="1"${settings?.webSearch ? ' checked' : ''}>
            Web search
          </label>
          <p class="muted small">Lets the chatbot look things up beyond the knowledge base. Billed per search on top of the model.</p>

          <div class="field">
            <label for="web_search_max_results">Results per search</label>
            <input id="web_search_max_results" name="web_search_max_results" type="number"
                   min="1" max="${options.maxSearchResults ?? 20}" value="${settings?.webSearchMaxResults ?? 5}">
          </div>

          <div class="field">
            <label for="web_search_include_domains">Only these domains</label>
            <textarea id="web_search_include_domains" name="web_search_include_domains" rows="3"
                      placeholder="example.com&#10;*.gov.uk">${escapeHtml(
                        (settings?.webSearchIncludeDomains ?? []).join('\n'),
                      )}</textarea>
            <p class="muted small">One per line. Leave empty to search the whole web. Wildcards allowed (<code>*.substack.com</code>).</p>
          </div>

          <div class="field">
            <label for="web_search_exclude_domains">Never these domains</label>
            <textarea id="web_search_exclude_domains" name="web_search_exclude_domains" rows="3"
                      placeholder="reddit.com">${escapeHtml(
                        (settings?.webSearchExcludeDomains ?? []).join('\n'),
                      )}</textarea>
            <p class="muted small">Ignored when the list above is filled in — some search engines accept only one of the two.</p>
          </div>

          <hr>

          <label class="checkbox">
            <input type="checkbox" name="eu_only" value="1"${settings?.euOnly ? ' checked' : ''}>
            Only use providers in the EU
          </label>
          <p class="muted small">Restricts every request to endpoints served from an EU or EEA data centre, and forbids falling back to any other. The model list above then shows only models that have one.</p>

          <label class="checkbox">
            <input type="checkbox" name="anonymize" value="1"${settings?.anonymize ? ' checked' : ''}>
            Anonymize messages before sending them
          </label>
          <p class="muted small">Replaces email addresses, phone numbers, IBANs, card numbers, BSNs, IP addresses and Dutch postcodes with placeholders (<code>&lt;IBAN_1&gt;</code>) before a message leaves. The original stays stored here, and the answer comes back written in terms of the placeholders.</p>
          <p class="muted small"><strong>It does not catch names.</strong> Recognizing a name needs a language model, which this runs without on purpose — every rule here is a pattern with a checksum, so it is exact about what it does find.</p>

          <hr>

          <label class="checkbox">
            <input type="checkbox" name="memory" value="1"${settings?.memory ? ' checked' : ''}>
            Remember users across conversations
          </label>
          <p class="muted small">Facts are remembered per user <em>and</em> per chatbot, so nothing crosses between chatbots.</p>

          <label class="checkbox">
            <input type="checkbox" name="citations" value="1"${settings?.citations ? ' checked' : ''}>
            Cite knowledge-base documents
          </label>
          <p class="muted small">The chatbot marks which document a statement came from, like [Guidelines.md].</p>

          <label class="checkbox">
            <input type="checkbox" name="compaction" value="1"${settings?.compaction ? ' checked' : ''}>
            Summarize long conversations
          </label>
          <p class="muted small">Past ${COMPACT_THRESHOLD} messages the oldest are folded into a summary instead of being dropped.</p>

          <button type="submit">Save settings</button>
        </form>
      </section>

      <section class="panel">
        <h2>Who may use this chatbot</h2>
        <form method="post" action="/admin/assistants/${assistant.id}/users">
          <table class="table">
            <thead><tr><th>Email</th><th>Access</th></tr></thead>
            <tbody>
${userRows}
            </tbody>
          </table>
          <button type="submit">Save access</button>
        </form>
      </section>

      <section class="panel">
        <h2>Delete</h2>
        <p class="muted small">Removes this chatbot with every conversation, memory and setting belonging to it. Its knowledge-base files stay on disk.</p>
        <form method="post" action="/admin/assistants/${assistant.id}/delete"
              onsubmit="return confirm('Delete ${escapeHtml(assistant.name)} and all its conversations?')">
          <button type="submit" class="danger">Delete this chatbot</button>
        </form>
      </section>
    </main>`,
      });
    },


    contentPage(documents, instructionsChars, options) {
      const base = options.base;
      const rows =
        documents.length === 0
          ? `          <tr><td colspan="4" class="muted">No documents yet. Create one or upload a .md file.</td></tr>`
          : documents
              .map(
                (doc) => `          <tr>
            <td><a class="link" href="${base}/edit?name=${encodeURIComponent(doc.name)}">${escapeHtml(
              doc.name,
            )}</a></td>
            <td><code>{Global.${escapeHtml(doc.placeholder)}}</code></td>
            <td class="muted small">${formatBytes(doc.sizeBytes)} · ${escapeHtml(doc.modifiedAt)}</td>
            <td class="actions"><form method="post" action="${base}/delete" onsubmit="return confirm('Permanently delete ${escapeHtml(
              doc.name,
            )}?')"><input type="hidden" name="name" value="${escapeHtml(
              doc.name,
            )}"><button type="submit" class="link small danger">Delete</button></form></td>
          </tr>`,
              )
              .join('\n');

      return layout({
        title: `Knowledge base — ${options.assistant.name}`,
        scripts: ['/upload.js'],
        body: `    <main class="page" data-upload="${escapeHtml(base)}/upload" data-base="${escapeHtml(base)}">
      <header class="page__head">
        <h1>Knowledge base — ${escapeHtml(options.assistant.name)}</h1>
        <div class="row">
          <a class="link" href="/admin/assistants/${options.assistant.id}">← ${escapeHtml(
            options.assistant.name,
          )}</a>
          <a class="link" href="/admin">Admin</a>
        </div>
      </header>
      ${notice(options)}

      <section class="panel">
        <div class="row row--between">
          <div>
            <h2>Base prompt</h2>
            <p class="muted small">instr.md — defines who ${name} is and how it works. ${instructionsChars} characters.</p>
          </div>
          <a class="link" href="${base}/instructions">Edit</a>
        </div>
      </section>

      <section class="panel">
        <h2>Context documents</h2>
        <p class="muted small">
          Every document is sent along as knowledge base with each question. Use the placeholder to insert a
          document at a specific spot in the base prompt; documents without a placeholder are appended at
          the end.
        </p>
        <table class="table">
          <thead><tr><th>File</th><th>Placeholder</th><th>Size · modified</th><th></th></tr></thead>
          <tbody>
${rows}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>Add</h2>
        <form method="post" action="${base}/new" class="row row--form">
          <label class="visually-hidden" for="new-name">File name</label>
          <input id="new-name" name="name" type="text" required placeholder="Guidelines.md"
                 pattern="[A-Za-z0-9_-]{1,64}\\.md">
          <button type="submit" class="secondary">New document</button>
        </form>

        <form method="post" action="${base}/upload" id="upload-form" class="stack">
          <label for="upload">Or upload existing .md files</label>
          <input id="upload" type="file" accept=".md,text/markdown" multiple>
          <p class="muted small" id="upload-status" role="status"></p>
        </form>
      </section>
    </main>`,
      });
    },

    editorPage(options) {
      return layout({
        title: `${options.heading} — ${assistantName}`,
        body: `    <main class="page">
      <header class="page__head">
        <h1>${escapeHtml(options.heading)}</h1>
        <a class="link" href="${options.base}">← Back to the knowledge base</a>
      </header>
      <p class="muted small">${escapeHtml(options.description)}</p>
      ${notice(options.notice ?? {})}

      <form method="post" action="${escapeHtml(options.action)}" class="stack">
        <label class="visually-hidden" for="content">Content</label>
        <textarea id="content" name="content" class="editor" spellcheck="false">${escapeHtml(
          options.content,
        )}</textarea>
        <div class="row">
          <button type="submit">Save</button>
          <a class="link" href="${options.base}">Cancel</a>
        </div>
      </form>
    </main>`,
      });
    },

    errorPage(status, message) {
      return layout({
        title: `${status} — ${assistantName}`,
        bodyClass: 'centered',
        body: `    <main class="card">
      <h1>${status}</h1>
      <p class="muted">${escapeHtml(message)}</p>
      <p><a class="link" href="/">Back to the chat</a></p>
    </main>`,
      });
    },
  };
}

/** Description shown above the instr.md editor; mentions the automatic language rule. */
export function instructionsDescription({ assistantName, assistantLanguage }: ViewOptions): string {
  return (
    `This is instr.md, the system prompt for ${assistantName}. The rule "always answer in ${assistantLanguage}" ` +
    'is added automatically. A placeholder such as {Global.Guidelines} is replaced by the context document Guidelines.md.'
  );
}
