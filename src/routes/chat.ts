import { Router } from 'express';

import { createAssistantResolver } from './access.js';
import type { Auth } from '../auth.js';
import { assistantPaths } from '../assistants.js';
import { compactConversation, historyWithSummary } from '../compaction.js';
import type { Config } from '../config.js';
import { buildSystemPrompt } from '../context.js';
import type { MessageUsage, Repo } from '../db/repo.js';
import type { ChatClient, ChatTurn, GeneratedMedia, SourceLink } from '../llm.js';
import { ChatRefusalError, describeChatError } from '../llm.js';
import { logger } from '../logger.js';
import { memorySection, rememberExchange } from '../memory.js';
import { notesSection } from '../notes.js';
import { createRateLimiter } from '../rate-limit.js';
import { loadSettings } from '../settings.js';
import type { Views } from '../views.js';

const MAX_PROMPT_CHARS = 20_000;
/*
 * A recording arrives base64-encoded inside the JSON body, which is about a
 * third larger than the file itself. 8 MB of base64 is roughly a six-megabyte
 * upload: some minutes of speech at a sane bitrate.
 */
const MAX_AUDIO_BASE64 = 8 * 1024 * 1024;
/** Gated here; the provider has the final say on what it can read. */
const AUDIO_FORMATS = new Set(['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'webm']);
/*
 * A ceiling on messages per user. Not abuse protection so much as cost
 * protection: every message spends OpenRouter credit, and without a limit one
 * signed-in account — or one left open on a shared machine, or one script — can
 * drain the balance as fast as the model streams. Generous for a person typing:
 * 30 messages inside five minutes is a message every ten seconds, sustained.
 */
const MESSAGES_PER_WINDOW = 30;
const MESSAGE_WINDOW_MS = 5 * 60 * 1000;
/** Number of earlier messages sent along to the model as memory. */
const HISTORY_LIMIT = 40;
/** Title of a conversation that has not had its first message yet. */
const UNTITLED = 'New conversation';

export interface ChatRouteDeps {
  config: Config;
  repo: Repo;
  auth: Auth;
  chat: ChatClient;
  views: Views;
}

/**
 * The recording from the request body: `null` when there is none, and the
 * string `'invalid'` when there is one but it will not do — the caller tells
 * those apart, because "you forgot to attach something" and "that file is no
 * good" are different sentences to read.
 */
function readAudio(body: unknown): { data: string; format: string } | null | 'invalid' {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as Record<string, unknown>).audio;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return 'invalid';

  const { data, format } = raw as Record<string, unknown>;
  if (typeof data !== 'string' || data.length === 0) return 'invalid';
  if (typeof format !== 'string' || !AUDIO_FORMATS.has(format.toLowerCase())) return 'invalid';
  // Base64 and nothing else: it is passed through to the provider verbatim.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return 'invalid';

  return { data, format: format.toLowerCase() };
}

/** The same turns, with the recording attached to the most recent one. */
function withAudio(
  history: readonly ChatTurn[],
  audio: { data: string; format: string },
): ChatTurn[] {
  const turns = [...history];
  const last = turns.length - 1;
  if (last >= 0 && turns[last]) turns[last] = { ...turns[last], audio };
  return turns;
}

function parseId(value: unknown): number | null {
  const id = Number.parseInt(String(value), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The first line of the first message becomes the conversation title. */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split('\n')[0] ?? '';
  const title = firstLine.slice(0, 60).trim();
  return title.length > 0 ? title : UNTITLED;
}

export function createChatRouter({ config, repo, auth, chat, views }: ChatRouteDeps): Router {
  const router = Router();
  const messageLimiter = createRateLimiter(MESSAGES_PER_WINDOW, MESSAGE_WINDOW_MS);

  const resolveAssistant = createAssistantResolver({ repo, views });

  /** The picker: what this user is allowed to talk to. */
  router.get('/', auth.requireUser, async (req, res) => {
    const user = req.user!;
    const assistants = await repo.listAssistantsForUser(user.id, user.isAdmin);

    // With exactly one there is nothing to choose, so go straight in.
    if (assistants.length === 1 && assistants[0]) {
      res.redirect(`/a/${assistants[0].slug}`);
      return;
    }
    res.type('html').send(views.pickerPage(user, assistants));
  });

  // Assistants used to live under /a/<slug>; keep old links working.
  router.get('/a/:slug', (req, res) => {
    res.redirect(301, `/${encodeURIComponent(String(req.params.slug ?? ''))}`);
  });

  router.get('/:slug', auth.requireUser, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;
    // The footer under the chat states how this chatbot is set up, so the page
    // needs its settings as well as its identity.
    const [others, settings] = await Promise.all([
      repo.listAssistantsForUser(req.user!.id, req.user!.isAdmin),
      loadSettings(repo, config, assistant.id),
    ]);
    res.type('html').send(views.chatPage(req.user!, assistant, others.length > 1, settings));
  });

  /**
   * A generated image or recording. Not under /api/ because it is referenced
   * from an <img> or an <audio> and wants to behave like a file: a real
   * Content-Type, and cacheable.
   *
   * Private: `findMediaForUser` joins through the conversation, so the owner is
   * part of the query rather than a check beside it — the rule the conversation
   * routes already follow. Someone else's image id answers 404, not 403.
   */
  router.get('/:slug/media/:mediaId', auth.requireUser, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;

    const mediaId = parseId(req.params.mediaId);
    const file =
      mediaId === null
        ? null
        : await repo.findMediaForUser(mediaId, req.user!.id, assistant.id);

    if (!file) {
      res.status(404).type('html').send(views.errorPage(404, 'This file does not exist.'));
      return;
    }

    res.setHeader('Content-Type', file.mimeType);
    // Immutable: the bytes behind an id never change, and a conversation is
    // reopened often.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(file.bytes);
  });

  router.get('/api/:slug/conversations', auth.requireUser, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;
    res.json({ conversations: await repo.listConversations(req.user!.id, assistant.id) });
  });

  router.post('/api/:slug/conversations', auth.requireUser, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;
    const conversation = await repo.createConversation(req.user!.id, assistant.id, UNTITLED);
    res.status(201).json({ conversation, messages: [] });
  });

  router.get('/api/:slug/conversations/:id', auth.requireUser, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;
    const id = parseId(req.params.id);
    const conversation = id === null ? null : await repo.findConversation(id, req.user!.id);
    if (!conversation || conversation.assistantId !== assistant.id) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    /*
     * Media comes back as urls grouped onto their message, never as bytes: a
     * conversation with a dozen pictures would otherwise be a dozen megabytes
     * of JSON every time it is opened.
     */
    const [messages, media] = await Promise.all([
      repo.listMessages(conversation.id),
      repo.listMediaForConversation(conversation.id),
    ]);
    const byMessage = new Map<number, { url: string; mimeType: string }[]>();
    for (const file of media) {
      const list = byMessage.get(file.messageId) ?? [];
      list.push({ url: `/${assistant.slug}/media/${file.id}`, mimeType: file.mimeType });
      byMessage.set(file.messageId, list);
    }

    res.json({
      conversation,
      messages: messages.map((message) => ({
        ...message,
        media: byMessage.get(message.id) ?? [],
      })),
    });
  });

  router.delete('/api/:slug/conversations/:id', auth.requireUser, async (req, res) => {
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid conversation id' });
      return;
    }
    const conversation = await repo.findConversation(id, req.user!.id);
    if (conversation && conversation.assistantId === assistant.id) {
      await repo.deleteConversation(id, req.user!.id);
    }
    res.status(204).end();
  });

  /**
   * Sends a message and streams the answer back as Server-Sent Events.
   * Both the question and the complete answer are stored, so the history is
   * intact after signing in again.
   */
  router.post('/api/:slug/conversations/:id/messages', auth.requireUser, async (req, res, next) => {
    const user = req.user!;
    const assistant = await resolveAssistant(req, res);
    if (!assistant) return;

    const id = parseId(req.params.id);
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const audio = readAudio(req.body);
    const existing = id === null ? null : await repo.findConversation(id, user.id);

    if (!existing || existing.assistantId !== assistant.id) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    /*
     * A speech-to-text chatbot is sent a recording and need be sent nothing
     * else; every other kind needs words. Checked here and not only in the
     * browser, which can be skipped.
     */
    if (assistant.kind === 'transcribe') {
      if (audio === 'invalid') {
        res.status(400).json({ error: 'That audio file is not one this chatbot can read.' });
        return;
      }
      if (audio === null) {
        res.status(400).json({ error: 'Attach a recording to transcribe.' });
        return;
      }
      if (audio.data.length > MAX_AUDIO_BASE64) {
        res.status(413).json({ error: 'That recording is too large (about 6 MB is the limit).' });
        return;
      }
    } else if (prompt.length === 0) {
      res.status(400).json({ error: 'Message is empty' });
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      res.status(413).json({ error: `Message is too long (max ${MAX_PROMPT_CHARS} characters)` });
      return;
    }
    // Per user, not per IP: the cost follows the account, and a household behind
    // one address should not share a budget.
    if (!messageLimiter.take(`user:${user.id}`)) {
      res.status(429).json({
        error: 'Too many messages in a short time. Please wait a minute and try again.',
      });
      return;
    }

    try {
      const settings = await loadSettings(repo, config, assistant.id);
      const paths = assistantPaths(config, assistant.slug);
      const basePrompt = await buildSystemPrompt({
        instructionsPath: paths.instructionsPath,
        contextDir: paths.contextDir,
        assistantName: assistant.name,
        language: assistant.language,
        citations: settings.citations,
      });

      // Both of these go after the cached knowledge base, and for the same
      // reason: they are per user, and a per-user block in front of the shared
      // prefix would invalidate the prompt cache for everyone on every request.
      const [memories, notes] = await Promise.all([
        settings.memory ? memorySection(repo, user.id, assistant.id) : null,
        settings.notes ? notesSection(repo, user.id, assistant.id) : null,
      ]);
      const systemPrompt = [basePrompt, memories, notes].filter((part) => part).join('\n\n');

      const conversationId = existing.id;
      const stored = await repo.addMessage(conversationId, 'user', prompt);

      const history = historyWithSummary(
        await repo.listMessages(conversationId),
        settings.compaction ? existing.summary : null,
        HISTORY_LIMIT,
      );

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      send('start', { messageId: stored.id });

      const abort = new AbortController();
      req.on('close', () => abort.abort());

      let answer = '';
      let sources: SourceLink[] = [];
      let usage: MessageUsage | null = null;
      let media: GeneratedMedia[] = [];
      try {
        const result = await chat.stream(
          {
            systemPrompt,
            // The recording belongs to the turn just stored — the last one.
            history: audio && audio !== 'invalid' ? withAudio(history, audio) : history,
            settings,
            kind: assistant.kind,
            signal: abort.signal,
          },
          {
            onDelta: (delta) => {
              answer += delta;
              send('delta', { text: delta });
            },
            onThinking: (text) => send('thinking', { text }),
            onSource: (source) => send('source', source),
          },
        );
        answer = result.answer;
        sources = result.sources;
        usage = result.usage;
        media = result.media;
      } catch (error) {
        if (abort.signal.aborted) {
          // The client dropped the connection; keep whatever already arrived.
          // Whatever arrived is kept, but without usage: the provider sends
          // that in a final chunk this connection never got to.
          if (answer.trim().length > 0) await repo.addMessage(conversationId, 'assistant', answer);
          res.end();
          return;
        }
        const message =
          error instanceof ChatRefusalError ? error.message : describeChatError(error);
        logger.error({ err: error, conversationId }, 'chat stream failed');
        send('error', { message });
        res.end();
        return;
      }

      const answerMessage = await repo.addMessage(conversationId, 'assistant', answer, usage);

      /*
       * Stored against the message, and referenced by id rather than inlined:
       * a generated image is about a megabyte, and the conversation it belongs
       * to is reloaded every time the user opens it.
       */
      const storedMedia = [];
      for (const file of media) {
        storedMedia.push(await repo.addMessageMedia(answerMessage.id, file.mimeType, file.bytes));
      }
      if (storedMedia.length > 0) {
        send('media', {
          media: storedMedia.map((file) => ({
            url: `/${assistant.slug}/media/${file.id}`,
            mimeType: file.mimeType,
            bytes: file.byteLength,
          })),
        });
      }

      // The first user message determines the title of a fresh conversation.
      if (existing.title === UNTITLED) {
        const title = deriveTitle(prompt);
        await repo.renameConversation(conversationId, user.id, title);
        send('title', { title });
      }

      send('done', { model: settings.model, sources, usage: answerMessage.usage });
      res.end();

      // Memory and compaction run after the answer is delivered: they cost an
      // extra call each and must never delay or break the reply.
      await rememberExchange({ repo, chat }, settings, user.id, assistant.id, prompt, answer);
      await compactConversation({ repo, chat }, settings, conversationId);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      next(error);
    }
  });

  return router;
}
