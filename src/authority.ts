import type { RiskAssessment } from './risk-policy.js';
import { requestLocalConfirmation } from './local-confirmations.js';

export type AuthorityRuntime = {
  allowExternalNetwork: boolean;
  highRiskConfirmationMode: 'local' | 'none' | 'none_with_computer_use';
  requireHighRiskConfirmation: boolean;
};

export type AuthorityDecision = {
  policy: 'allow' | 'confirm' | 'deny';
  approved: boolean;
  confirmationMode: 'local' | 'none';
  action: string;
  explanation: string;
  risk: RiskAssessment;
};

function confirmationMode(runtime: AuthorityRuntime): 'local' | 'none' {
  return (runtime.highRiskConfirmationMode === 'none'
    || runtime.highRiskConfirmationMode === 'none_with_computer_use'
    || runtime.requireHighRiskConfirmation === false) ? 'none' : 'local';
}

export async function authorizeOperation(input: {
  workspace: string;
  action: string;
  risk: RiskAssessment;
  runtime: AuthorityRuntime;
  localConfirmationAvailable: boolean;
  timeoutMs?: number;
}): Promise<AuthorityDecision> {
  const mode = confirmationMode(input.runtime);
  if (input.risk.networkIntent && !input.runtime.allowExternalNetwork) {
    return { policy: 'deny', approved: false, confirmationMode: mode, action: input.action, explanation: 'This operation requires external network access, but external network access is disabled for this Workspace.', risk: input.risk };
  }
  if (input.risk.level !== 'high' || mode === 'none') {
    return { policy: 'allow', approved: true, confirmationMode: mode, action: input.action, explanation: input.risk.level === 'high' ? 'High-risk confirmation is disabled by Workspace policy.' : 'Operation is classified as low risk.', risk: input.risk };
  }
  if (!input.localConfirmationAvailable) {
    return { policy: 'deny', approved: false, confirmationMode: mode, action: input.action, explanation: 'MCPort Desktop local confirmation is unavailable; this high-risk operation is denied.', risk: input.risk };
  }
  const approved = await requestLocalConfirmation(input.workspace, input.action, input.risk, input.timeoutMs);
  return {
    policy: 'confirm',
    approved,
    confirmationMode: mode,
    action: input.action,
    explanation: approved ? 'The operation was approved by MCPort Desktop local confirmation.' : 'The operation was denied or the local confirmation expired.',
    risk: input.risk,
  };
}
