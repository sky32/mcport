import { createHash } from 'node:crypto';

export type LoopPattern = 'repeated_call' | 'repeated_failure' | 'stalled_validation';

export type LoopWarning = {
  detected: true;
  pattern: LoopPattern;
  attempts: number;
  hint: string;
};

const HINTS: Record<LoopPattern, string> = {
  repeated_call: 'The same tool call with identical arguments keeps returning the same result. Do not repeat this call; reuse the previous result and move to the next step.',
  repeated_failure: 'The same failing call was repeated without changes. Stop retrying it; re-read the error, analyze the root cause, and switch to a different approach.',
  stalled_validation: 'Validation keeps failing while the code stays unchanged. The current approach is not making progress; reconsider the strategy or restore a known-good checkpoint.',
};

const RING_SIZE = 24;
const TRIGGER_ATTEMPTS = 3;
const WARNING_TTL_MS = 5 * 60_000;

type CallRecord = {
  tool: string;
  argsHash: string;
  resultHash: string;
  ok: boolean;
};

type ValidationRecord = {
  diffHash: string;
  overall: 'pass' | 'fail';
};

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex').slice(0, 16);
}

/**
 * Server-side loop detection for agent sessions. Detection is advisory only:
 * the Runtime records tool-call and validation fingerprints per service+workspace
 * and appends warnings, but never blocks a call. Hosts stay in control of the loop.
 */
export class LoopDetector {
  private readonly calls = new Map<string, CallRecord[]>();
  private readonly validations = new Map<string, ValidationRecord[]>();
  private readonly lastWarning = new Map<string, { warning: LoopWarning; at: number }>();

  private recordList<T>(map: Map<string, T[]>, key: string, entry: T): T[] {
    const list = [...(map.get(key) ?? []), entry];
    const trimmed = list.length > RING_SIZE ? list.slice(list.length - RING_SIZE) : list;
    map.set(key, trimmed);
    return trimmed;
  }

  private emit(key: string, warning: LoopWarning): LoopWarning {
    this.lastWarning.set(key, { warning, at: Date.now() });
    return warning;
  }

  private trailingRepeats(list: CallRecord[], match: (item: CallRecord) => boolean): number {
    let count = 0;
    for (let index = list.length - 1; index >= 0 && match(list[index]); index -= 1) count += 1;
    return count;
  }

  recordToolCall(input: {
    serviceId: string;
    workspace: string | null;
    tool: string;
    arguments: unknown;
    resultOk: boolean;
    resultHash: string;
  }): LoopWarning | null {
    const key = `${input.serviceId}\0${input.workspace ?? ''}`;
    const argsHash = hash(input.arguments);
    const list = this.recordList(this.calls, key, {
      tool: input.tool,
      argsHash,
      resultHash: input.resultHash,
      ok: input.resultOk,
    });

    const sameCall = (item: CallRecord) => item.tool === input.tool && item.argsHash === argsHash;
    const repeats = this.trailingRepeats(list, sameCall);
    if (repeats >= TRIGGER_ATTEMPTS) {
      if (!input.resultOk) {
        return this.emit(key, { detected: true, pattern: 'repeated_failure', attempts: repeats, hint: HINTS.repeated_failure });
      }
      const sameResult = list.slice(-repeats).every((item) => item.resultHash === input.resultHash);
      if (sameResult) {
        return this.emit(key, { detected: true, pattern: 'repeated_call', attempts: repeats, hint: HINTS.repeated_call });
      }
    }
    return null;
  }

  recordValidation(input: {
    serviceId: string;
    workspace: string | null;
    diffHash: string;
    overall: 'pass' | 'fail';
  }): LoopWarning | null {
    const key = `${input.serviceId}\0${input.workspace ?? ''}`;
    const list = this.recordList(this.validations, key, { diffHash: input.diffHash, overall: input.overall });
    const trailing = this.trailingRepeats(
      list.map((item) => ({ ...item, ok: item.overall === 'pass', tool: 'validation', argsHash: item.diffHash, resultHash: item.diffHash })),
      (item) => item.argsHash === input.diffHash && !item.ok,
    );
    if (trailing >= TRIGGER_ATTEMPTS) {
      return this.emit(key, { detected: true, pattern: 'stalled_validation', attempts: trailing, hint: HINTS.stalled_validation });
    }
    return null;
  }

  activeWarning(serviceId: string, workspace: string | null): LoopWarning | null {
    // Workspace-less tool calls key under '' when the service only infers its Workspace,
    // while task tools query by the resolved name; surface the most recent of both.
    const candidates = [
      this.lastWarning.get(`${serviceId}\0${workspace ?? ''}`),
      workspace ? this.lastWarning.get(`${serviceId}\0`) : undefined,
    ].filter(Boolean) as Array<{ warning: LoopWarning; at: number }>;
    const freshest = candidates.filter((entry) => Date.now() - entry.at <= WARNING_TTL_MS)
      .sort((a, b) => b.at - a.at)[0];
    return freshest?.warning ?? null;
  }
}

export const loopDetector = new LoopDetector();
