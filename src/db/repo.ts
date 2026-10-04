import type { Db } from './index.js';
import { normalizeEmail } from '../config.js';
import type { Cipher } from '../crypto.js';

/**
 * Thin data layer on top of PostgreSQL. All SQL lives here and is
 * parameterized, so the rest of the app never builds a query.
 *
 * Every method is async because the driver is. Where SQLite needed an
 * insert followed by a read, Postgres returns the row from the statement that
 * wrote it, so several operations that were two queries are now one.
 */

export interface User {
  id: number;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Assistant {
  id: number;
  slug: string;
  name: string;
  description: string;
  language: string;
  /** Greeting for an empty conversation; empty means use the built-in one. */
  welcome: string;
  createdAt: string;
}

export interface Conversation {
  id: number;
  userId: number;
  assistantId: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Running summary of the compacted-away messages; null when none. */
  summary: string | null;
  /** Id of the last message the summary covers. */
  summarizedThrough: number | null;
}

/** A conversation plus who it belongs to, for the admin conversation log. */
export interface ConversationWithUser extends Conversation {
  userEmail: string;
}

export interface Memory {
  id: number;
  userId: number;
  assistantId: number;
  content: string;
  createdAt: string;
}

export type Role = 'user' | 'assistant';

export interface Message {
  id: number;
  conversationId: number;
  role: Role;
  content: string;
  createdAt: string;
  /** What the answer cost, or null on a user message and on older rows. */
  usage: MessageUsage | null;
}

/**
 * What one answer consumed, as OpenRouter reported it.
 *
 * `cost` is the provider's own figure in US dollars, not a price we computed
 * from a rate card — which is why it is worth storing rather than deriving.
 */
/**
 * A document the user wrote themselves, in the editor, for one chatbot.
 *
 * Distinct from the knowledge base in `content.ts`: that is the admin's, lives
 * on the volume and is shared by everyone who may use the chatbot. This belongs
 * to one user and reaches only their own conversations.
 */
export interface Note {
  id: number;
  userId: number;
  assistantId: number;
  name: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  /** Part of completionTokens that was reasoning, when the model reports it. */
  reasoningTokens: number;
  /** Part of promptTokens served from the provider's cache, so billed less. */
  cachedTokens: number;
  cost: number;
}

/**
 * One user's totals against one assistant, for the admin usage panel.
 * `cost` is null, never 0, when nothing was reported — matching how a single
 * message's usage is already null-not-zero (see MessageUsage/toUsage).
 */
export interface UserUsage {
  userId: number;
  email: string;
  answerCount: number;
  promptTokens: number;
  completionTokens: number;
  cost: number | null;
}

interface UserRow {
  id: number;
  email_enc: string;
  is_admin: boolean;
  created_at: string;
  last_seen_at: string | null;
}

interface AssistantRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  language: string;
  welcome: string;
  created_at: string;
}

interface ConversationRow {
  id: number;
  user_id: number;
  assistant_id: number;
  title: string;
  summary: string | null;
  summarized_through: number | null;
  created_at: string;
  updated_at: string;
}

interface ConversationWithUserRow extends ConversationRow {
  user_email_enc: string;
}

/** COUNT/SUM come back as bigint/numeric text; the driver's parsing is off. */
interface UserUsageRow {
  user_id: number;
  email_enc: string;
  answer_count: string;
  prompt_tokens: string;
  completion_tokens: string;
  cost: string | null;
}

interface MemoryRow {
  id: number;
  user_id: number;
  assistant_id: number;
  content: string;
  created_at: string;
}

interface NoteRow {
  id: number;
  user_id: number;
  assistant_id: number;
  name: string;
  tags: string;
  content: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  role: Role;
  content: string;
  created_at: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  /** NUMERIC comes back as a string; the driver's parsing is off. */
  cost: string | null;
}

/**
 * Timestamps arrive as the raw Postgres text (the driver's Date parsing is
 * switched off in index.ts). Trimming to "YYYY-MM-DD HH:MM:SS" keeps them
 * readable on the admin page and comparable as strings.
 */
function toTime(value: string | null): string | null {
  if (value === null) return null;
  return value.slice(0, 19).replace('T', ' ');
}

