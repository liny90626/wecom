import { describe, expect, it } from "vitest";

import {
  containsTemplateCardBlock,
  extractTemplateCards,
  maskTemplateCardBlocks,
  missingCoreFields,
} from "./parser.js";

const fence = (body: string, lang = "json"): string => "```" + lang + "\n" + body + "\n```";

describe("extractTemplateCards", () => {
  it("pulls a valid card out and leaves the surrounding prose", () => {
    const text = [
      "已经安排好了。",
      fence(JSON.stringify({ card_type: "text_notice", main_title: { title: "发布通知" } })),
      "有问题随时说。",
    ].join("\n\n");

    const { cards, remainingText } = extractTemplateCards(text);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.cardType).toBe("text_notice");
    expect(remainingText).toBe("已经安排好了。\n\n有问题随时说。");
    expect(remainingText).not.toContain("card_type");
  });

  it("keeps a plain JSON block the user is meant to read", () => {
    // Not every fenced JSON block is a card. Swallowing one would delete
    // content the model deliberately showed the user.
    const text = ["配置如下：", fence(JSON.stringify({ retries: 3 }))].join("\n\n");
    const { cards, remainingText } = extractTemplateCards(text);
    expect(cards).toEqual([]);
    expect(remainingText).toContain('"retries"');
  });

  it("keeps a block whose card_type is not a WeCom card type", () => {
    const text = fence(JSON.stringify({ card_type: "not_a_real_card", main_title: { title: "x" } }));
    const { cards, remainingText } = extractTemplateCards(text);
    expect(cards).toEqual([]);
    expect(remainingText).toContain("not_a_real_card");
  });

  it("keeps an unparsable block instead of dropping it", () => {
    const text = fence('{ "card_type": "text_notice", ');
    const { cards, remainingText } = extractTemplateCards(text);
    expect(cards).toEqual([]);
    expect(remainingText).toContain("card_type");
  });

  it("extracts every card when the reply carries several", () => {
    const text = [
      fence(JSON.stringify({ card_type: "text_notice", main_title: { title: "一" } })),
      fence(JSON.stringify({ card_type: "news_notice", main_title: { title: "二" } })),
    ].join("\n\n");
    const { cards, remainingText } = extractTemplateCards(text);
    expect(cards.map((card) => card.cardType)).toEqual(["text_notice", "news_notice"]);
    expect(remainingText).toBe("");
  });

  it("regenerates task_id so a fabricated timestamp cannot collide", () => {
    const text = fence(
      JSON.stringify({
        card_type: "text_notice",
        task_id: "task_release_20260101",
        main_title: { title: "发布" },
      }),
    );
    const { cards } = extractTemplateCards(text);
    const taskId = String(cards[0]?.cardJson.task_id);
    // The model's semantic prefix survives; its invented timestamp does not.
    expect(taskId.startsWith("task_release_")).toBe(true);
    expect(taskId).not.toBe("task_release_20260101");
    expect(taskId).toMatch(/^[a-zA-Z0-9_\-@]+$/);
  });

  it("coerces field types WeCom would otherwise reject", () => {
    const text = fence(
      JSON.stringify({
        card_type: "vote_interaction",
        main_title: { title: "投票" },
        checkbox: {
          question_key: "q1",
          mode: "多选",
          disable: "false",
          option_list: [{ id: "a", text: "A", is_checked: "true" }],
        },
        card_action: { type: "1", url: "https://example.com" },
        button_list: [{ text: "确定", key: "k", style: "2" }],
      }),
    );
    const card = extractTemplateCards(text).cards[0]?.cardJson as Record<string, any>;
    expect(card.checkbox.mode).toBe(1);
    expect(card.checkbox.disable).toBe(false);
    expect(card.checkbox.option_list[0].is_checked).toBe(true);
    expect(card.card_action.type).toBe(1);
    expect(card.button_list[0].style).toBe(2);
  });

  it("drops an unrecognisable checkbox mode instead of sending a bad value", () => {
    const text = fence(
      JSON.stringify({
        card_type: "vote_interaction",
        main_title: { title: "投票" },
        checkbox: { question_key: "q", mode: "随便", option_list: [{ id: "a", text: "A" }] },
      }),
    );
    const card = extractTemplateCards(text).cards[0]?.cardJson as Record<string, any>;
    expect("mode" in card.checkbox).toBe(false);
  });

  it("expands the simplified vote format into the API shape", () => {
    const text = fence(
      JSON.stringify({
        card_type: "vote_interaction",
        title: "午饭吃什么",
        description: "选一个",
        mode: "single",
        options: [
          { id: "a", text: "面" },
          { value: "b", label: "饭" },
        ],
        submit_text: "投票",
      }),
    );
    const card = extractTemplateCards(text).cards[0]?.cardJson as Record<string, any>;
    expect(card.main_title).toEqual({ title: "午饭吃什么", desc: "选一个" });
    expect(card.checkbox.mode).toBe(0);
    expect(card.checkbox.option_list).toEqual([
      { id: "a", text: "面" },
      { id: "b", text: "饭" },
    ]);
    expect(card.checkbox.question_key).toMatch(/^vote_/);
    expect(card.submit_button.text).toBe("投票");
    expect(card.options).toBeUndefined();
    expect(card.title).toBeUndefined();
  });

  it("leaves an already-API-shaped vote card alone", () => {
    const text = fence(
      JSON.stringify({
        card_type: "vote_interaction",
        main_title: { title: "投票" },
        checkbox: { question_key: "keep-me", mode: 1, option_list: [{ id: "a", text: "A" }] },
        submit_button: { text: "提交", key: "keep-key" },
      }),
    );
    const card = extractTemplateCards(text).cards[0]?.cardJson as Record<string, any>;
    expect(card.checkbox.question_key).toBe("keep-me");
    expect(card.submit_button.key).toBe("keep-key");
  });

  it("expands the simplified multiple-selector format and clamps the limits", () => {
    const selectors = Array.from({ length: 5 }, (_, index) => ({
      title: `选择${index}`,
      options: Array.from({ length: 12 }, (_, optionIndex) => ({
        id: `o${optionIndex}`,
        text: `选项${optionIndex}`,
      })),
    }));
    const text = fence(JSON.stringify({ card_type: "multiple_interaction", selectors }));
    const card = extractTemplateCards(text).cards[0]?.cardJson as Record<string, any>;
    // WeCom caps at 3 selectors and 10 options each; sending more is rejected.
    expect(card.select_list).toHaveLength(3);
    expect(card.select_list[0].option_list).toHaveLength(10);
    expect(card.selectors).toBeUndefined();
  });

  it("fills the required fields each card type cannot be sent without", () => {
    const notice = extractTemplateCards(fence(JSON.stringify({ card_type: "text_notice" })))
      .cards[0]?.cardJson as Record<string, any>;
    expect(notice.sub_title_text).toBe("通知");
    expect(notice.card_action).toEqual({ type: 1, url: "https://work.weixin.qq.com" });

    const news = extractTemplateCards(fence(JSON.stringify({ card_type: "news_notice" })))
      .cards[0]?.cardJson as Record<string, any>;
    expect(news.main_title).toEqual({ title: "通知" });
  });

  it("does not overwrite a title the model already provided", () => {
    const card = extractTemplateCards(
      fence(JSON.stringify({ card_type: "news_notice", main_title: { title: "真实标题" } })),
    ).cards[0]?.cardJson as Record<string, any>;
    expect(card.main_title.title).toBe("真实标题");
  });
});

