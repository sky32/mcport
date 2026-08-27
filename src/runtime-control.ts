export type RuntimeControlMethod = 'health' | 'tool_catalog' | 'local_confirmations' | 'local_confirmation_decision' | 'oauth_interactions' | 'oauth_interaction_ack';

export type RuntimeControlRequest = {
  type: 'mcport:runtime-control-request';
  id: string;
  method: RuntimeControlMethod;
  params?: Record<string, unknown>;
};

export type RuntimeControlResponse = {
  type: 'mcport:runtime-control-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

type ParentPortLike = {
  on(event: 'message', listener: (event: { data?: unknown } | unknown) => void): void;
  postMessage(message: RuntimeControlResponse): void;
};

export function installRuntimeControlHandler(
  handler: (method: RuntimeControlMethod, params: Record<string, unknown>) => Promise<unknown>,
): boolean {
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
  if (!parentPort) return false;
  parentPort.on('message', (event) => {
    const raw = event && typeof event === 'object' && 'data' in event
      ? (event as { data?: unknown }).data
      : event;
    if (!raw || typeof raw !== 'object') return;
    const request = raw as Partial<RuntimeControlRequest>;
    if (request.type !== 'mcport:runtime-control-request' || typeof request.id !== 'string' || typeof request.method !== 'string') return;
    void handler(request.method as RuntimeControlMethod, request.params && typeof request.params === 'object' ? request.params : {})
      .then((result) => parentPort.postMessage({ type: 'mcport:runtime-control-response', id: request.id!, ok: true, result }))
      .catch((error) => parentPort.postMessage({
        type: 'mcport:runtime-control-response',
        id: request.id!,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
  });
  return true;
}
