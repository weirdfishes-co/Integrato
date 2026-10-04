import type { NextFunction, Request, Response } from 'express';

import type { Config } from './config.js';
import { logger } from './logger.js';
import type { Views } from './views.js';

/**
 * HTTP-level defences that belong to every response rather than to a route.
 */

/** Methods that cannot change anything, so they need no origin check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A Content-Security-Policy strict enough to be worth having.
 *
 * `'self'` everywhere and nothing else is possible because the app fetches
 * nothing from anywhere: the fonts are self-hosted, there is no CDN, no
 * analytics and no inline `<script>` or `style=` attribute. It is the second
 * line behind the Markdown renderer's escaping — that code writes model output
 * into `innerHTML`, and a mistake there should not become script execution.
 *
 * `img-src` allows `data:` for the one inline SVG the chat uses. `frame-ancestors`
 * replaces X-Frame-Options for browsers that understand it; the header is sent
 * as well, for those that do not.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function securityHeaders() {
  return function headers(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Content-Security-Policy', CSP);
    // A .md document served from the knowledge base must not be sniffed into
    // something executable.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    /*
     * `same-origin`, and deliberately **not** `no-referrer`.
     *
     * The goal is the same — a sign-in token arrives in a query string and must
     * never leave in a Referer — and `same-origin` achieves it: nothing at all
     * is sent to another origin, while our own pages still see a full referrer.
     *
     * `no-referrer` looks stricter and breaks the site. It also makes the
     * browser send `Origin: null` on a *same-origin* form post, which the
     * origin guard below rightly reads as an opaque origin and refuses — so
     * every login returned 403. The unit tests could not see it, because they
     * fabricate headers rather than ask a browser. Verified with Chromium
     * driving a real form.
     */
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  };
}

/**
 * Refuses a state-changing request that came from another origin.
 *
 * The session cookie is `sameSite=lax`, which already stops a cross-*site* POST
 * from carrying it. This closes what that leaves open: SameSite treats every
 * subdomain of one registrable domain as the same site, so a page on a sibling
 * host — a marketing site, a staging box, anything compromised — can still post
 * to the app with an admin's cookie attached. An origin check does not care
 * about registrable domains.
 *
 * It compares against the request's own `Host` as well as `APP_URL`, because
 * `APP_URL` is frequently wrong in development (a dev server on another port)
 * and a mismatch there would reject every form on the site rather than protect
 * anything.
 *
 * A request with neither header is allowed: browsers always send `Origin` on a
 * POST, so this is a non-browser client, where cookies are not ambient and the
 * attack does not exist.
 */
export function createOriginGuard({ config, views }: { config: Config; views: Views }) {
  let expected: string | null = null;
  try {
    expected = new URL(config.appUrl).host;
  } catch {
    expected = null;
  }

  function refuse(req: Request, res: Response, source: string): void {
    logger.warn({ path: req.path, method: req.method, source }, 'cross-origin request refused');
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ error: 'Cross-origin request refused' });
      return;
    }
    res
      .status(403)
      .type('html')
      .send(views.errorPage(403, 'That request came from another site, so it was refused.'));
  }

  return function originGuard(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer;

    // "null" is an opaque origin — a sandboxed frame or a data: URL. Not ours.
    if (origin === 'null') {
      refuse(req, res, 'null');
      return;
    }

    const source = origin ?? referer;
    if (!source) {
      next();
      return;
    }

    let host: string | null = null;
    try {
      host = new URL(source).host;
    } catch {
      host = null;
    }

    if (host === null || (host !== expected && host !== req.headers.host)) {
      refuse(req, res, source);
      return;
    }

    next();
  };
}

/**
 * Warns once when a proxy is evidently in front but `TRUST_PROXY` is off.
 *
 * In that state `req.ip` is the proxy's address for everyone, so the per-IP
 * login limit counts every visitor as one client — a lockout waiting to happen,
 * and silent. The opposite mistake is worse, which is why the default is off,
 * so this says so rather than guessing.
 */
export function warnAboutProxy(config: Config) {
  let warned = false;

  return function proxyWarning(req: Request, _res: Response, next: NextFunction): void {
    if (!warned && !config.trustProxy && req.headers['x-forwarded-for']) {
      warned = true;
      logger.warn(
        'X-Forwarded-For is present but TRUST_PROXY is not set: req.ip is the proxy for every ' +
          'request, so the per-IP login limit treats all visitors as one client. Set TRUST_PROXY=1 ' +
          'if exactly one proxy sits in front.',
      );
    }
    next();
  };
}
