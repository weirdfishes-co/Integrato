import { describe, expect, it } from 'vitest';

import type { Balance } from '../src/balance.js';
import type { User } from '../src/db/repo.js';
import { createViews } from '../src/views.js';

const views = createViews({ assistantName: 'Test Assistant', assistantLanguage: 'English' });

const admin: User = {
  id: 1,
  email: 'admin@example.com',
  isAdmin: true,
  createdAt: '',
  lastSeenAt: null,
};

const healthy: Balance = {
  totalCredits: 25,
  totalUsage: 5,
  remaining: 20,
  limit: null,
  limitRemaining: null,
  limitReset: null,
  isFreeTier: false,
};

function render(balance: Balance | null | undefined): string {
  return views.adminPage([admin], admin, { balance });
}

describe('admin balance panel', () => {
  it('shows the remaining balance', () => {
    const html = render(healthy);

    expect(html).toContain('OpenRouter balance');
    expect(html).toContain('$20.00');
    expect(html).toContain('balance--ok');
  });

  it('warns when the account is overdrawn', () => {
    const html = render({ ...healthy, totalCredits: 0, totalUsage: 0.14, remaining: -0.14 });

    expect(html).toContain('balance--empty');
    expect(html).toContain('-$0.14');
    expect(html).toContain('Out of credits');
  });

  it('warns when the balance is nearly gone', () => {
    const html = render({ ...healthy, remaining: 0.5 });

    expect(html).toContain('balance--low');
    expect(html).toContain('Running low.');
  });

  it('separates the key cap from the account balance', () => {
    const html = render({ ...healthy, limit: 12, limitRemaining: 11.86, limitReset: 'monthly' });

    expect(html).toContain('$11.86');
    expect(html).toContain('not money in the account');
  });

  it('says so when OpenRouter could not be reached', () => {
    const html = render(null);

    expect(html).toContain('Could not reach OpenRouter');
    expect(html).not.toContain('balance--');
  });

  it('omits the panel entirely when no balance was requested', () => {
    const html = render(undefined);

    expect(html).not.toContain('OpenRouter balance');
  });
});
