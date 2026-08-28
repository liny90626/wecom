import type { WSClient, WsFrame } from "@wecom/aibot-node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTemplateCardCacheForTests,
  getTemplateCardFromCache,
  sendTemplateCards,
  updateTemplateCardOnEvent,
} from "./manager.js";

const makeClient = () =>
  ({
    sendMessage: vi.fn().mockResolvedValue({}),
    updateTemplateCard: vi.fn().mockResolvedValue({}),
  }) as unknown as WSClient;

const voteCard = (taskId: string) => ({
  card_type: "vote_interaction",
  task_id: taskId,
  main_title: { title: "午饭" },
  checkbox: {
    question_key: "q1",
    mode: 0,
    option_list: [
      { id: "a", text: "面" },
      { id: "b", text: "饭" },
    ],
  },
  submit_button: { text: "提交", key: "k1" },
});

const frame = { headers: { req_id: "req-card" }, body: {} } as unknown as WsFrame;

describe("sendTemplateCards", () => {
  beforeEach(() => {
    __resetTemplateCardCacheForTests();
  });

  it("pushes each card and caches it for the interaction callback", async () => {
    const client = makeClient();
    const sent = await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "default",
      cards: [{ cardJson: voteCard("task-1"), cardType: "vote_interaction" }],
    });

    expect(sent).toBe(1);
    const [chatId, body] = (client.sendMessage as any).mock.calls[0];
    expect(chatId).toBe("alice");
    expect(body.msgtype).toBe("template_card");
    expect(body.chat_type).toBe(1);
    expect(getTemplateCardFromCache("default", "task-1")).toBeDefined();
  });

  it("marks a group send with chat_type 2", async () => {
    const client = makeClient();
    await sendTemplateCards({
      client,
      chatId: "group-1",
      chatType: "group",
      accountId: "default",
      cards: [{ cardJson: voteCard("task-group"), cardType: "vote_interaction" }],
    });
    expect((client.sendMessage as any).mock.calls[0][1].chat_type).toBe(2);
  });

  it("does not send a card whose core field the plugin cannot invent", async () => {
    const client = makeClient();
    const sent = await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "default",
      cards: [
        {
          cardJson: { card_type: "button_interaction", task_id: "t", main_title: { title: "x" } },
          cardType: "button_interaction",
        },
      ],
    });
    expect(sent).toBe(0);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps sending the rest after one card fails", async () => {
    const client = makeClient();
    (client.sendMessage as any)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({});
    const sent = await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "default",
      cards: [
        { cardJson: voteCard("task-fail"), cardType: "vote_interaction" },
        { cardJson: voteCard("task-ok"), cardType: "vote_interaction" },
      ],
    });
    expect(sent).toBe(1);
    expect(getTemplateCardFromCache("default", "task-fail")).toBeUndefined();
    expect(getTemplateCardFromCache("default", "task-ok")).toBeDefined();
  });

  it("keeps each account's cards apart", async () => {
    const client = makeClient();
    await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "acct-a",
      cards: [{ cardJson: voteCard("shared-task"), cardType: "vote_interaction" }],
    });
    expect(getTemplateCardFromCache("acct-a", "shared-task")).toBeDefined();
    expect(getTemplateCardFromCache("acct-b", "shared-task")).toBeUndefined();
  });
});

describe("updateTemplateCardOnEvent", () => {
  beforeEach(() => {
    __resetTemplateCardCacheForTests();
  });

  it("freezes the card on what the user actually picked", async () => {
    const client = makeClient();
    await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "default",
      cards: [{ cardJson: voteCard("task-vote"), cardType: "vote_interaction" }],
    });

    await updateTemplateCardOnEvent({
      client,
      frame,
      accountId: "default",
      userId: "alice",
      event: {
        task_id: "task-vote",
        selected_items: {
          selected_item: [{ question_key: "q1", option_ids: { option_id: ["b"] } }],
        },
      },
    });

    const [, updated, userids] = (client.updateTemplateCard as any).mock.calls[0];
    expect(updated.submit_button.text).toBe("已提交");
    expect(updated.checkbox.disable).toBe(true);
    expect(updated.checkbox.option_list).toEqual([
      { id: "a", text: "面", is_checked: false },
      { id: "b", text: "饭", is_checked: true },
    ]);
    expect(userids).toEqual(["alice"]);
  });

  it("writes the frozen card back so a second callback builds on it", async () => {
    const client = makeClient();
    await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "default",
      cards: [{ cardJson: voteCard("task-again"), cardType: "vote_interaction" }],
    });
    await updateTemplateCardOnEvent({
      client,
      frame,
      accountId: "default",
      event: { task_id: "task-again" },
    });
    expect(getTemplateCardFromCache("default", "task-again")?.submit_button?.text).toBe("已提交");
  });

  it("skips quietly when the card is not in the cache", async () => {
    // The cache is process-local, so a restart legitimately loses it. There is
    // nothing to restore the original card from, and failing helps nobody.
    const client = makeClient();
    await updateTemplateCardOnEvent({
      client,
      frame,
      accountId: "default",
      event: { task_id: "never-sent" },
    });
    expect(client.updateTemplateCard).not.toHaveBeenCalled();
  });

  it("skips a callback that carries no task_id", async () => {
    const client = makeClient();
    await updateTemplateCardOnEvent({ client, frame, accountId: "default", event: {} });
    expect(client.updateTemplateCard).not.toHaveBeenCalled();
  });

  it("does not mutate the cached card until the update succeeds", async () => {
    const client = makeClient();
    (client.updateTemplateCard as any).mockRejectedValueOnce(new Error("timeout"));
    await sendTemplateCards({
      client,
      chatId: "alice",
      chatType: "direct",
      accountId: "default",
      cards: [{ cardJson: voteCard("task-keep"), cardType: "vote_interaction" }],
    });
    await expect(
      updateTemplateCardOnEvent({
        client,
        frame,
        accountId: "default",
        event: { task_id: "task-keep" },
      }),
    ).rejects.toThrow("timeout");
    expect(getTemplateCardFromCache("default", "task-keep")?.submit_button?.text).toBe("提交");
  });
});
