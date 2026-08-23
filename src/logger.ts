import pino from 'pino';

/**
 * Structured JSON logging. No console.log anywhere else in the server —
 * Railway parses these lines as individual log events.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || 'info',
  redact: {
    paths: ['req.headers.cookie', 'token', '*.token', 'password', 'pass'],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
