import { vi } from "vitest";

export function createRuntimeEnv() {
  return {
    config: {
      loadConfig: () => ({}),
    },
    channel: {
      text: {
        chunkText: (text) => [text],
        chunkMarkdownText: (text) => [text],
        resolveMarkdownTableMode: () => "off",
        convertMarkdownTables: (text) => text,
      },
      commands: {
        shouldComputeCommandAuthorized: () => false,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
      pairing: {
        readAllowFromStore: async () => [],
      },
      reply: {
        finalizeInboundContext: (ctx) => ctx,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: () => "",
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => {}),
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "default", sessionKey: "default", accountId: "default" }),
      },
      session: {
        resolveStorePath: () => "",
        readSessionUpdatedAt: async () => 0,
        recordInboundSession: vi.fn(async () => {}),
      },
      media: {
        saveMediaBuffer: vi.fn(async () => ({
          path: "/tmp/wecom-test-media",
          contentType: "application/octet-stream",
        })),
        fetchRemoteMedia: vi.fn(async () => ({
          buffer: Buffer.from("media"),
          contentType: "application/octet-stream",
          fileName: "media.bin",
        })),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}
