import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createOriginGuard, securityHeaders, warnAboutProxy } from '../src/security.js';
import { createViews } from '../src/views.js';

const views = createViews({ assistantName: 'Integrato', assistantLanguage: 'English' });

function env(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_EMAILS: 'admin@example.com',
    ADMIN_PASSWORD: 'a-long-enough-password',
    DATABASE_URL: 'postgres://localhost/test',
    OPENROUTER_API_KEY: 'sk-or-test',
    EMAIL_ENCRYPTION_KEY: 'x'.repeat(32),
    APP_URL: 'https://chat.example.com',
    ...extra,
  } as NodeJS.ProcessEnv;
}

/** A response that records what a middleware did to it. */
function fakeResponse() {
  const headers = new Map<string, string>();
  const state = { status: 200, body: '' as unknown, ended: false };
  const res = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    status(code: number) {
      state.status = code;
      return this;
    },
    type() {
      return this;
    },
    send(body: unknown) {
      state.body = body;
      state.ended = true;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      state.ended = true;
      return this;
    },
  };
  return { res: res as unknown as Response, headers, state };
}

function request(method: string, headers: Record<string, string>, path = '/login'): Request {
  return { method, path, headers } as unknown as Request;
}

describe('security headers', () => {
  it('sends a policy that allows nothing off-origin', () => {
    const { res, headers } = fakeResponse();
    const next = vi.fn();
    securityHeaders()(request('GET', {}), res, next as unknown as NextFunction);

    const csp = headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // The whole point: no escape hatch for inline code.
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(next).toHaveBeenCalled();
  });

  it('sends the three companion headers', () => {
    const { res, headers } = fakeResponse();
    securityHeaders()(request('GET', {}), res, vi.fn() as unknown as NextFunction);

    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
  });

  /*
   * This one is load-bearing. `no-referrer` also makes a browser send
   * `Origin: null` on a same-origin form post, which the origin guard reads as
   * an opaque origin and refuses — together they rejected every login. It was
   * only visible with a real browser, because these tests fabricate headers.
   * `same-origin` sends nothing to other origins, which was the point.
   */
  it('uses same-origin referrer policy, never no-referrer', () => {
    const { res, headers } = fakeResponse();
    securityHeaders()(request('GET', {}), res, vi.fn() as unknown as NextFunction);

    expect(headers.get('referrer-policy')).toBe('same-origin');
  });
});

describe('the origin guard', () => {
  const config = loadConfig(env());
  const guard = createOriginGuard({ config, views });

  function run(req: Request) {
    const { res, state } = fakeResponse();
    const next = vi.fn();
    guard(req, res, next as unknown as NextFunction);
    return { passed: next.mock.calls.length === 1, status: state.status, body: state.body };
  }

  it('lets a same-origin form through', () => {
    expect(run(request('POST', { origin: 'https://chat.example.com' })).passed).toBe(true);
  });

  /*
   * The case SameSite=lax does not cover: a sibling host is the *same site*, so
   * the cookie would be sent. It is not the same origin.
   */
  it('refuses a sibling subdomain', () => {
    const result = run(request('POST', { origin: 'https://evil.example.com' }));

    expect(result.passed).toBe(false);
    expect(result.status).toBe(403);
  });

  it('refuses an unrelated site', () => {
    expect(run(request('POST', { origin: 'https://attacker.test' })).passed).toBe(false);
  });

  /* A sandboxed frame or a data: URL posts with an opaque origin. */
  it('refuses an opaque origin', () => {
    expect(run(request('POST', { origin: 'null' })).passed).toBe(false);
  });

  it('falls back to the referer when there is no origin', () => {
    expect(run(request('POST', { referer: 'https://chat.example.com/login' })).passed).toBe(true);
    expect(run(request('POST', { referer: 'https://attacker.test/x' })).passed).toBe(false);
  });

  /*
   * APP_URL is routinely wrong in development — a dev server on another port —
   * and rejecting every form then would protect nothing and break everything.
   * The request's own Host is the other accepted answer.
   */
  it('accepts the request’s own host even when APP_URL disagrees', () => {
    const req = request('POST', { origin: 'http://localhost:3001', host: 'localhost:3001' });

    expect(run(req).passed).toBe(true);
  });

  it('leaves safe methods alone', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(run(request(method, { origin: 'https://attacker.test' })).passed).toBe(true);
    }
  });

  /* Browsers always send Origin on a POST, so this is a non-browser client. */
  it('allows a request with neither header', () => {
    expect(run(request('POST', {})).passed).toBe(true);
  });

  it('answers an API path with JSON rather than a page', () => {
    const { res, state } = fakeResponse();
    guard(
      request('POST', { origin: 'https://attacker.test' }, '/api/coach/conversations'),
      res,
      vi.fn() as unknown as NextFunction,
    );

    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: 'Cross-origin request refused' });
  });
});

describe('TRUST_PROXY', () => {
  /*
   * Off by default: believing X-Forwarded-For with no proxy in front lets any
   * caller choose their own req.ip and walk past the per-IP login limit.
   */
  it('is off unless asked for', () => {
    expect(loadConfig(env()).trustProxy).toBe(false);
    expect(loadConfig(env({ TRUST_PROXY: '0' })).trustProxy).toBe(false);
    expect(loadConfig(env({ TRUST_PROXY: 'false' })).trustProxy).toBe(false);
  });

  it('takes a hop count or true', () => {
    expect(loadConfig(env({ TRUST_PROXY: '1' })).trustProxy).toBe(1);
    expect(loadConfig(env({ TRUST_PROXY: '2' })).trustProxy).toBe(2);
    expect(loadConfig(env({ TRUST_PROXY: 'true' })).trustProxy).toBe(true);
  });

  it('refuses a value that is neither', () => {
    expect(() => loadConfig(env({ TRUST_PROXY: 'yes-please' }))).toThrow(/TRUST_PROXY/);
  });

  /* Silent misconfiguration is the thing to avoid, so it says something. */
  it('warns once when a proxy is evidently in front but it is off', () => {
    const warn = warnAboutProxy(loadConfig(env()));
    const next = vi.fn();
    const { res } = fakeResponse();
    const req = request('GET', { 'x-forwarded-for': '203.0.113.9' });

    warn(req, res, next as unknown as NextFunction);
    warn(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(2);
  });
});
