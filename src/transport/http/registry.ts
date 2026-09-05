import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";

import type { ResolvedAgentAccount, TransportSessionPatch } from "../../types/index.js";
import { monitorState } from "../../monitor/state.js";
import type { WecomRuntimeAuditEvent, WecomRuntimeEnv, WecomWebhookTarget } from "../../types/runtime-context.js";
import { WEBHOOK_PATHS } from "../../types/constants.js";
import { normalizeWecomWebhookPath } from "./common.js";

export type AgentWebhookTarget = {
  agent: ResolvedAgentAccount;
  config: OpenClawConfig;
  runtimeEnv: WecomRuntimeEnv;
  path: string;
  touchTransportSession?: (patch: TransportSessionPatch) => void;
  auditSink?: (event: WecomRuntimeAuditEvent) => void;
};

const webhookTargets = new Map<string, WecomWebhookTarget[]>();
const agentTargets = new Map<string, AgentWebhookTarget[]>();

function ensurePruneTimer(): void {
  monitorState.startPruning();
}

function checkPruneTimer(): void {
  if (webhookTargets.size === 0 && agentTargets.size === 0) {
    monitorState.stopPruning();
  }
}

export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
  const key = normalizeWecomWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, normalizedTarget]);
  ensurePruneTimer();
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
    checkPruneTimer();
  };
}

export function registerAgentWebhookTarget(target: AgentWebhookTarget): () => void {
  const key = normalizeWecomWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = agentTargets.get(key) ?? [];
  agentTargets.set(key, [...existing, normalizedTarget]);
  ensurePruneTimer();
  return () => {
    const updated = (agentTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) agentTargets.set(key, updated);
    else agentTargets.delete(key);
    checkPruneTimer();
  };
}

export function getWecomWebhookTargets(path: string): WecomWebhookTarget[] {
  return webhookTargets.get(normalizeWecomWebhookPath(path)) ?? [];
}

export function getAgentWebhookTargets(path: string): AgentWebhookTarget[] {
  return agentTargets.get(normalizeWecomWebhookPath(path)) ?? [];
}

export function hasMatrixExplicitRoutesRegistered(): boolean {
  for (const [key, targets] of webhookTargets.entries()) {
    if (key.startsWith(`${WEBHOOK_PATHS.BOT_ALT}/`) && targets.some((target) => target.account.accountId !== DEFAULT_ACCOUNT_ID)) {
      return true;
    }
    if (
      key.startsWith(`${WEBHOOK_PATHS.BOT_PLUGIN}/`) &&
      targets.some((target) => target.account.accountId !== DEFAULT_ACCOUNT_ID)
    ) {
      return true;
    }
  }
  for (const [key, targets] of agentTargets.entries()) {
    if (key.startsWith(`${WEBHOOK_PATHS.AGENT}/`) && targets.some((target) => target.agent.accountId !== DEFAULT_ACCOUNT_ID)) {
      return true;
    }
    if (
      key.startsWith(`${WEBHOOK_PATHS.AGENT_PLUGIN}/`) &&
      targets.some((target) => target.agent.accountId !== DEFAULT_ACCOUNT_ID)
    ) {
      return true;
    }
  }
  return false;
}
