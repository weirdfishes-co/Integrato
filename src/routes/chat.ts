import { Router, type Request, type Response } from 'express';

import type { Auth } from '../auth.js';
import { assistantPaths } from '../assistants.js';
import { compactConversation, historyWithSummary } from '../compaction.js';
import type { Config } from '../config.js';
import { buildSystemPrompt } from '../context.js';
import type { Assistant, Repo } from '../db/repo.js';
import type { ChatClient, SourceLink } from '../llm.js';
import { ChatRefusalError, describeChatError } from '../llm.js';
import { logger } from '../logger.js';
import { memorySection, rememberExchange } from '../memory.js';
import { loadSettings } from '../settings.js';
import type { Views } from '../views.js';

const MAX_PROMPT_CHARS = 20_000;
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

  /**
   * Resolves :slug and checks the rights matrix in one place. Answers the
   * request itself and returns null when the assistant does not exist or the
   * user may not use it — both as 404, so the two are indistinguishable to
   * someone probing for assistant names.
   */
  async function resolveAssistant(req: Request, res: Response): Promise<Assistant | null> {
    const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
    const assistant = await repo.findAssistantBySlug(slug);
    const user = req.user!;

    if (!assistant || !(await repo.canUseAssistant(user.id, user.isAdmin, assistant.id))) {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Coachbot not found' });
      } else {
        res.status(404).type('html').send(views.errorPage(404, 'This coachbot does not exist.'));
      }
      return null;
    }
    return assistant;
  }

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
    const others = (await repo.listAssistantsForUser(req.user!.id, req.user!.isAdmin)).length;
    res.type('html').send(views.chatPage(req.user!, assistant, others > 1));
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
    res.json({ conversation, messages: await repo.listMessages(conversation.id) });
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
    const existing = id === null ? null : await repo.findConversation(id, user.id);

    if (!existing || existing.assistantId !== assistant.id) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    if (prompt.length === 0) {
      res.status(400).json({ error: 'Message is empty' });
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      res.status(413).json({ error: `Message is too long (max ${MAX_PROMPT_CHARS} characters)` });
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

      // Memory goes after the cached knowledge base, so a new fact for one user
      // does not invalidate the shared prompt prefix for everyone else.
      const memories = settings.memory ? await memorySection(repo, user.id, assistant.id) : null;
      const systemPrompt = memories ? `${basePrompt}\n\n${memories}` : basePrompt;

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
      try {
        const result = await chat.stream(
          { systemPrompt, history, settings, signal: abort.signal },
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
      } catch (error) {
        if (abort.signal.aborted) {
          // The client dropped the connection; keep whatever already arrived.
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

      await repo.addMessage(conversationId, 'assistant', answer);

      // The first user message determines the title of a fresh conversation.
      if (existing.title === UNTITLED) {
        const title = deriveTitle(prompt);
        await repo.renameConversation(conversationId, user.id, title);
        send('title', { title });
      }

      send('done', { model: settings.model, sources });
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
