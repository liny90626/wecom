import { describe, expect, it, vi } from "vitest";
import { appendSequentialTask } from "./send-queue.js";

describe("appendSequentialTask", () => {
  it("runs the current task once when that task fails", async () => {
    const task = vi.fn().mockRejectedValue(new Error("send failed"));
    await expect(appendSequentialTask(Promise.resolve(), task, vi.fn())).rejects.toThrow(
      "send failed",
    );
    expect(task).toHaveBeenCalledOnce();
  });

  it("recovers from the previous failure before running the next task", async () => {
    const onPreviousError = vi.fn();
    const task = vi.fn().mockResolvedValue(undefined);
    await appendSequentialTask(Promise.reject(new Error("previous failed")), task, onPreviousError);
    expect(onPreviousError).toHaveBeenCalledOnce();
    expect(task).toHaveBeenCalledOnce();
  });

  it("still runs the task when error bookkeeping throws", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    await appendSequentialTask(Promise.reject(new Error("previous failed")), task, () => {
      throw new Error("logger failed");
    });
    expect(task).toHaveBeenCalledOnce();
  });
});
