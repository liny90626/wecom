import { describe, expect, it, vi } from "vitest";
import { StreamExpiredError, sendWeComReply, sendWeComReplyNonBlocking } from "./message-sender.js";

describe("WeCom outbound diagnostics", () => {
  it("logs reply lifecycle and sizes without message text or transport ids", async () => {
    const replyStream = vi.fn().mockResolvedValue({ errcode: 0 });
    const wsClient = { isConnected: true, replyStream };
    const log = vi.fn();
    const secretText = "private reply text";
    const rawReqId = "raw-transport-request-id";

    await sendWeComReply({
      wsClient: wsClient as never,
      frame: {
        headers: { req_id: rawReqId },
        body: { msgid: "raw-message-id", msgtype: "text", from: { userid: "alice" } },
      } as never,
      text: secretText,
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      finish: true,
      streamId: "raw-stream-id",
      accountId: "sales",
      traceId: "safe-trace",
    });

    const output = log.mock.calls.flat().join("\n");
    expect(replyStream).toHaveBeenCalledOnce();
    expect(output).toContain("stage=outbound_start");
    expect(output).toContain("stage=outbound_delivered");
    expect(output).toContain("trace=safe-trace");
    expect(output).toContain("account=sales");
    expect(output).toContain(`textBytes=${Buffer.byteLength(secretText, "utf8")}`);
    expect(output).not.toContain(secretText);
    expect(output).not.toContain(rawReqId);
    expect(output).not.toContain("raw-message-id");
    expect(output).not.toContain("raw-stream-id");
  });

  it("explains why a non-blocking partial reply was skipped", async () => {
    const replyStreamNonBlocking = vi.fn().mockResolvedValue("skipped");
    const wsClient = { isConnected: true, replyStreamNonBlocking };
    const log = vi.fn();

    const result = await sendWeComReplyNonBlocking({
      wsClient: wsClient as never,
      frame: {
        headers: { req_id: "private-request" },
        body: { msgid: "private-message" },
      } as never,
      text: "private partial reply",
      runtime: { log, error: vi.fn(), exit: vi.fn() },
      streamId: "private-stream",
      accountId: "support",
      traceId: "safe-partial-trace",
    });

    const output = log.mock.calls.flat().join("\n");
    expect(result).toBe("skipped");
    expect(output).toContain("stage=outbound_start");
    expect(output).toContain("reason=previous_ack_pending");
    expect(output).toContain("account=support");
    expect(output).toContain("trace=safe-partial-trace");
    expect(output).not.toContain("private partial reply");
    expect(output).not.toContain("private-request");
    expect(output).not.toContain("private-message");
    expect(output).not.toContain("private-stream");
  });
});

describe("WeCom stream refusals", () => {
  const frame = {
    headers: { req_id: "req-1" },
    body: { msgid: "msg-1", msgtype: "text", from: { userid: "alice" } },
  } as never;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  it.each([
    [846608, "stream message update expired"],
    [846605, "invalid req_id"],
  ])("maps errcode %i to StreamExpiredError so the caller switches to an active push", async (errcode, errmsg) => {
    const replyStream = vi.fn().mockRejectedValue(Object.assign(new Error(errmsg), { errcode, errmsg }));

    await expect(
      sendWeComReply({
        wsClient: { isConnected: true, replyStream } as never,
        frame,
        text: "答案",
        runtime,
        finish: true,
        streamId: "stream-1",
      }),
    ).rejects.toBeInstanceOf(StreamExpiredError);
  });

  it("lets other gateway errors through unchanged", async () => {
    const failure = new Error("Reply ack timeout (5000ms) for reqId: req-1");
    const replyStream = vi.fn().mockRejectedValue(failure);

    await expect(
      sendWeComReply({
        wsClient: { isConnected: true, replyStream } as never,
        frame,
        text: "答案",
        runtime,
        finish: true,
        streamId: "stream-1",
      }),
    ).rejects.toBe(failure);
  });
});
