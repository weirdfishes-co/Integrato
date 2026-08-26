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
  newConversation: document.getElementById('new-conversation'),
  sidebar: document.getElementById('sidebar'),
  toggleSidebar: document.getElementById('toggle-sidebar'),
};

/** Label above assistant messages; set server-side from ASSISTANT_NAME. */
const assistantName = document.querySelector('.app')?.dataset.assistant || 'Assistant';
/** Every API call is scoped to the assistant this page belongs to. */
const assistantSlug = document.querySelector('.app')?.dataset.slug || '';
const apiBase = `/api/a/${encodeURIComponent(assistantSlug)}`;

const state = {
  conversations: [],
  activeId: null,
  busy: false,
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
    open.textContent = conversation.title;
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

function addMessage(role, text, options = {}) {
  const wrapper = document.createElement('article');
  wrapper.className = `message message--${role}${options.error ? ' message--error' : ''}`;

  const label = document.createElement('span');
  label.className = 'message__role';
  label.textContent = role === 'user' ? 'You' : assistantName;

  const body = document.createElement('div');
  body.className = 'message__body';
  body.textContent = text;

  wrapper.append(label, body);
  els.messages.append(wrapper);
  scrollToBottom();
  return body;
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
  empty.textContent = 'Ask your first question — answers are based on the supplied context.';
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

  if (data.messages.length === 0) {
    showEmptyState();
  } else {
    for (const message of data.messages) {
      addMessage(message.role, message.content);
    }
  }

  renderConversations();
  closeSidebarOnMobile();
  els.prompt.focus();
}

async function createConversation() {
  const data = await api(`${apiBase}/conversations`, { method: 'POST' });
  state.conversations.unshift(data.conversation);
  state.activeId = data.conversation.id;
  els.title.textContent = data.conversation.title;
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

async function sendPrompt(text) {
  if (!state.activeId) await createConversation();

  els.messages.querySelector('.empty-state')?.remove();
  addMessage('user', text);

  const answerBody = addMessage('assistant', '');
  answerBody.classList.add('typing');
  setBusy(true);

  try {
    const response = await fetch(`${apiBase}/conversations/${state.activeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: text }),
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
        answerBody.textContent = answer;
        scrollToBottom();
      } else if (event === 'thinking') {
        thinking += data.text;
        renderThinking(answerBody.parentElement, thinking);
        scrollToBottom();
      } else if (event === 'source') {
        sources.push(data);
      } else if (event === 'done') {
        if (sources.length > 0) renderSources(answerBody.parentElement, sources);
      } else if (event === 'title') {
        els.title.textContent = data.title;
        const conversation = state.conversations.find((item) => item.id === state.activeId);
        if (conversation) {
          conversation.title = data.title;
          renderConversations();
        }
      } else if (event === 'error') {
        answerBody.parentElement.classList.add('message--error');
        answerBody.textContent = data.message;
      }
    });

    if (answer.length === 0 && answerBody.textContent.length === 0) {
      answerBody.parentElement.classList.add('message--error');
      answerBody.textContent = 'No answer received. Please try again.';
    }
  } catch (error) {
    answerBody.parentElement.classList.add('message--error');
    answerBody.textContent = error.message;
  } finally {
    answerBody.classList.remove('typing');
    setBusy(false);
    scrollToBottom();
  }
}

// ---------- events ----------

els.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.prompt.value.trim();
  if (text.length === 0 || state.busy) return;
  els.prompt.value = '';
  els.prompt.style.height = 'auto';
  void sendPrompt(text);
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
