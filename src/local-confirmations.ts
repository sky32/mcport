import { randomUUID } from 'node:crypto';
import type { RiskAssessment } from './risk-policy.js';

export type LocalConfirmation = {
  id: string;
  workspace: string;
  action: string;
  risk: Pick<RiskAssessment, 'categories' | 'reasons'>;
  expiresAt: string;
};

type PendingConfirmation = LocalConfirmation & {
  timer: NodeJS.Timeout;
  resolve: (approved: boolean) => void;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PENDING_CONFIRMATIONS = 100;
const pendingConfirmations = new Map<string, PendingConfirmation>();

function removeConfirmation(id: string, approved: boolean): boolean {
  const pending = pendingConfirmations.get(id);
  if (!pending) return false;
  pendingConfirmations.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(approved);
  return true;
}

export function requestLocalConfirmation(
  workspace: string,
  action: string,
  risk: RiskAssessment,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  if (pendingConfirmations.size >= MAX_PENDING_CONFIRMATIONS) return Promise.resolve(false);
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + boundedTimeoutMs).toISOString();

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => removeConfirmation(id, false), boundedTimeoutMs);
    timer.unref();
    pendingConfirmations.set(id, {
      id,
      workspace,
      action,
      risk: { categories: [...risk.categories], reasons: [...risk.reasons] },
      expiresAt,
      timer,
      resolve,
    });
  });
}

export function listLocalConfirmations(): LocalConfirmation[] {
  return [...pendingConfirmations.values()]
    .map(({ timer: _timer, resolve: _resolve, ...confirmation }) => confirmation)
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
}

export function resolveLocalConfirmation(id: string, approved: boolean): boolean {
  if (typeof id !== 'string' || typeof approved !== 'boolean') return false;
  return removeConfirmation(id, approved);
}
