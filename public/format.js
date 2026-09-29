/**
 * Formatting for the numbers under an answer.
 *
 * Its own module so the rules can be tested: the cost of one answer is often a
 * few millionths of a dollar, and getting that wrong shows every answer as
 * either "$0.00" or a wall of digits.
 */

/**
 * A dollar figure, with as many places as the size of it needs.
 *
 * Two decimals is right for a bill and useless here — a cheap answer would read
 * as $0.00, which says "free" rather than "very little". So the precision
 * follows the amount, and an exact zero is written as one.
 */
export function formatCost(cost) {
  if (!Number.isFinite(cost) || cost === 0) return '$0';
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(6)}`;
}

/** Thousands separated, because these run to five figures. */
export function formatTokens(count) {
  return Number(count).toLocaleString('en-US');
}

/**
 * The line under an answer: what it consumed and what it cost. Reasoning and
 * cached tokens appear only when there were any — most models report neither,
 * and a row of zeroes would bury the two numbers that always matter.
 */
export function usageLine(usage) {
  const parts = [`${formatTokens(usage.promptTokens)} in`, `${formatTokens(usage.completionTokens)} out`];
  if (usage.reasoningTokens > 0) parts.push(`${formatTokens(usage.reasoningTokens)} thinking`);
  if (usage.cachedTokens > 0) parts.push(`${formatTokens(usage.cachedTokens)} cached`);
  parts.push(formatCost(usage.cost));
  return parts.join(' · ');
}

/** The same, summed over a conversation. Empty when nothing was recorded. */
export function totalsLine(messages) {
  const counted = messages.filter((message) => message.usage);
  if (counted.length === 0) return '';

  const tokens = counted.reduce(
    (sum, message) => sum + message.usage.promptTokens + message.usage.completionTokens,
    0,
  );
  const cost = counted.reduce((sum, message) => sum + message.usage.cost, 0);
  return `${formatTokens(tokens)} tokens · ${formatCost(cost)}`;
}