describe("missingCoreFields", () => {
  it("names the field the plugin cannot invent", () => {
    expect(missingCoreFields({ card_type: "button_interaction" })).toBe("button_list");
    expect(missingCoreFields({ card_type: "vote_interaction" })).toBe("checkbox");
    expect(missingCoreFields({ card_type: "multiple_interaction", select_list: [] })).toBe(
      "select_list",
    );
    expect(missingCoreFields({ card_type: "text_notice" })).toBeUndefined();
  });
});

describe("maskTemplateCardBlocks", () => {
  it("replaces a closed card block with the placeholder", () => {
    const text = ["安排好了。", fence(JSON.stringify({ card_type: "text_notice" }))].join("\n\n");
    const masked = maskTemplateCardBlocks(text);
    expect(masked).not.toContain("card_type");
    expect(masked).toContain("正在生成卡片消息");
    expect(masked).toContain("安排好了。");
  });

  it("truncates a card block the model is still writing", () => {
    // The JSON only becomes sendable once the fence closes; until then every
    // intermediate frame would otherwise stream raw JSON at the user.
    const text = '安排好了。\n\n```json\n{\n  "card_type": "vote_interaction",\n  "opt';
    const masked = maskTemplateCardBlocks(text);
    expect(masked).not.toContain("card_type");
    expect(masked.endsWith("正在生成卡片消息...*")).toBe(true);
    expect(masked).toContain("安排好了。");
  });

  it("leaves an ordinary code block untouched", () => {
    const text = ["示例：", fence("const a = 1;", "ts")].join("\n\n");
    expect(maskTemplateCardBlocks(text)).toBe(text);
  });
});

describe("containsTemplateCardBlock", () => {
  it("is true only when a fence and the card_type key are both present", () => {
    expect(containsTemplateCardBlock('```json\n{"card_type":"text_notice"}\n```')).toBe(true);
    expect(containsTemplateCardBlock('讨论 "card_type" 这个字段')).toBe(false);
    expect(containsTemplateCardBlock("```ts\nconst a = 1;\n```")).toBe(false);
  });
});
