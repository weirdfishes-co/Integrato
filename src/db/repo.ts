import type { Db } from './index.js';
import { normalizeEmail } from '../config.js';

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
}

interface UserRow {
  id: number;
  email: string;
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

interface MemoryRow {
  id: number;
  user_id: number;
  assistant_id: number;
  content: string;
  created_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  role: Role;
  content: string;
  created_at: string;
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

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
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

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    content: row.content,
    createdAt: requireTime(row.created_at),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: requireTime(row.created_at),
  };
}

export function createRepo(db: Db) {
  return {
    // ---- users ------------------------------------------------------------

    async findUserByEmail(email: string): Promise<User | null> {
      const row = await db.one<UserRow>('SELECT * FROM users WHERE email = $1', [
        normalizeEmail(email),
      ]);
      return row ? toUser(row) : null;
    },

    async findUserById(id: number): Promise<User | null> {
      const row = await db.one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
      return row ? toUser(row) : null;
    },

    async listUsers(): Promise<User[]> {
      const rows = await db.all<UserRow>('SELECT * FROM users ORDER BY email');
      return rows.map(toUser);
    },

    /**
     * Adds a user; an existing address is returned unchanged except that admin
     * rights are only ever granted, never taken away — that is what keeps the
     * ADMIN_EMAILS boot loop from being a lockout risk.
     */
    async upsertUser(email: string, isAdmin: boolean): Promise<User> {
      const row = await db.one<UserRow>(
        `INSERT INTO users (email, is_admin) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET is_admin = users.is_admin OR excluded.is_admin
         RETURNING *`,
        [normalizeEmail(email), isAdmin],
      );
      if (!row) throw new Error(`Could not create user ${email}`);
      return toUser(row);
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
      return row ? toUser(row) : null;
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
      return row ? toUser(row) : null;
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
    async addMessage(conversationId: number, role: Role, content: string): Promise<Message> {
      const row = await db.one<MessageRow>(
        `WITH inserted AS (
           INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)
           RETURNING *
         ), touched AS (
           UPDATE conversations SET updated_at = now() WHERE id = $1
         )
         SELECT * FROM inserted`,
        [conversationId, role, content],
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
    ): Promise<void> {
      await db.run(
        'UPDATE assistants SET name = $1, description = $2, language = $3 WHERE id = $4',
        [name, description, language, id],
      );
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
