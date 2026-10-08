import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { describeChatError, withAuthRetry } from '../src/llm.js';

/** Builds the error shape the OpenAI client throws for a status. */
function apiError(status: number): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, { error: { message: 'upstream detail' } }, 'boom', undefined);
}

describe('describeChatError', () => {
  it('names a credit problem, which an admin can act on', () => {
    expect(describeChatError(apiError(402))).toContain('too little credit');
  });

  it('names a rejected key separately from a credit problem', () => {
    expect(describeChatError(apiError(401))).toContain('did not accept the request');
    expect(describeChatError(apiError(403))).toContain('did not accept the request');
  });

  it('points at the model picker when the model is gone', () => {
    expect(describeChatError(apiError(404))).toContain('not available');
  });

  it('tells the user to retry when rate limited', () => {
    expect(describeChatError(apiError(429))).toContain('try again');
  });

  it('falls back to a generic message for an unknown failure', () => {
    expect(describeChatError(new Error('socket hang up'))).toBe(
      'Something went wrong while fetching the answer. Please try again.',
    );
  });

  it('never repeats the provider message, which may hold internals', () => {
    expect(describeChatError(apiError(402))).not.toContain('upstream detail');
  });
});

describe('withAuthRetry', () => {
  it('retries a 401 and returns the later success', async () => {
    let calls = 0;
    const result = await withAuthRetry(
      async () => {
        if (++calls < 3) throw apiError(401);
        return 'ok';
      },
      undefined,
      [0, 0],
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the last delay and throws the 401', async () => {
    let calls = 0;
    await expect(
      withAuthRetry(
        async () => {
          calls++;
          throw apiError(401);
        },
        undefined,
        [0, 0],
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(3);
  });

  it('does not retry other errors, which the SDK or the user handles', async () => {
    let calls = 0;
    await expect(
      withAuthRetry(async () => {
        calls++;
        throw apiError(402);
      }, undefined, [0, 0]),
    ).rejects.toMatchObject({ status: 402 });
    expect(calls).toBe(1);
  });
});
