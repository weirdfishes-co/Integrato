import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { describeChatError } from '../src/llm.js';

/** Builds the error shape the OpenAI client throws for a status. */
function apiError(status: number): InstanceType<typeof OpenAI.APIError> {
  return new OpenAI.APIError(status, { error: { message: 'upstream detail' } }, 'boom', undefined);
}

describe('describeChatError', () => {
  it('names a credit problem, which an admin can act on', () => {
    expect(describeChatError(apiError(402))).toContain('too little credit');
  });

  it('names a rejected key separately from a credit problem', () => {
    expect(describeChatError(apiError(401))).toContain('key was rejected');
    expect(describeChatError(apiError(403))).toContain('key was rejected');
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
