import { randomUUID } from 'node:crypto';

export type DesktopAction = 'status' | 'screenshot' | 'move' | 'click' | 'drag' | 'type' | 'key' | 'scroll';

type DesktopActionResponse = {
  type: 'mcport:desktop-action-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type ParentPortLike = {
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): void;
  postMessage(message: unknown): void;
};

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let installed = false;

function parentPort(): ParentPortLike | null {
  return (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort ?? null;
}

function installResponseHandler(): void {
  if (installed) return;
  const port = parentPort();
  if (!port) return;
  installed = true;
  port.on('message', (event) => {
    const raw = event && typeof event === 'object' && 'data' in event ? (event as { data?: unknown }).data : event;
    if (!raw || typeof raw !== 'object') return;
    const response = raw as Partial<DesktopActionResponse>;
    if (response.type !== 'mcport:desktop-action-response' || typeof response.id !== 'string') return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error || 'Desktop action failed'));
  });
}

export function desktopActionAvailable(): boolean {
  installResponseHandler();
  return Boolean(parentPort());
}

export function requestDesktopAction<T>(
  action: DesktopAction,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
  source: 'local' | 'public' = 'local',
): Promise<T> {
  installResponseHandler();
  const port = parentPort();
  if (!port) return Promise.reject(new Error('MCPort Desktop action channel is unavailable'));
  const id = `desktop-action-${randomUUID()}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Desktop action timed out: ${action}`));
    }, timeoutMs);
    timer.unref();
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      port.postMessage({ type: 'mcport:desktop-action-request', id, action, params, source });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
