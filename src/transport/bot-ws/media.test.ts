import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { fetchRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadAndSendBotWsMedia } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  detectMime: vi.fn(),
  fetchRemoteMedia: vi.fn(),
  getMediaDir: vi.fn(() => path.join(os.tmpdir(), "wecom-media-test-store")),
}));

describe("uploadAndSendBotWsMedia", () => {
  const fetchRemoteMediaMock = vi.mocked(fetchRemoteMedia);
  const buildWsClient = () =>
    ({
      uploadMedia: vi.fn().mockResolvedValue({ media_id: "media-1" }),
      sendMediaMessage: vi.fn().mockResolvedValue({ headers: { req_id: "req-1" } }),
    }) as unknown as WSClient & { uploadMedia: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fetchRemoteMediaMock.mockReset();
    fetchRemoteMediaMock.mockResolvedValue({
      buffer: Buffer.from("png"),
      contentType: "image/png",
      fileName: "sample.png",
    } as never);
  });

  it("passes the configured maxBytes to outbound media loading", async () => {
    const wsClient = buildWsClient();

    await uploadAndSendBotWsMedia({
      wsClient,
      chatId: "hidao",
      mediaUrl: "https://example.com/sample.png",
      maxBytes: 42 * 1024 * 1024,
    });

    expect(fetchRemoteMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/sample.png",
        maxBytes: 42 * 1024 * 1024,
      }),
    );
  });

  // The local-path guard used to be the SDK's assertLocalMediaAllowed, which
  // 2026.8.x made private. These pin the policy the replacement must keep.
  it("reads a local file that sits under an approved root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wecom-media-root-"));
    const filePath = path.join(root, "report.txt");
    await writeFile(filePath, "report body");
    const wsClient = buildWsClient();

    const result = await uploadAndSendBotWsMedia({
      wsClient,
      chatId: "hidao",
      mediaUrl: filePath,
      mediaLocalRoots: [root],
    });

    expect(result.ok).toBe(true);
    expect(wsClient.uploadMedia).toHaveBeenCalledWith(
      Buffer.from("report body"),
      expect.objectContaining({ filename: expect.stringContaining("report") }),
    );
  });

  it("refuses a local file outside every approved root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wecom-media-root-"));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "wecom-media-elsewhere-"));
    const filePath = path.join(elsewhere, "secret.txt");
    await writeFile(filePath, "nope");
    const wsClient = buildWsClient();

    const result = await uploadAndSendBotWsMedia({
      wsClient,
      chatId: "hidao",
      mediaUrl: filePath,
      mediaLocalRoots: [root],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not under an allowed directory");
    expect(wsClient.uploadMedia).not.toHaveBeenCalled();
  });

  // 2.7.260-26 routed local media through fs-safe's readLocalFileFromRoots and the
  // Windows production host lost every MEDIA: attachment for three days. These pin the
  // 2.7.260-25 semantics the local allowlist restores: realpath on both sides.
  it("accepts a file addressed through a symlinked root", async () => {
    const real = await mkdtemp(path.join(os.tmpdir(), "wecom-media-real-"));
    const linkParent = await mkdtemp(path.join(os.tmpdir(), "wecom-media-link-"));
    const linked = path.join(linkParent, "root-link");
    await symlink(real, linked, "dir");
    await writeFile(path.join(real, "chart.txt"), "chart body");
    const wsClient = buildWsClient();

    const result = await uploadAndSendBotWsMedia({
      wsClient,
      chatId: "hidao",
      mediaUrl: path.join(linked, "chart.txt"),
      mediaLocalRoots: [linked],
    });

    expect(result.ok).toBe(true);
    expect(wsClient.uploadMedia).toHaveBeenCalledWith(Buffer.from("chart body"), expect.anything());
  });

  it("refuses a symlink inside a root that points outside every root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wecom-media-root-"));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "wecom-media-elsewhere-"));
    await writeFile(path.join(elsewhere, "secret.txt"), "nope");
    await symlink(path.join(elsewhere, "secret.txt"), path.join(root, "innocent.txt"), "file");
    const wsClient = buildWsClient();

    const result = await uploadAndSendBotWsMedia({
      wsClient,
      chatId: "hidao",
      mediaUrl: path.join(root, "innocent.txt"),
      mediaLocalRoots: [root],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not under an allowed directory");
  });

  it("expands ~ the way the send-media skill shows it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "wecom-media-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await writeFile(path.join(home, "report.txt"), "home body");
      const wsClient = buildWsClient();

      const result = await uploadAndSendBotWsMedia({
        wsClient,
        chatId: "hidao",
        mediaUrl: "~/report.txt",
        mediaLocalRoots: [home],
      });

      expect(result.ok).toBe(true);
      expect(wsClient.uploadMedia).toHaveBeenCalledWith(Buffer.from("home body"), expect.anything());
    } finally {
      process.env.HOME = previousHome;
    }
  });
});