function requireTime(value: string): string {
  return toTime(value) ?? '';
}

function toUser(row: UserRow, cipher: Cipher): User {
  return {
    id: row.id,
    email: cipher.decrypt(row.email_enc),
    isAdmin: row.is_admin,
    createdAt: requireTime(row.created_at),
    lastSeenAt: toTime(row.last_seen_at),
  };
}

function toAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    language: row.language,
    welcome: row.welcome,
    createdAt: requireTime(row.created_at),
  };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    title: row.title,
    createdAt: requireTime(row.created_at),
    updatedAt: requireTime(row.updated_at),
    summary: row.summary,
    summarizedThrough: row.summarized_through,
  };
}

function toConversationWithUser(row: ConversationWithUserRow, cipher: Cipher): ConversationWithUser {
  return { ...toConversation(row), userEmail: cipher.decrypt(row.user_email_enc) };
}

function toUserUsage(row: UserUsageRow, cipher: Cipher): UserUsage {
  return {
    userId: row.user_id,
    email: cipher.decrypt(row.email_enc),
    answerCount: Number(row.answer_count),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    cost: row.cost === null ? null : Number(row.cost),
  };
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    content: row.content,
    createdAt: requireTime(row.created_at),
  };
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    name: row.name,
    tags: row.tags.length === 0 ? [] : row.tags.split(','),
    content: row.content,
    createdAt: requireTime(row.created_at),
    updatedAt: requireTime(row.updated_at),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: requireTime(row.created_at),
    usage: toUsage(row),
  };
}

/**
 * Usage is all-or-nothing: a row either recorded an answer's cost or it did
 * not, and a half-filled object would invite a display that reads "0 tokens"
 * for a message that simply predates the columns.
 */
function toUsage(row: MessageRow): MessageUsage | null {
  if (row.prompt_tokens === null || row.completion_tokens === null) return null;
  return {
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    reasoningTokens: row.reasoning_tokens ?? 0,
    cachedTokens: row.cached_tokens ?? 0,
    cost: row.cost === null ? 0 : Number(row.cost),
  };
}

