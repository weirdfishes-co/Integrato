/**
 * Chat frontend. Vanilla ES module, no build step.
 * Answers arrive as Server-Sent Events over a POST request, so we read the
 * body stream ourselves instead of using EventSource (which only does GET).
 */

const els = {
  conversations: document.getElementById('conversations'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  title: document.getElementById('conversation-title'),
  totals: document.getElementById('conversation-totals'),
  newConversation: document.getElementById('new-conversation'),
  sidebar: document.getElementById('sidebar'),
  toggleSidebar: document.getElementById('toggle-sidebar'),
  recording: document.getElementById('recording'),
  recordingName: document.getElementById('recording-name'),
};

/** Label above assistant messages; set server-side from ASSISTANT_NAME. */
const assistantName = document.querySelector('.app')?.dataset.assistant || 'Assistant';
/** Every API call is scoped to the assistant this page belongs to. */
const assistantSlug = document.querySelector('.app')?.dataset.slug || '';
const apiBase = `/api/${encodeURIComponent(assistantSlug)}`;
/*
 * The renderer is imported with the page's asset version, because a plain
 * `import './markdown.js'` would be cached under one URL for an hour in
 * production — the same trap that once left browsers running an old app.js
 * against new routes. The version is on the element rather than the import
 * because a static file cannot template itself.
 */
const assetVersion = document.querySelector('.app')?.dataset.version ?? '';
const { renderMarkdown } = await import(`./markdown.js?v=${assetVersion}`);
const { usageLine, totalsLine } = await import(`./format.js?v=${assetVersion}`);

/*
 * What this chatbot does, from the page. 'audio' means the composer sends a
 * recording and the textarea is only an optional instruction.
 */
const accepts = document.querySelector('.app')?.dataset.accepts ?? 'text';

/** Set per chatbot on its admin page; empty falls back to the sentence below. */
const welcomeMessage =
  document.querySelector('.app')?.dataset.welcome?.trim() ||
  'This is an AI bot. It can be wrong or miss context, so treat answers as a starting point and use your own judgment before acting on anything important.';

const state = {
  conversations: [],
  activeId: null,
  busy: false,
  /** Only what the running totals need: one entry per message, usage or null. */
  messages: [],
};

// ---------- API ----------

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...options,
  });

  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
}

// ---------- rendering ----------

