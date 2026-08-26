import type { Db } from './index.js';
import { normalizeEmail } from '../config.js';

/**
 * Thin data layer on top of SQLite. All SQL lives here and is parameterized,
 * so a possible move to Postgres stays a local change.
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
  title: string;
  createdAt: string;
  updatedAt: string;
  assistantId: number;
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
  is_admin: number;
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
  created_at: string;
  updated_at: string;
  summary: string | null;
  summarized_through: number | null;
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

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.is_admin === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    language: row.language,
    createdAt: row.created_at,
  };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

/** ISO timestamp in the format SQLite's datetime('now') uses (UTC, seconds). */
function sqlTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function createRepo(db: Db) {
  return {
    // ---- users ------------------------------------------------------------

    findUserByEmail(email: string): User | null {
      const row = db
        .prepare('SELECT * FROM users WHERE email = ?')
        .get(normalizeEmail(email)) as UserRow | undefined;
      return row ? toUser(row) : null;
    },

    findUserById(id: number): User | null {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
      return row ? toUser(row) : null;
    },

    listUsers(): User[] {
      const rows = db.prepare('SELECT * FROM users ORDER BY email').all() as UserRow[];
      return rows.map(toUser);
    },

    /** Adds a user; if the address already exists the existing one is returned. */
    upsertUser(email: string, isAdmin: boolean): User {
      const normalized = normalizeEmail(email);
      db.prepare(
        `INSERT INTO users (email, is_admin) VALUES (?, ?)
         ON CONFLICT(email) DO UPDATE SET is_admin = MAX(users.is_admin, excluded.is_admin)`,
      ).run(normalized, isAdmin ? 1 : 0);
      const user = this.findUserByEmail(normalized);
      if (!user) throw new Error(`Could not create user ${normalized}`);
      return user;
    },

    deleteUser(id: number): void {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },

    touchUser(id: number): void {
      db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(id);
    },

    // ---- magic-link tokens ------------------------------------------------

    createLoginToken(userId: number, tokenHash: string, expiresAt: Date): void {
      db.prepare('INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
        tokenHash,
        userId,
        sqlTime(expiresAt),
      );
    },

    /**
     * Exchanges an unused, unexpired token for the matching user.
     * Marks the token as used in the same transaction (single use).
     */
    consumeLoginToken(tokenHash: string): User | null {
      return db.transaction((): User | null => {
        const row = db
          .prepare(
            `SELECT user_id FROM login_tokens
             WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
          )
          .get(tokenHash) as { user_id: number } | undefined;
        if (!row) return null;

        db.prepare("UPDATE login_tokens SET used_at = datetime('now') WHERE token_hash = ?").run(tokenHash);
        return this.findUserById(row.user_id);
      })();
    },

    // ---- sessions ---------------------------------------------------------

    createSession(userId: number, tokenHash: string, expiresAt: Date): void {
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
        tokenHash,
        userId,
        sqlTime(expiresAt),
      );
    },

    findUserBySessionToken(tokenHash: string): User | null {
      const row = db
        .prepare(
          `SELECT u.* FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
        )
        .get(tokenHash) as UserRow | undefined;
      return row ? toUser(row) : null;
    },

    deleteSession(tokenHash: string): void {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    },

    /** Purges expired sessions and tokens; runs periodically. */
    purgeExpired(): void {
      db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
      db.prepare("DELETE FROM login_tokens WHERE expires_at <= datetime('now')").run();
    },

    // ---- conversations ----------------------------------------------------

    createConversation(userId: number, assistantId: number, title: string): Conversation {
      const result = db
        .prepare('INSERT INTO conversations (user_id, assistant_id, title) VALUES (?, ?, ?)')
        .run(userId, assistantId, title);
      const conversation = this.findConversation(Number(result.lastInsertRowid), userId);
      if (!conversation) throw new Error('Could not create conversation');
      return conversation;
    },

    /** Only returns a conversation if it belongs to this user (authorization in the query). */
    findConversation(id: number, userId: number): Conversation | null {
      const row = db
        .prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
        .get(id, userId) as ConversationRow | undefined;
      return row ? toConversation(row) : null;
    },

    /** Scoped to one assistant: a user's threads do not cross assistants. */
    listConversations(userId: number, assistantId: number): Conversation[] {
      const rows = db
        .prepare(
          `SELECT * FROM conversations
           WHERE user_id = ? AND assistant_id = ?
           ORDER BY updated_at DESC, id DESC`,
        )
        .all(userId, assistantId) as ConversationRow[];
      return rows.map(toConversation);
    },

    renameConversation(id: number, userId: number, title: string): void {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?').run(title, id, userId);
    },

    deleteConversation(id: number, userId: number): void {
      db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId);
    },

    // ---- messages ---------------------------------------------------------

    addMessage(conversationId: number, role: Role, content: string): Message {
      const result = db.transaction(() => {
        const inserted = db
          .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
          .run(conversationId, role, content);
        db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
        return inserted;
      })();

      const row = db
        .prepare('SELECT * FROM messages WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as MessageRow;
      return toMessage(row);
    },

    listMessages(conversationId: number): Message[] {
      const rows = db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id')
        .all(conversationId) as MessageRow[];
      return rows.map(toMessage);
    },

    /** Ignores ownership: for background work that already knows the id. */
    findConversationById(id: number): Conversation | null {
      const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
        | ConversationRow
        | undefined;
      return row ? toConversation(row) : null;
    },

    setConversationSummary(id: number, summary: string, throughMessageId: number): void {
      db.prepare('UPDATE conversations SET summary = ?, summarized_through = ? WHERE id = ?').run(
        summary,
        throughMessageId,
        id,
      );
    },

    // ---- memories ---------------------------------------------------------

    /** Most recent first, newest-limit entries, for this assistant only. */
    listMemories(userId: number, assistantId: number, limit: number): Memory[] {
      const rows = db
        .prepare(
          'SELECT * FROM memories WHERE user_id = ? AND assistant_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(userId, assistantId, limit) as MemoryRow[];
      return rows.map(toMemory);
    },

    addMemory(userId: number, assistantId: number, content: string): void {
      db.prepare('INSERT INTO memories (user_id, assistant_id, content) VALUES (?, ?, ?)').run(
        userId,
        assistantId,
        content,
      );
    },

    clearMemories(userId: number, assistantId: number): void {
      db.prepare('DELETE FROM memories WHERE user_id = ? AND assistant_id = ?').run(userId, assistantId);
    },

    // ---- assistants -------------------------------------------------------

    listAssistants(): Assistant[] {
      const rows = db.prepare('SELECT * FROM assistants ORDER BY name').all() as AssistantRow[];
      return rows.map(toAssistant);
    },

    findAssistantBySlug(slug: string): Assistant | null {
      const row = db.prepare('SELECT * FROM assistants WHERE slug = ?').get(slug) as
        | AssistantRow
        | undefined;
      return row ? toAssistant(row) : null;
    },

    findAssistantById(id: number): Assistant | null {
      const row = db.prepare('SELECT * FROM assistants WHERE id = ?').get(id) as
        | AssistantRow
        | undefined;
      return row ? toAssistant(row) : null;
    },

    createAssistant(slug: string, name: string, description: string, language: string): Assistant {
      const result = db
        .prepare('INSERT INTO assistants (slug, name, description, language) VALUES (?, ?, ?, ?)')
        .run(slug, name, description, language);
      const assistant = this.findAssistantById(Number(result.lastInsertRowid));
      if (!assistant) throw new Error(`Could not create assistant ${slug}`);
      return assistant;
    },

    updateAssistant(id: number, name: string, description: string, language: string): void {
      db.prepare('UPDATE assistants SET name = ?, description = ?, language = ? WHERE id = ?').run(
        name,
        description,
        language,
        id,
      );
    },

    /** Cascades to its conversations, memories, settings and grants. */
    deleteAssistant(id: number): void {
      db.prepare('DELETE FROM assistants WHERE id = ?').run(id);
    },

    // ---- rights matrix ----------------------------------------------------

    /** Assistants this user may chat with. Admins may use every one. */
    listAssistantsForUser(userId: number, isAdmin: boolean): Assistant[] {
      if (isAdmin) return this.listAssistants();
      const rows = db
        .prepare(
          `SELECT a.* FROM assistants a
           JOIN assistant_users au ON au.assistant_id = a.id
           WHERE au.user_id = ?
           ORDER BY a.name`,
        )
        .all(userId) as AssistantRow[];
      return rows.map(toAssistant);
    },

    canUseAssistant(userId: number, isAdmin: boolean, assistantId: number): boolean {
      if (isAdmin) return true;
      const row = db
        .prepare('SELECT 1 AS ok FROM assistant_users WHERE user_id = ? AND assistant_id = ?')
        .get(userId, assistantId) as { ok: number } | undefined;
      return row !== undefined;
    },

    /** User ids explicitly granted this assistant; admins are not listed. */
    listGrantedUserIds(assistantId: number): number[] {
      const rows = db
        .prepare('SELECT user_id FROM assistant_users WHERE assistant_id = ?')
        .all(assistantId) as { user_id: number }[];
      return rows.map((row) => row.user_id);
    },

    grantAssistant(assistantId: number, userId: number): void {
      db.prepare(
        'INSERT OR IGNORE INTO assistant_users (assistant_id, user_id) VALUES (?, ?)',
      ).run(assistantId, userId);
    },

    revokeAssistant(assistantId: number, userId: number): void {
      db.prepare('DELETE FROM assistant_users WHERE assistant_id = ? AND user_id = ?').run(
        assistantId,
        userId,
      );
    },

    /** Replaces the whole grant list for one assistant in a single transaction. */
    setAssistantUsers(assistantId: number, userIds: readonly number[]): void {
      db.transaction(() => {
        db.prepare('DELETE FROM assistant_users WHERE assistant_id = ?').run(assistantId);
        const insert = db.prepare(
          'INSERT OR IGNORE INTO assistant_users (assistant_id, user_id) VALUES (?, ?)',
        );
        for (const userId of userIds) insert.run(assistantId, userId);
      })();
    },

    // ---- settings ---------------------------------------------------------

    /** Runtime setting for one assistant, or null when never set. */
    getSetting(assistantId: number, key: string): string | null {
      const row = db
        .prepare('SELECT value FROM assistant_settings WHERE assistant_id = ? AND key = ?')
        .get(assistantId, key) as { value: string } | undefined;
      return row ? row.value : null;
    },

    setSetting(assistantId: number, key: string, value: string): void {
      db.prepare(
        `INSERT INTO assistant_settings (assistant_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(assistant_id, key) DO UPDATE
           SET value = excluded.value, updated_at = datetime('now')`,
      ).run(assistantId, key, value);
    },

    /** Reads the pre-assistant global settings table, for the one-off backfill. */
    legacySettings(): { key: string; value: string }[] {
      return db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    },

    /** Rows still carrying no assistant, from before multi-assistant support. */
    attachOrphansToAssistant(assistantId: number): { conversations: number; memories: number } {
      const conversations = db
        .prepare('UPDATE conversations SET assistant_id = ? WHERE assistant_id IS NULL')
        .run(assistantId).changes;
      const memories = db
        .prepare('UPDATE memories SET assistant_id = ? WHERE assistant_id IS NULL')
        .run(assistantId).changes;
      return { conversations, memories };
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
