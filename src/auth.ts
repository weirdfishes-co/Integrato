import { createHash, randomBytes } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import type { Config } from './config.js';
import type { Repo, User } from './db/repo.js';

export const SESSION_COOKIE = 'session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** Tokens are stored as a SHA-256 hash only; the plaintext lives in the email/cookie. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/** JSON endpoints get a status code back, HTML pages a redirect. */
function isApiRequest(req: Request): boolean {
  return req.path.startsWith('/api/');
}

export interface Auth {
  issueLoginToken(user: User): { token: string; expiresAt: Date };
  redeemLoginToken(token: string): User | null;
  startSession(res: Response, user: User): void;
  endSession(req: Request, res: Response): void;
  currentUser(req: Request): User | null;
  requireUser(req: Request, res: Response, next: NextFunction): void;
  requireAdmin(req: Request, res: Response, next: NextFunction): void;
}

export function createAuth(config: Config, repo: Repo): Auth {
  const secureCookie = config.appUrl.startsWith('https://');

  const auth: Auth = {
    issueLoginToken(user) {
      const token = generateToken();
      const expiresAt = minutesFromNow(config.loginTokenMinutes);
      repo.createLoginToken(user.id, hashToken(token), expiresAt);
      return { token, expiresAt };
    },

    redeemLoginToken(token) {
      if (!token) return null;
      return repo.consumeLoginToken(hashToken(token));
    },

    startSession(res, user) {
      const token = generateToken();
      const expiresAt = daysFromNow(config.sessionDays);
      repo.createSession(user.id, hashToken(token), expiresAt);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'lax',
        expires: expiresAt,
        path: '/',
      });
    },

    endSession(req, res) {
      const token = req.cookies?.[SESSION_COOKIE];
      if (typeof token === 'string' && token.length > 0) {
        repo.deleteSession(hashToken(token));
      }
      res.clearCookie(SESSION_COOKIE, { path: '/' });
    },

    currentUser(req) {
      if (req.user) return req.user;
      const token = req.cookies?.[SESSION_COOKIE];
      if (typeof token !== 'string' || token.length === 0) return null;
      const user = repo.findUserBySessionToken(hashToken(token));
      if (user) {
        req.user = user;
        repo.touchUser(user.id);
      }
      return user;
    },

    requireUser(req, res, next) {
      const user = auth.currentUser(req);
      if (!user) {
        // Path-based, not based on the Accept header: a browser fetch sends
        // `*/*`, which would otherwise get a redirect where the frontend
        // expects a 401.
        if (isApiRequest(req)) {
          res.status(401).json({ error: 'Not signed in' });
          return;
        }
        res.redirect('/login');
        return;
      }
      next();
    },

    requireAdmin(req, res, next) {
      const user = auth.currentUser(req);
      if (!user) {
        if (isApiRequest(req)) {
          res.status(401).json({ error: 'Not signed in' });
          return;
        }
        res.redirect('/login');
        return;
      }
      if (!user.isAdmin) {
        res.status(403).json({ error: 'Admin rights required' });
        return;
      }
      next();
    },
  };

  return auth;
}
