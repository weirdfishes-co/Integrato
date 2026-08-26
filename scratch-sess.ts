import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
const token = 'dbg-session';
const hash = createHash('sha256').update(token).digest('hex');
const db = new Database('./data/app.db');
const u = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get() as { id: number };
db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now','+1 hour'))").run(hash, u.id);
console.log(token);
