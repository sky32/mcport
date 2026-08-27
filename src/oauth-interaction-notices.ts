export type OAuthInteractionNotice = {
  id: string;
  workspace: string;
  clientName: string;
  clientId: string;
  openedAt: string;
  expiresAt: string;
};

const NOTICE_TTL_MS = 10 * 60 * 1000;
const notices = new Map<string, OAuthInteractionNotice>();

function cleanup(now = Date.now()): void {
  for (const [id, notice] of notices) {
    if (Date.parse(notice.expiresAt) <= now) notices.delete(id);
  }
}

export function recordOAuthInteractionNotice(input: {
  interactionId: string;
  workspace: string;
  clientName: string;
  clientId: string;
}): OAuthInteractionNotice {
  cleanup();
  const id = `${input.workspace}:${input.interactionId}`;
  const existing = notices.get(id);
  if (existing) return existing;
  const now = Date.now();
  const notice: OAuthInteractionNotice = {
    id,
    workspace: input.workspace,
    clientName: input.clientName || 'MCP Client',
    clientId: input.clientId,
    openedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + NOTICE_TTL_MS).toISOString(),
  };
  notices.set(id, notice);
  return notice;
}

export function listOAuthInteractionNotices(): OAuthInteractionNotice[] {
  cleanup();
  return [...notices.values()].sort((left, right) => left.openedAt.localeCompare(right.openedAt));
}

export function acknowledgeOAuthInteractionNotice(id: string): boolean {
  cleanup();
  return notices.delete(id);
}
