import os from "node:os";
import path from "node:path";

export function resolveCliStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  return override || path.join(os.homedir(), ".openclaw");
}

export const resolveStateDir = resolveCliStateDir;
