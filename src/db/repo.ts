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

export interface Conversation {
  id: number;
  userId: number;
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

interface ConversationRow {
  id: number;
  user_id: number;
  title: string;
  created_at: string;
  updated_at: string;
  summary: string | null;
  summarized_through: number | null;
}

interface MemoryRow {
  id: number;
  user_id: number;
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

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
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

    createConversation(userId: number, title: string): Conversation {
      const result = db
        .prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)')
        .run(userId, title);
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

    listConversations(userId: number): Conversation[] {
      const rows = db
        .prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
        .all(userId) as ConversationRow[];
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

    /** Most recent first, newest-limit entries. */
    listMemories(userId: number, limit: number): Memory[] {
      const rows = db
        .prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?')
        .all(userId, limit) as MemoryRow[];
      return rows.map(toMemory);
    },

    addMemory(userId: number, content: string): void {
      db.prepare('INSERT INTO memories (user_id, content) VALUES (?, ?)').run(userId, content);
    },

    countMemories(userId: number): number {
      const row = db.prepare('SELECT COUNT(*) AS count FROM memories WHERE user_id = ?').get(userId) as {
        count: number;
      };
      return row.count;
    },

    clearMemories(userId: number): void {
      db.prepare('DELETE FROM memories WHERE user_id = ?').run(userId);
    },

    // ---- settings ---------------------------------------------------------

    /** Runtime setting, or null when an admin has never set it. */
    getSetting(key: string): string | null {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    },

    setSetting(key: string, value: string): void {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).run(key, value);
    },
  };
}

export type Repo = ReturnType<typeof createRepo>;