export function createRepo(db: Db, cipher: Cipher) {
  return {
    // ---- users ------------------------------------------------------------

    async findUserByEmail(email: string): Promise<User | null> {
      const row = await db.one<UserRow>('SELECT * FROM users WHERE email_hash = $1', [
        cipher.blindIndex(normalizeEmail(email)),
      ]);
      return row ? toUser(row, cipher) : null;
    },

    async findUserById(id: number): Promise<User | null> {
      const row = await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return row ? toUser(row, cipher) : null;
    },

    /** Sorted here: the column holds ciphertext, so the database cannot order it. */
    async listUsers(): Promise<User[]> {
      const rows = await db.all<UserRow>('SELECT * FROM users');
      return rows.map((row) => toUser(row, cipher)).sort((a, b) => a.email.localeCompare(b.email));
    },

    /**
     * Adds a user; an existing address is returned unchanged except that admin
     * rights are only ever granted, never taken away — that is what keeps the
     * ADMIN_EMAILS boot loop from being a lockout risk.
     */
    async upsertUser(email: string, isAdmin: boolean): Promise<User> {
      const normalized = normalizeEmail(email);
      const row = await db.one<UserRow>(
        `INSERT INTO users (email_enc, email_hash, is_admin) VALUES ($1, $2, $3)
         ON CONFLICT (email_hash) DO UPDATE SET is_admin = users.is_admin OR excluded.is_admin
         RETURNING *`,
        [cipher.encrypt(normalized), cipher.blindIndex(normalized), isAdmin],
      );
      if (!row) throw new Error('Could not create user');
      return toUser(row, cipher);
    },

    /**
     * Encrypts addresses written before migration 006 and clears the plaintext.
     * Idempotent: a row that is already converted is not selected. Returns how
     * many rows it converted.
     */
    async protectEmails(): Promise<number> {
      const rows = await db.all<{ id: number; email: string }>(
        'SELECT id, email FROM users WHERE email_enc IS NULL AND email IS NOT NULL',
      );
      for (const row of rows) {
        const normalized = normalizeEmail(row.email);
        await db.run(
          'UPDATE users SET email_enc = $1, email_hash = $2, email = NULL WHERE id = $3',
          [cipher.encrypt(normalized), cipher.blindIndex(normalized), row.id],
        );
      }
      return rows.length;
    },

    async deleteUser(id: number): Promise<void> {
      await db.run('DELETE FROM users WHERE id = $1', [id]);
    },

    async touchUser(id: number): Promise<void> {
      await db.run('UPDATE users SET last_seen_at = now() WHERE id = $1', [id]);
    },

    // ---- magic-link tokens ------------------------------------------------

    async createLoginToken(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
      await db.run(
        'INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
        [tokenHash, userId, expiresAt.toISOString()],
      );
    },

    /**
     * Exchanges an unused, unexpired token for its user and marks it used in
     * the same statement, so a link cannot be redeemed twice even under two
     * simultaneous requests.
     */
    async consumeLoginToken(tokenHash: string): Promise<User | null> {
      const row = await db.one<UserRow>(
        `WITH consumed AS (
           UPDATE login_tokens SET used_at = now()
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
           RETURNING user_id
         )
         SELECT u.* FROM users u JOIN consumed ON consumed.user_id = u.id`,
        [tokenHash],
      );
      return row ? toUser(row, cipher) : null;
    },

    // ---- sessions ---------------------------------------------------------

    async createSession(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
      await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
        tokenHash,
        userId,
        expiresAt.toISOString(),
      ]);
    },

    async findUserBySessionToken(tokenHash: string): Promise<User | null> {
      const row = await db.one<UserRow>(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash],
      );
      return row ? toUser(row, cipher) : null;
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db.run('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },

    /** Purges expired sessions and tokens; runs periodically. */
    async purgeExpired(): Promise<void> {
      await db.run('DELETE FROM sessions WHERE expires_at <= now()');
      await db.run('DELETE FROM login_tokens WHERE expires_at <= now()');
    },

    // ---- conversations ----------------------------------------------------

    async createConversation(
      userId: number,
      assistantId: number,
      title: string,
    ): Promise<Conversation> {
      const row = await db.one<ConversationRow>(
        `INSERT INTO conversations (user_id, assistant_id, title) VALUES ($1, $2, $3)
         RETURNING *`,
        [userId, assistantId, title],
      );
      if (!row) throw new Error('Could not create conversation');
      return toConversation(row);
    },

    /** Only returns a conversation if it belongs to this user (authorization in the query). */
    async findConversation(id: number, userId: number): Promise<Conversation | null> {
      const row = await db.one<ConversationRow>(
        'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
        [id, userId],
      );
      return row ? toConversation(row) : null;
    },

    /** Ignores ownership: for background work that already knows the id. */
    async findConversationById(id: number): Promise<Conversation | null> {
      const row = await db.one<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
      return row ? toConversation(row) : null;
    },

    /** Scoped to one assistant: a user's threads do not cross assistants. */
    async listConversations(userId: number, assistantId: number): Promise<Conversation[]> {
      const rows = await db.all<ConversationRow>(
        `SELECT * FROM conversations
         WHERE user_id = $1 AND assistant_id = $2
         ORDER BY updated_at DESC, id DESC`,
        [userId, assistantId],
      );
      return rows.map(toConversation);
    },

    /** Across every user — for the admin conversation log, not a user's own view. */
    async listConversationsForAssistant(assistantId: number): Promise<ConversationWithUser[]> {
      const rows = await db.all<ConversationWithUserRow>(
        `SELECT conversations.*, users.email_enc AS user_email_enc
         FROM conversations
         JOIN users ON users.id = conversations.user_id
         WHERE conversations.assistant_id = $1
         ORDER BY conversations.updated_at DESC, conversations.id DESC`,
        [assistantId],
      );
      return rows.map((row) => toConversationWithUser(row, cipher));
    },

    /** Ignores ownership, like findConversationById — for the admin conversation log. */
    async findConversationWithUser(id: number): Promise<ConversationWithUser | null> {
      const row = await db.one<ConversationWithUserRow>(
        `SELECT conversations.*, users.email_enc AS user_email_enc
         FROM conversations
         JOIN users ON users.id = conversations.user_id
         WHERE conversations.id = $1`,
        [id],
      );
      return row ? toConversationWithUser(row, cipher) : null;
    },

    async renameConversation(id: number, userId: number, title: string): Promise<void> {
      await db.run('UPDATE conversations SET title = $1 WHERE id = $2 AND user_id = $3', [
        title,
        id,
        userId,
      ]);
    },

    async deleteConversation(id: number, userId: number): Promise<void> {
      await db.run('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    },

    async setConversationSummary(
      id: number,
      summary: string,
      throughMessageId: number,
    ): Promise<void> {
      await db.run(
        'UPDATE conversations SET summary = $1, summarized_through = $2 WHERE id = $3',
        [summary, throughMessageId, id],
      );
    },

    // ---- messages ---------------------------------------------------------

    /** Inserts the message and bumps the conversation in one statement. */
    async addMessage(
      conversationId: number,
      role: Role,
      content: string,
      usage: MessageUsage | null = null,
    ): Promise<Message> {
      const row = await db.one<MessageRow>(
        `WITH inserted AS (
           INSERT INTO messages
             (conversation_id, role, content,
              prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *
         ), touched AS (
           UPDATE conversations SET updated_at = now() WHERE id = $1
         )
         SELECT * FROM inserted`,
        [
          conversationId,
          role,
          content,
          usage?.promptTokens ?? null,
          usage?.completionTokens ?? null,
          usage?.reasoningTokens ?? null,
          usage?.cachedTokens ?? null,
          usage?.cost ?? null,
        ],
      );
      if (!row) throw new Error('Could not add message');
      return toMessage(row);
    },

    async listMessages(conversationId: number): Promise<Message[]> {
      const rows = await db.all<MessageRow>(
        'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id',
        [conversationId],
      );
      return rows.map(toMessage);
    },

    /**
     * Token and cost totals per user, for the admin usage panel. Only answers
     * carry usage, so the join is to assistant messages alone; a user with no
     * answers yet simply has no row, rather than one full of zeros.
     */
    async usageByUser(assistantId: number): Promise<UserUsage[]> {
      const rows = await db.all<UserUsageRow>(
        `SELECT users.id AS user_id, users.email_enc AS email_enc,
                COUNT(messages.id) AS answer_count,
                COALESCE(SUM(messages.prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(messages.completion_tokens), 0) AS completion_tokens,
                SUM(messages.cost) AS cost
         FROM conversations
         JOIN users ON users.id = conversations.user_id
         JOIN messages ON messages.conversation_id = conversations.id AND messages.role = 'assistant'
         WHERE conversations.assistant_id = $1
         GROUP BY users.id, users.email_enc
         ORDER BY cost DESC NULLS LAST, users.id`,
        [assistantId],
      );
      return rows.map((row) => toUserUsage(row, cipher));
    },

    // ---- assistants -------------------------------------------------------

    async listAssistants(): Promise<Assistant[]> {
      const rows = await db.all<AssistantRow>('SELECT * FROM assistants ORDER BY name');
      return rows.map(toAssistant);
    },

    async findAssistantBySlug(slug: string): Promise<Assistant | null> {
      const row = await db.one<AssistantRow>('SELECT * FROM assistants WHERE slug = $1', [slug]);
      return row ? toAssistant(row) : null;
    },

    async findAssistantById(id: number): Promise<Assistant | null> {
      const row = await db.one<AssistantRow>('SELECT * FROM assistants WHERE id = $1', [id]);
      return row ? toAssistant(row) : null;
    },

    async createAssistant(
      slug: string,
      name: string,
      description: string,
      language: string,
    ): Promise<Assistant> {
      const row = await db.one<AssistantRow>(
        `INSERT INTO assistants (slug, name, description, language) VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [slug, name, description, language],
      );
      if (!row) throw new Error(`Could not create assistant ${slug}`);
      return toAssistant(row);
    },

    async updateAssistant(
      id: number,
      name: string,
      description: string,
      language: string,
      welcome: string,
    ): Promise<void> {
      await db.run(
        'UPDATE assistants SET name = $1, description = $2, language = $3, welcome = $4 WHERE id = $5',
        [name, description, language, welcome, id],
      );
    },

    /**
     * Gives the assistant a new address and remembers the old one so that it
     * can redirect. Returns false when another assistant already holds the
     * slug (the UNIQUE constraint decides, so two concurrent renames cannot
     * both win).
     */
    async renameAssistantSlug(id: number, slug: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const current = await tx.one<{ slug: string }>('SELECT slug FROM assistants WHERE id = $1 FOR UPDATE', [id]);
        if (!current || current.slug === slug) return current !== null;

        const changed = await tx.run(
          'UPDATE assistants SET slug = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM assistants WHERE slug = $1)',
          [slug, id],
        );
        if (changed === 0) return false;

        // The new address is live now, so it must not also redirect elsewhere.
        await tx.run('DELETE FROM assistant_slug_history WHERE slug = $1', [slug]);
        await tx.run(
          `INSERT INTO assistant_slug_history (slug, assistant_id) VALUES ($1, $2)
           ON CONFLICT (slug) DO UPDATE SET assistant_id = EXCLUDED.assistant_id, retired_at = now()`,
          [current.slug, id],
        );
        return true;
      });
    },

    /** The assistant that used to live at this address, if any. */
    async findAssistantByFormerSlug(slug: string): Promise<Assistant | null> {
      const row = await db.one<AssistantRow>(
        `SELECT a.* FROM assistant_slug_history h
         JOIN assistants a ON a.id = h.assistant_id
         WHERE h.slug = $1`,
        [slug],
      );
      return row ? toAssistant(row) : null;
    },

    /** Cascades to its conversations, memories, settings and grants. */
    async deleteAssistant(id: number): Promise<void> {
      await db.run('DELETE FROM assistants WHERE id = $1', [id]);
    },

    // ---- rights matrix ----------------------------------------------------

    /** Assistants this user may chat with. Admins may use every one. */
    async listAssistantsForUser(userId: number, isAdmin: boolean): Promise<Assistant[]> {
      if (isAdmin) return this.listAssistants();
      const rows = await db.all<AssistantRow>(
        `SELECT a.* FROM assistants a
         JOIN assistant_users au ON au.assistant_id = a.id
         WHERE au.user_id = $1
         ORDER BY a.name`,
        [userId],
      );
      return rows.map(toAssistant);
    },

    async canUseAssistant(userId: number, isAdmin: boolean, assistantId: number): Promise<boolean> {
      if (isAdmin) return true;
      const row = await db.one<{ ok: number }>(
        'SELECT 1 AS ok FROM assistant_users WHERE user_id = $1 AND assistant_id = $2',
        [userId, assistantId],
      );
      return row !== null;
    },

    /** User ids explicitly granted this assistant; admins are not listed. */
    async listGrantedUserIds(assistantId: number): Promise<number[]> {
      const rows = await db.all<{ user_id: number }>(
        'SELECT user_id FROM assistant_users WHERE assistant_id = $1',
        [assistantId],
      );
      return rows.map((row) => row.user_id);
    },

    async grantAssistant(assistantId: number, userId: number): Promise<void> {
      await db.run(
        `INSERT INTO assistant_users (assistant_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [assistantId, userId],
      );
    },

    async revokeAssistant(assistantId: number, userId: number): Promise<void> {
      await db.run('DELETE FROM assistant_users WHERE assistant_id = $1 AND user_id = $2', [
        assistantId,
        userId,
      ]);
    },

    /**
     * Replaces the whole grant list for one assistant. The delete and the
     * inserts must share a transaction: as one statement the insert would see
     * the pre-delete snapshot and skip rows that are on their way out.
     */
    async setAssistantUsers(assistantId: number, userIds: readonly number[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.run('DELETE FROM assistant_users WHERE assistant_id = $1', [assistantId]);
        if (userIds.length === 0) return;
        await tx.run(
          `INSERT INTO assistant_users (assistant_id, user_id)
           SELECT $1, unnest($2::int[])
           ON CONFLICT DO NOTHING`,
          [assistantId, [...userIds]],
        );
      });
    },

    // ---- memories ---------------------------------------------------------

    /** Most recent first, newest-limit entries, for this assistant only. */
    async listMemories(userId: number, assistantId: number, limit: number): Promise<Memory[]> {
      const rows = await db.all<MemoryRow>(
        `SELECT * FROM memories WHERE user_id = $1 AND assistant_id = $2
         ORDER BY id DESC LIMIT $3`,
        [userId, assistantId, limit],
      );
      return rows.map(toMemory);
    },

    async addMemory(userId: number, assistantId: number, content: string): Promise<void> {
      await db.run('INSERT INTO memories (user_id, assistant_id, content) VALUES ($1, $2, $3)', [
        userId,
        assistantId,
        content,
      ]);
    },

    async clearMemories(userId: number, assistantId: number): Promise<void> {
      await db.run('DELETE FROM memories WHERE user_id = $1 AND assistant_id = $2', [
        userId,
        assistantId,
      ]);
    },

    // ---- notes (the user's own documents) ----------------------------------

    /*
     * Every statement below carries user_id *and* assistant_id, like the
     * conversation and memory queries: the authorization is the WHERE clause,
     * not a check beside it. Dropping either column crosses a boundary.
     */

    async listNotes(userId: number, assistantId: number): Promise<Note[]> {
      const rows = await db.all<NoteRow>(
        `SELECT * FROM notes
         WHERE user_id = $1 AND assistant_id = $2
         ORDER BY updated_at DESC, id DESC`,
        [userId, assistantId],
      );
      return rows.map(toNote);
    },

    /** For the per-user cap; counting beats fetching every document's body. */
    async countNotes(userId: number, assistantId: number): Promise<number> {
      const row = await db.one<{ count: string }>(
        'SELECT count(*) AS count FROM notes WHERE user_id = $1 AND assistant_id = $2',
        [userId, assistantId],
      );
      return Number(row?.count ?? 0);
    },

    async findNote(id: number, userId: number, assistantId: number): Promise<Note | null> {
      const row = await db.one<NoteRow>(
        'SELECT * FROM notes WHERE id = $1 AND user_id = $2 AND assistant_id = $3',
        [id, userId, assistantId],
      );
      return row ? toNote(row) : null;
    },

    async createNote(
      userId: number,
      assistantId: number,
      name: string,
      tags: readonly string[],
      content: string,
    ): Promise<Note> {
      const row = await db.one<NoteRow>(
        `INSERT INTO notes (user_id, assistant_id, name, tags, content)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, assistantId, name, tags.join(','), content],
      );
      if (!row) throw new Error('Could not create the document');
      return toNote(row);
    },

    /** Null when the document is not this user's, which the caller reads as 404. */
    async updateNote(
      id: number,
      userId: number,
      assistantId: number,
      name: string,
      tags: readonly string[],
      content: string,
    ): Promise<Note | null> {
      const row = await db.one<NoteRow>(
        `UPDATE notes
         SET name = $4, tags = $5, content = $6, updated_at = now()
         WHERE id = $1 AND user_id = $2 AND assistant_id = $3
         RETURNING *`,
        [id, userId, assistantId, name, tags.join(','), content],
      );
      return row ? toNote(row) : null;
    },

    async deleteNote(id: number, userId: number, assistantId: number): Promise<void> {
      await db.run('DELETE FROM notes WHERE id = $1 AND user_id = $2 AND assistant_id = $3', [
        id,
        userId,
        assistantId,
      ]);
    },

    // ---- settings ---------------------------------------------------------

    /** Runtime setting for one assistant, or null when never set. */
    async getSetting(assistantId: number, key: string): Promise<string | null> {
      const row = await db.one<{ value: string }>(
        'SELECT value FROM assistant_settings WHERE assistant_id = $1 AND key = $2',
        [assistantId, key],
      );
      return row ? row.value : null;
    },

    async setSetting(assistantId: number, key: string, value: string): Promise<void> {
      await db.run(
        `INSERT INTO assistant_settings (assistant_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (assistant_id, key) DO UPDATE
           SET value = excluded.value, updated_at = now()`,
        [assistantId, key, value],
      );
    },

    /** Every setting for one assistant, for callers that need them all at once. */
    async allSettings(assistantId: number): Promise<Map<string, string>> {
      const rows = await db.all<{ key: string; value: string }>(
        'SELECT key, value FROM assistant_settings WHERE assistant_id = $1',
        [assistantId],
      );
      return new Map(rows.map((row) => [row.key, row.value]));
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
