import { describe, expect, it } from "vitest";
import { wecomPlugin } from "../channel.js";
import {
  listWecomAccountIds,
  resolveDefaultWecomAccountId,
  resolveWecomAccountConflict,
  resolveWecomAccounts,
} from "./accounts.js";

/**
 * The shape a 2.7.x production install actually carries: several accounts, each with the
 * nested `bot` / `agent` blocks, plus root keys nobody reads any more (`mediaMaxMb`,
 * `streaming`). 3.0.0-v1/v2 rejected this config outright and the gateway would not start;
 * this pins the contract that unknown keys never do that here.
 */
const productionShapedConfig = {
  channels: {
    wecom: {
      enabled: true,
      defaultAccount: "main",
      mediaMaxMb: 50,
      streaming: { preview: true },
      media: { localRoots: ["/srv/company-share"] },
      dynamicAgents: { enabled: true, dmCreateAgent: true, groupEnabled: true, adminUsers: ["admin"] },
      accounts: Object.fromEntries(
        ["main", "knowledge", "market", "project"].map((id, index) => [
          id,
          {
            enabled: true,
            name: `账号-${id}`,
            bot: {
              primaryTransport: "ws",
              ws: { botId: `bot-${id}`, secret: `secret-${id}` },
              dm: { policy: "open", allowFrom: ["*"] },
            },
            agent: {
              corpId: "corp-shared",
              agentSecret: `agent-secret-${id}`,
              agentId: 1000000 + index,
              token: `token-${id}`,
              encodingAESKey: `aes-${id}`,
              dm: { policy: "open", allowFrom: [] },
            },
          },
        ]),
      ),
    },
  },
} as never;

describe("production-shaped config", () => {
  it("passes the channel schema with keys the plugin does not read", () => {
    const schema = wecomPlugin.configSchema?.schema as { additionalProperties?: boolean };
    expect(schema.additionalProperties).toBe(true);
  });

  it("resolves every account with both Bot WS and Agent configured", () => {
    const resolved = resolveWecomAccounts(productionShapedConfig);
    expect(resolved.mode).toBe("matrix");
    expect(listWecomAccountIds(productionShapedConfig)).toEqual(["knowledge", "main", "market", "project"]);
    expect(resolveDefaultWecomAccountId(productionShapedConfig)).toBe("main");
    for (const id of ["main", "knowledge", "market", "project"]) {
      const account = resolved.accounts[id]!;
      expect(account.configured, id).toBe(true);
      expect(account.bot?.wsConfigured, id).toBe(true);
      expect(account.bot?.primaryTransport, id).toBe("ws");
      expect(account.agent?.configured, id).toBe(true);
      expect(resolveWecomAccountConflict({ cfg: productionShapedConfig, accountId: id })).toBeUndefined();
    }
  });
});
