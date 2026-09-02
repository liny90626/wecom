import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDynamicAgentListed, resetEnsuredCache } from "./dynamic-agent.js";

type Roster = {
  agents?: { list?: Array<{ id: string }>; entries?: Record<string, Record<string, unknown>> };
};

/**
 * The roster write moved from the deprecated `loadConfig`/`writeConfigFile`
 * pair (gone in OpenClaw 2026.8.x) to `current()` + `mutateConfigFile()`,
 * which both supported OpenClaw lines provide. 2026.8.x refuses to run an
 * agent that is not on the roster, so a skipped write is a broken agent.
 */
describe("ensureDynamicAgentListed", () => {
  afterEach(() => {
    resetEnsuredCache();
  });

  const buildRuntime = (cfg: Roster) => {
    const mutateConfigFile = vi.fn(
      async (params: { afterWrite: unknown; mutate: (draft: Roster) => void }) => {
        const draft = structuredClone(cfg);
        params.mutate(draft);
        Object.assign(cfg, draft);
        return { result: undefined };
      },
    );
    return { config: { current: () => cfg, mutateConfigFile }, mutateConfigFile };
  };

  it("adds a missing agent to agents.list through mutateConfigFile", async () => {
    const cfg: Roster = { agents: { list: [{ id: "main" }] } };
    const runtime = buildRuntime(cfg);

    await ensureDynamicAgentListed("wecom-user-1", runtime);

    expect(runtime.mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(runtime.mutateConfigFile.mock.calls[0]?.[0]).toMatchObject({
      afterWrite: { mode: "auto" },
    });
    expect(cfg.agents?.list?.map((entry) => entry.id)).toEqual(["main", "wecom-user-1"]);
  });

  it("skips the write when the agent is already listed", async () => {
    const cfg: Roster = { agents: { list: [{ id: "main" }, { id: "wecom-user-1" }] } };
    const runtime = buildRuntime(cfg);

    await ensureDynamicAgentListed("WeCom-User-1", runtime);

    expect(runtime.mutateConfigFile).not.toHaveBeenCalled();
    expect(cfg.agents?.list).toHaveLength(2);
  });

  it("extends agents.entries when the config is authored in the 2026.8.x shape", async () => {
    const cfg: Roster = { agents: { entries: { main: {} } } };
    const runtime = buildRuntime(cfg);

    await ensureDynamicAgentListed("wecom-user-1", runtime);

    expect(runtime.mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(Object.keys(cfg.agents?.entries ?? {})).toEqual(["main", "wecom-user-1"]);
    expect(cfg.agents?.list).toBeUndefined();
  });

  it("sees an agent already present in entries even when list is only a projection", async () => {
    const cfg: Roster = { agents: { entries: { main: {}, "wecom-user-1": {} } } };
    // 2026.8.x attaches `list` as a non-enumerable, read-only projection.
    Object.defineProperty(cfg.agents, "list", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: [{ id: "main" }, { id: "wecom-user-1" }],
    });
    const runtime = buildRuntime(cfg);

    await ensureDynamicAgentListed("wecom-user-1", runtime);

    expect(runtime.mutateConfigFile).not.toHaveBeenCalled();
  });

  it("does nothing on a runtime without a config mutator", async () => {
    await expect(ensureDynamicAgentListed("wecom-user-1", { config: {} })).resolves.toBeUndefined();
  });
});