function renderConversations() {
  els.conversations.replaceChildren();

  for (const conversation of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conversation';
    item.setAttribute('aria-current', String(conversation.id === state.activeId));

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'conversation__open';
    // Shortened for the narrow sidebar; the full title stays in the tooltip.
    open.textContent = shortenTitle(conversation.title);
    open.title = conversation.title;
    open.addEventListener('click', () => {
      void openConversation(conversation.id);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'conversation__delete';
    remove.textContent = '×';
    remove.title = 'Delete conversation';
    remove.setAttribute('aria-label', `Delete conversation "${conversation.title}"`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      void deleteConversation(conversation);
    });

    item.append(open, remove);
    els.conversations.append(item);
  }
}

/** Longest conversation title the sidebar shows before an ellipsis. */
const MAX_TITLE_CHARS = 40;

function shortenTitle(title) {
  if (title.length <= MAX_TITLE_CHARS) return title;
  return `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * Puts text in a message body, as Markdown or as typed.
 *
 * Only the model's answers are Markdown. The user's own message is shown
 * exactly as they wrote it — running it through a renderer would mean their
 * asterisks disappear and their indentation moves — and so is an error, which
 * is our sentence and not the model's.
 */
function setBody(body, text, { markdown }) {
  body.classList.toggle('message__body--rich', markdown);
  if (markdown) {
    body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text;
  }
}

function addMessage(role, text, options = {}) {
  const wrapper = document.createElement('article');
  wrapper.className = `message message--${role}${options.error ? ' message--error' : ''}`;

  const label = document.createElement('span');
  label.className = 'message__role';
  label.textContent = role === 'user' ? 'You' : assistantName;

  const body = document.createElement('div');
  body.className = 'message__body';
  setBody(body, text, { markdown: role === 'assistant' && !options.error });

  wrapper.append(label, body);
  if (options.usage) renderUsage(wrapper, options.usage);
  if (options.media) renderMedia(wrapper, options.media);
  els.messages.append(wrapper);
  scrollToBottom();
  return body;
}

/**
 * What the answer cost, under the answer.
 *
 * Only what the provider reported for this one call. Memory extraction and
 * compaction are separate calls billed separately, and are not in this figure —
 * see the README.
 */
function renderUsage(wrapper, usage) {
  if (!usage) return;

  let line = wrapper.querySelector('.usage');
  if (!line) {
    line = document.createElement('p');
    line.className = 'usage';
    wrapper.append(line);
  }

  line.textContent = usageLine(usage);
  line.title = 'Tokens and cost for this answer, as the provider reported them';
}

/** The conversation so far, in the setup strip. Empty until something is known. */
function renderTotals() {
  if (els.totals) els.totals.textContent = totalsLine(state.messages);
}

/**
 * The model's reasoning, in a collapsed <details> above the answer so it never
 * competes with the answer itself.
 */
function renderThinking(wrapper, text) {
  let block = wrapper.querySelector('.thinking');
  if (!block) {
    block = document.createElement('details');
    block.className = 'thinking';
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking';
    const body = document.createElement('div');
    body.className = 'thinking__body';
    block.append(summary, body);
    wrapper.querySelector('.message__body').before(block);
  }
  block.querySelector('.thinking__body').textContent = text;
}

/**
 * What the model produced, under the answer: a picture it drew, or speech.
 *
 * Referenced by url, never inlined — the server keeps the bytes and serves them
 * behind the same ownership check as the conversation, so a megabyte is fetched
 * once by the browser and cached rather than carried in every reload of the
 * conversation. The mime type decides which element it becomes; the server does
 * not need a second field to say so.
 */
function renderMedia(wrapper, media) {
  if (!media || media.length === 0) return;
  if (wrapper.querySelector('.answer-media')) return;

  const list = document.createElement('div');
  list.className = 'answer-media';
  for (const file of media) {
    if ((file.mimeType ?? '').startsWith('audio/')) {
      const player = document.createElement('audio');
      player.className = 'answer-audio';
      player.src = file.url;
      player.controls = true;
      // Never autoplay: a voice starting by itself is startling, and a browser
      // would block it anyway without a gesture.
      player.preload = 'metadata';
      list.append(player);
    } else {
      const picture = document.createElement('img');
      picture.className = 'answer-image';
      picture.src = file.url;
      picture.alt = 'Generated image';
      picture.loading = 'lazy';
      list.append(picture);
    }
  }
  wrapper.append(list);
  scrollToBottom();
}

/** Web pages the model consulted, listed under the answer. */
function renderSources(wrapper, sources) {
  if (wrapper.querySelector('.sources')) return;

  const list = document.createElement('ul');
  list.className = 'sources';
  for (const source of sources) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = source.url;
    link.textContent = source.title || source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.append(link);
    list.append(item);
  }
  wrapper.append(list);
}

function showEmptyState() {
  els.messages.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = welcomeMessage;
  els.messages.append(empty);
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.prompt.disabled = busy;
  if (!busy) els.prompt.focus();
}

function closeSidebarOnMobile() {
  els.sidebar.classList.remove('is-open');
}

// ---------- actions ----------

async function loadConversations() {
  const data = await api(`${apiBase}/conversations`);
  state.conversations = data.conversations;
  renderConversations();
  return state.conversations;
}

async function openConversation(id) {
  const data = await api(`${apiBase}/conversations/${id}`);
  state.activeId = data.conversation.id;
  els.title.textContent = data.conversation.title;
  els.messages.replaceChildren();

  state.messages = data.messages.map((message) => ({ usage: message.usage ?? null }));

  if (data.messages.length === 0) {
    showEmptyState();
  } else {
    for (const message of data.messages) {
      addMessage(message.role, message.content, {
        usage: message.usage,
        media: message.media,
      });
    }
  }

  renderTotals();
  renderConversations();
  closeSidebarOnMobile();
  els.prompt.focus();
}

async function createConversation() {
  const data = await api(`${apiBase}/conversations`, { method: 'POST' });
  state.conversations.unshift(data.conversation);
  state.activeId = data.conversation.id;
  els.title.textContent = data.conversation.title;
  state.messages = [];
  renderTotals();
  showEmptyState();
  renderConversations();
  closeSidebarOnMobile();
  els.prompt.focus();
  return data.conversation;
}

async function deleteConversation(conversation) {
  if (!window.confirm(`Delete "${conversation.title}"?`)) return;

  await api(`${apiBase}/conversations/${conversation.id}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter((item) => item.id !== conversation.id);

  if (state.activeId === conversation.id) {
    state.activeId = null;
    if (state.conversations.length > 0) {
      await openConversation(state.conversations[0].id);
      return;
    }
    await createConversation();
    return;
  }
  renderConversations();
}

/** Reads the SSE stream and calls the handler for each event. */
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      let event = 'message';
      const dataLines = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length === 0) continue;

      try {
        onEvent(event, JSON.parse(dataLines.join('\n')));
      } catch {
        // Incomplete or unreadable event: skip it instead of breaking the stream.
      }
    }
  }
}

/*
 * The server caps the base64 at 8 MB, which is about six megabytes of file.
 * Checked here as well so a long recording is refused before it is read into
 * memory and sent, rather than after.
 */
const MAX_RECORDING_BYTES = 6 * 1024 * 1024;

/** A chosen file as base64 without the data: prefix, plus its format. */
async function readRecording(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  // In chunks: btoa on one huge string blows the argument limit.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const extension = (file.name.split('.').pop() ?? '').toLowerCase();
  // The server validates this too; mp4 and x-m4a both arrive as m4a in practice.
  const format = extension === 'mp4' ? 'm4a' : extension;
  return { data: btoa(binary), format };
}

