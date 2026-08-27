export const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
export const MIN_MAX_OUTPUT_TOKENS = 256;
export const MAX_MAX_OUTPUT_TOKENS = 64_000;

export type OutputMeta = {
  truncated: boolean;
  budgetMode: 'utf8-byte-hard-limit';
  maxTokens: number;
  budgetUsed: number;
  returnedResults: number;
  totalResults: number | null;
  nextCursor: number | null;
  blockedByBudget: boolean;
  minimumRequiredBytes: number | null;
};

function safeUtf8End(buffer: Buffer, end: number): number {
  let safe = Math.min(buffer.length, Math.max(0, end));
  while (safe > 0 && safe < buffer.length && (buffer[safe] & 0xc0) === 0x80) safe -= 1;
  return safe;
}

export function pageTextByBudget(text: string, input: { cursor?: number; maxTokens: number }): { text: string; meta: OutputMeta } {
  const buffer = Buffer.from(text, 'utf8');
  const budget = Math.max(MIN_MAX_OUTPUT_TOKENS, Math.min(MAX_MAX_OUTPUT_TOKENS, Math.floor(input.maxTokens)));
  let start = Math.max(0, Math.min(buffer.length, Math.floor(input.cursor || 0)));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  const end = safeUtf8End(buffer, Math.min(buffer.length, start + budget));
  const hasMore = end < buffer.length;
  return {
    text: buffer.subarray(start, end).toString('utf8'),
    meta: {
      truncated: hasMore,
      budgetMode: 'utf8-byte-hard-limit',
      maxTokens: budget,
      budgetUsed: end - start,
      returnedResults: end > start ? 1 : 0,
      totalResults: null,
      nextCursor: hasMore ? end : null,
      blockedByBudget: false,
      minimumRequiredBytes: null,
    },
  };
}

export function truncateTextToBudget(text: string, maxTokens: number): {
  text: string;
  truncated: boolean;
  budgetUsed: number;
} {
  const budget = Math.max(MIN_MAX_OUTPUT_TOKENS, Math.min(MAX_MAX_OUTPUT_TOKENS, Math.floor(maxTokens)));
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= budget) return { text, truncated: false, budgetUsed: buffer.length };
  const end = safeUtf8End(buffer, budget);
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true, budgetUsed: end };
}

export function pageByBudget<T>(
  items: T[],
  input: {
    cursor?: number;
    maxResults: number;
    maxTokens: number;
    totalResults?: number | null;
  },
): { items: T[]; meta: OutputMeta } {
  const cursor = Math.max(0, Math.floor(input.cursor || 0));
  const budget = Math.max(MIN_MAX_OUTPUT_TOKENS, Math.min(MAX_MAX_OUTPUT_TOKENS, Math.floor(input.maxTokens)));
  const maxResults = Math.max(1, Math.floor(input.maxResults));
  const output: T[] = [];
  let used = 2; // []
  let index = cursor;
  let blockedByBudget = false;
  let minimumRequiredBytes: number | null = null;
  while (index < items.length && output.length < maxResults) {
    const item = items[index];
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + (output.length ? 1 : 0);
    if (output.length && used + bytes > budget) break;
    if (!output.length && bytes > budget) {
      blockedByBudget = true;
      minimumRequiredBytes = bytes;
      break;
    }
    output.push(item);
    used += bytes;
    index += 1;
  }
  const total = input.totalResults === undefined ? items.length : input.totalResults;
  const hasMore = index < items.length || (typeof total === 'number' && index < total);
  return {
    items: output,
    meta: {
      truncated: hasMore,
      budgetMode: 'utf8-byte-hard-limit',
      maxTokens: budget,
      budgetUsed: used,
      returnedResults: output.length,
      totalResults: total ?? null,
      nextCursor: hasMore ? index : null,
      blockedByBudget,
      minimumRequiredBytes,
    },
  };
}
