import { Router } from 'express';

import type { Auth } from '../auth.js';
import { normalizeEmail, type Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import { logger } from '../logger.js';
import type { Mailer } from '../mail.js';
import { createRateLimiter } from '../rate-limit.js';
import type { Views } from '../views.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthRouteDeps {
  config: Config;
  repo: Repo;
  auth: Auth;
  mailer: Mailer;
  views: Views;
}

export function createAuthRouter({ config, repo, auth, mailer, views }: AuthRouteDeps): Router {
  const router = Router();
  const limiter = createRateLimiter(5, 15 * 60 * 1000);

  router.get('/login', async (req, res) => {
    if (await auth.currentUser(req)) {
      res.redirect('/');
      return;
    }
    res.type('html').send(views.loginPage());
  });

  router.post('/login', async (req, res, next) => {
    try {
      const raw = typeof req.body?.email === 'string' ? req.body.email : '';
      const email = normalizeEmail(raw);

      if (!EMAIL_PATTERN.test(email)) {
        res.status(400).type('html').send(views.loginPage({ error: 'Enter a valid email address.', email: raw }));
        return;
      }

      if (!limiter.take(email) || !limiter.take(req.ip ?? 'unknown')) {
        res
          .status(429)
          .type('html')
          .send(views.loginPage({ error: 'Too many attempts. Try again in fifteen minutes.', email }));
        return;
      }

      const user = await repo.findUserByEmail(email);
      if (user) {
        const { token } = await auth.issueLoginToken(user);
        const link = `${config.appUrl}/auth/callback?token=${encodeURIComponent(token)}`;
        try {
          await mailer.sendMagicLink(user.email, link, config.loginTokenMinutes);
        } catch (error) {
          logger.error({ err: error, email }, 'sending the magic link failed');
          res
            .status(502)
            .type('html')
            .send(views.loginPage({ error: 'The email could not be sent. Try again later.', email }));
          return;
        }
      } else {
        // No error message: we do not leak which addresses are on the list.
        logger.info({ email }, 'sign-in attempt for unknown address');
      }

      res.type('html').send(views.linkSentPage(email));
    } catch (error) {
      next(error);
    }
  });

  router.get('/auth/callback', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const user = await auth.redeemLoginToken(token);

    if (!user) {
      res
        .status(400)
        .type('html')
        .send(views.loginPage({ error: 'This sign-in link has expired or was already used. Request a new one.' }));
      return;
    }

    await auth.startSession(res, user);
    logger.info({ userId: user.id }, 'user signed in');
    res.redirect('/');
  });

  router.post('/logout', async (req, res) => {
    await auth.endSession(req, res);
    res.redirect('/login');
  });

  return router;
}