async function sendPrompt(text) {
  if (!state.activeId) await createConversation();

  els.messages.querySelector('.empty-state')?.remove();

  const file = accepts === 'audio' ? (els.recording?.files?.[0] ?? null) : null;
  if (accepts === 'audio' && !file) {
    addMessage('assistant', 'Choose a recording first.', { error: true });
    return;
  }
  if (file && file.size > MAX_RECORDING_BYTES) {
    addMessage('assistant', 'That recording is too large — about 6 MB is the limit.', {
      error: true,
    });
    return;
  }

  // What the user sees of their own turn: the file they sent, plus anything
  // they typed alongside it.
  addMessage('user', file ? [file.name, text].filter(Boolean).join(' — ') : text);
  // A user's own message has no usage of its own; it is recorded so the running
  // total counts the same messages the screen shows.
  state.messages.push({ usage: null });

  const answerBody = addMessage('assistant', '');
  answerBody.classList.add('typing');
  setBusy(true);

  try {
    const response = await fetch(`${apiBase}/conversations/${state.activeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: text,
        ...(file ? { audio: await readRecording(file) } : {}),
      }),
    });

    if (response.status === 401) {
      window.location.href = '/login';
      return;
    }
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? 'Sending failed.');
    }

    let answer = '';
    let thinking = '';
    const sources = [];
    await readEvents(response, (event, data) => {
      if (event === 'delta') {
        answer += data.text;
        // Re-rendered from the whole answer each time rather than appended to:
        // a chunk can arrive in the middle of `**bold**`, and only the full
        // text says whether that marker has found its partner yet.
        setBody(answerBody, answer, { markdown: true });
        scrollToBottom();
      } else if (event === 'thinking') {
        thinking += data.text;
        renderThinking(answerBody.parentElement, thinking);
        scrollToBottom();
      } else if (event === 'source') {
        sources.push(data);
      } else if (event === 'media') {
        renderMedia(answerBody.parentElement, data.media);
      } else if (event === 'done') {
        if (sources.length > 0) renderSources(answerBody.parentElement, sources);
        if (data.usage) {
          renderUsage(answerBody.parentElement, data.usage);
          state.messages.push({ usage: data.usage });
          renderTotals();
        }
      } else if (event === 'title') {
        els.title.textContent = data.title;
        const conversation = state.conversations.find((item) => item.id === state.activeId);
        if (conversation) {
          conversation.title = data.title;
          renderConversations();
        }
      } else if (event === 'error') {
        answerBody.parentElement.classList.add('message--error');
        setBody(answerBody, data.message, { markdown: false });
      }
    });

    /*
     * An image model often returns a picture and no caption at all, and a
     * speaking one returns audio — both are perfectly good answers, so
     * "nothing came back" has to mean no text *and* nothing produced.
     */
    const rendered = answerBody.parentElement?.querySelector('.answer-media');
    if (answer.length === 0 && answerBody.textContent.length === 0 && !rendered) {
      answerBody.parentElement.classList.add('message--error');
      setBody(answerBody, 'No answer received. Please try again.', { markdown: false });
    }
  } catch (error) {
    answerBody.parentElement.classList.add('message--error');
    setBody(answerBody, error.message, { markdown: false });
  } finally {
    answerBody.classList.remove('typing');
    setBusy(false);
    scrollToBottom();
    if (els.recording) {
      els.recording.value = '';
      if (els.recordingName) els.recordingName.textContent = '';
    }
  }
}

// ---------- events ----------

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.prompt.value.trim();
  // A recording is the message for a speech-to-text chatbot, so an empty
  // textarea is not an empty turn there.
  const hasRecording = accepts === 'audio' && Boolean(els.recording?.files?.length);
  if ((text.length === 0 && !hasRecording) || state.busy) return;
  els.prompt.value = '';
  els.prompt.style.height = 'auto';
  void sendPrompt(text);
});

// The file input is hidden behind a label, so the chosen name is shown by hand.
els.recording?.addEventListener('change', () => {
  const file = els.recording.files?.[0];
  if (els.recordingName) els.recordingName.textContent = file ? file.name : '';
});

els.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.prompt.addEventListener('input', () => {
  els.prompt.style.height = 'auto';
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 200)}px`;
});

els.newConversation.addEventListener('click', () => {
  void createConversation();
});

els.toggleSidebar?.addEventListener('click', () => {
  els.sidebar.classList.toggle('is-open');
});

// ---------- start ----------

(async function init() {
  try {
    const conversations = await loadConversations();
    if (conversations.length > 0) {
      await openConversation(conversations[0].id);
    } else {
      await createConversation();
    }
  } catch (error) {
    showEmptyState();
    addMessage('assistant', `Loading failed: ${error.message}`, { error: true });
  }
})();
