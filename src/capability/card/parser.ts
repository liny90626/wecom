/**
 * 模板卡片解析器。
 *
 * 从模型回复里抽出 markdown JSON 代码块，验证 `card_type` 合法后交给发送侧；
 * 另外给流式中间帧提供遮罩，避免 JSON 源码直接刷在用户面前。
 *
 * 移植自官方 `@wecom/wecom-openclaw-plugin@2026.8.17` 的
 * `src/template-card-parser.ts`。字段修正/补全规则逐条对齐官方——这些规则来自
 * 企微 API 的必填与类型约束，不是我们能自行简化的东西。与官方的唯一差异是日志：
 * 官方会把整张卡片 JSON 打进日志，本 fork 只记数量与 card_type，卡片正文可能
 * 含用户内容。
 */

/** 企微支持的卡片类型。不在表内的代码块一律当普通文本保留。 */
export const VALID_CARD_TYPES = [
  "text_notice",
  "news_notice",
  "button_interaction",
  "vote_interaction",
  "multiple_interaction",
] as const;

export type ExtractedTemplateCard = {
  /** 已归一化、可直接发送的卡片 JSON */
  cardJson: Record<string, unknown>;
  cardType: string;
};

export type TemplateCardExtractionResult = {
  cards: ExtractedTemplateCard[];
  /** 移除卡片代码块后的剩余正文 */
  remainingText: string;
};

/** 中间帧里替换卡片代码块的占位文案。 */
export const TEMPLATE_CARD_MASK_TEXT = "📋 *正在生成卡片消息...*";

function coerceToInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim().toLowerCase());
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return undefined;
}

function coerceToBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1" || trimmed === "yes") return true;
    if (trimmed === "false" || trimmed === "0" || trimmed === "no") return false;
  }
  if (typeof value === "number") return value !== 0;
  return undefined;
}

/** `checkbox.mode` 的语义别名。模型很容易写 "multi" 而不是 1。 */
const MODE_ALIASES: Record<string, number> = {
  single: 0,
  radio: 0,
  单选: 0,
  multi: 1,
  multiple: 1,
  多选: 1,
};

/** `mode` 只允许 0（单选）/ 1（多选），越界一律 clamp；认不出就删掉走服务端默认值。 */
function coerceCheckboxMode(value: unknown): number | undefined {
  let num: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    num = Math.round(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed in MODE_ALIASES) return MODE_ALIASES[trimmed];
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) num = Math.round(parsed);
  }
  if (num === undefined) return undefined;
  return num <= 0 ? 0 : 1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fixIntField(container: Record<string, unknown> | undefined, key: string): void {
  if (!container || !(key in container)) return;
  const fixed = coerceToInt(container[key]);
  if (fixed !== undefined) container[key] = fixed;
}

function fixBoolField(container: Record<string, unknown> | undefined, key: string): void {
  if (!container || !(key in container)) return;
  const fixed = coerceToBool(container[key]);
  if (fixed !== undefined) container[key] = fixed;
}

function fixIntFieldInList(value: unknown, key: string): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    fixIntField(asRecord(entry), key);
  }
}

/**
 * 把模型可能写歪的字段类型修回企微 API 要求的形态。
 * 原则与官方一致：能修就修，修不了就删（走服务端默认值），绝不因此阻塞发送。
 */
function normalizeTemplateCardFields(card: Record<string, unknown>): void {
  const checkbox = asRecord(card.checkbox);
  if (checkbox) {
    if ("mode" in checkbox) {
      const fixed = coerceCheckboxMode(checkbox.mode);
      if (fixed === undefined) {
        delete checkbox.mode;
      } else {
        checkbox.mode = fixed;
      }
    }
    fixBoolField(checkbox, "disable");
    if (Array.isArray(checkbox.option_list)) {
      for (const option of checkbox.option_list) {
        fixBoolField(asRecord(option), "is_checked");
      }
    }
  }

  fixIntField(asRecord(card.source), "desc_color");
  fixIntField(asRecord(card.card_action), "type");
  fixIntField(asRecord(card.quote_area), "type");
  fixIntField(asRecord(card.image_text_area), "type");
  fixIntFieldInList(card.horizontal_content_list, "type");
  fixIntFieldInList(card.jump_list, "type");
  fixIntFieldInList(card.button_list, "style");
  fixBoolField(asRecord(card.button_selection), "disable");
  if (Array.isArray(card.select_list)) {
    for (const selection of card.select_list) {
      fixBoolField(asRecord(selection), "disable");
    }
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** `question_key` / `submit_button.key` 都要求同一机器人内唯一。 */
function generateKey(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomSuffix()}`;
}

/**
 * 补齐企微 API 的必填字段。
 *
 * `task_id` 无论模型给没给都重新生成：模型很爱编造时间戳，重复的 task_id 会让
 * 卡片回调更新命中错误的缓存条目。这里只保留模型写的语义前缀。
 */
function validateAndFixRequiredFields(card: Record<string, unknown>): void {
  const cardType = String(card.card_type);
  const rawTaskId =
    typeof card.task_id === "string" && card.task_id.trim() ? card.task_id.trim() : "";
  const stamp = `${Date.now()}_${randomSuffix()}`;
  if (rawTaskId) {
    const prefix = rawTaskId
      .replace(/_\d{8,}$/, "")
      .replace(/[^a-zA-Z0-9_\-@]/g, "_")
      .slice(0, 80);
    card.task_id = prefix ? `${prefix}_${stamp}` : `task_${cardType}_${stamp}`;
  } else {
    card.task_id = `task_${cardType}_${stamp}`;
  }

  const mainTitle = asRecord(card.main_title);
  const hasMainTitle = Boolean(
    mainTitle && typeof mainTitle.title === "string" && mainTitle.title.trim(),
  );
  const hasSubTitleText =
    typeof card.sub_title_text === "string" && card.sub_title_text.trim().length > 0;

  if (cardType === "text_notice") {
    // text_notice 要求 main_title.title 与 sub_title_text 至少填一个。
    if (!hasMainTitle && !hasSubTitleText) {
      card.sub_title_text = "通知";
    }
  } else {
    if (!mainTitle) {
      card.main_title = { title: "通知" };
    } else if (!hasMainTitle) {
      mainTitle.title = "通知";
    }
  }

  if (cardType === "text_notice" || cardType === "news_notice") {
    if (!asRecord(card.card_action)) {
      card.card_action = { type: 1, url: "https://work.weixin.qq.com" };
    }
  }

  if (cardType === "vote_interaction" || cardType === "multiple_interaction") {
    if (!asRecord(card.submit_button)) {
      card.submit_button = { text: "提交", key: generateKey(`submit_${cardType}`) };
    }
  }
}

/** 缺了这些字段卡片必然被服务端拒绝，但插件补不出来，只能报出来。 */
export function missingCoreFields(card: Record<string, unknown>): string | undefined {
  const cardType = String(card.card_type);
  if (cardType === "button_interaction") {
    const list = card.button_list;
    if (!Array.isArray(list) || list.length === 0) return "button_list";
  }
  if (cardType === "vote_interaction" && !asRecord(card.checkbox)) {
    return "checkbox";
  }
  if (cardType === "multiple_interaction") {
    const list = card.select_list;
    if (!Array.isArray(list) || list.length === 0) return "select_list";
  }
  return undefined;
}

function normalizeOptionList(
  options: unknown,
  limit: number,
): Array<{ id: string; text: string }> {
  if (!Array.isArray(options)) return [];
  return options.slice(0, limit).map((entry) => {
    const option = asRecord(entry) ?? {};
    return {
      id: String(option.id ?? option.value ?? `opt_${randomSuffix()}`),
      text: String(option.text ?? option.label ?? option.name ?? ""),
    };
  });
}

function adoptSimplifiedTitle(card: Record<string, unknown>): void {
  const title = typeof card.title === "string" ? card.title : undefined;
  const description = typeof card.description === "string" ? card.description : undefined;
  if (!title && !description) return;
  card.main_title = {
    ...(title ? { title } : {}),
    ...(description ? { desc: description } : {}),
  };
  delete card.title;
  delete card.description;
}

/**
 * `vote_interaction` 的简化格式 → 企微 API 格式。
 * 已经是 API 原始格式（有 `checkbox.option_list`）时原样透传。
 */
function transformVoteInteraction(card: Record<string, unknown>): void {
  const existing = asRecord(card.checkbox);
  if (existing && Array.isArray(existing.option_list)) return;
  const options = card.options;
  if (!Array.isArray(options) || options.length === 0) return;

  adoptSimplifiedTitle(card);
  card.checkbox = {
    question_key: generateKey("vote"),
    mode: coerceCheckboxMode(card.mode) ?? 0,
    option_list: normalizeOptionList(options, 20),
  };
  delete card.options;
  delete card.mode;

  card.submit_button = {
    text: typeof card.submit_text === "string" && card.submit_text ? card.submit_text : "提交",
    key: generateKey("submit_vote"),
  };
  delete card.submit_text;
  // 模型偶尔会杜撰这些字段，企微不认，留着只会被整张拒绝。
  delete card.vote_question;
  delete card.vote_option;
  delete card.vote_options;
}

/**
 * `multiple_interaction` 的简化格式 → 企微 API 格式。
 * 已经是 API 原始格式（有 `select_list[].option_list`）时原样透传。
 */
function transformMultipleInteraction(card: Record<string, unknown>): void {
  const existing = card.select_list;
  if (
    Array.isArray(existing) &&
    existing.length > 0 &&
    Array.isArray(asRecord(existing[0])?.option_list)
  ) {
    return;
  }
  const selectors = card.selectors;
  if (!Array.isArray(selectors) || selectors.length === 0) return;

  adoptSimplifiedTitle(card);
  card.select_list = selectors.slice(0, 3).map((entry, index) => {
    const selector = asRecord(entry) ?? {};
    return {
      question_key: generateKey(`sel_${index}`),
      title: String(selector.title ?? selector.label ?? `选择${index + 1}`),
      option_list: normalizeOptionList(selector.options, 10),
    };
  });
  delete card.selectors;

  card.submit_button = {
    text: typeof card.submit_text === "string" && card.submit_text ? card.submit_text : "提交",
    key: generateKey("submit_multi"),
  };
  delete card.submit_text;
}

function transformSimplifiedCard(card: Record<string, unknown>): void {
  const cardType = card.card_type;
  if (cardType === "vote_interaction") {
    transformVoteInteraction(card);
    return;
  }
  if (cardType === "multiple_interaction") {
    transformMultipleInteraction(card);
  }
}

/** ```json … ``` 或 ``` … ```；两种围栏模型都会写。 */
const CODE_BLOCK_RE = /```(?:json)?[^\S\n]*\n([\s\S]*?)\n```/g;
/** 尚未闭合的代码块尾巴——模型还在往外吐的那一段。 */
const UNCLOSED_BLOCK_RE = /```(?:json)?[^\S\n]*\n[\s\S]*$/;
/** 中间帧只看关键字，不做 JSON 解析：每帧都解析一遍不划算。 */
const CARD_TYPE_KEYWORD_RE = /["']card_type["']/;

/**
 * 从完整回复文本里抽出模板卡片。
 *
 * 解析失败或 `card_type` 不合法的代码块**保留在正文里**——那多半是模型在贴一段
 * 普通 JSON 给用户看，吞掉它就是丢内容。
 */
export function extractTemplateCards(text: string): TemplateCardExtractionResult {
  const cards: ExtractedTemplateCard[] = [];
  const blocksToRemove: string[] = [];

  CODE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const card = asRecord(parsed);
    const cardType = card?.card_type;
    if (
      !card ||
      typeof cardType !== "string" ||
      !(VALID_CARD_TYPES as readonly string[]).includes(cardType)
    ) {
      continue;
    }
    transformSimplifiedCard(card);
    normalizeTemplateCardFields(card);
    validateAndFixRequiredFields(card);
    cards.push({ cardJson: card, cardType });
    blocksToRemove.push(fullMatch);
  }

  let remainingText = text;
  for (const block of blocksToRemove) {
    remainingText = remainingText.replace(block, "");
  }
  remainingText = remainingText.replace(/\n{3,}/g, "\n\n").trim();

  return { cards, remainingText };
}

/**
 * 遮罩流式中间帧里的卡片代码块。
 *
 * 只做文本替换、不解析 JSON：中间帧一秒可能刷好几次，解析不值当，而且未闭合的
 * 块本来就解析不了。判据是块内出现 `card_type` 关键字。
 */
export function maskTemplateCardBlocks(text: string): string {
  CODE_BLOCK_RE.lastIndex = 0;
  let masked = text.replace(CODE_BLOCK_RE, (fullMatch, content: string) =>
    CARD_TYPE_KEYWORD_RE.test(content) ? `\n\n${TEMPLATE_CARD_MASK_TEXT}\n\n` : fullMatch,
  );

  const unclosed = UNCLOSED_BLOCK_RE.exec(masked);
  if (unclosed && CARD_TYPE_KEYWORD_RE.test(unclosed[0])) {
    masked = `${masked.slice(0, unclosed.index)}\n\n${TEMPLATE_CARD_MASK_TEXT}`;
  }
  return masked;
}

/** 正文里是否存在（哪怕还没闭合的）卡片代码块，用于决定要不要走遮罩。 */
export function containsTemplateCardBlock(text: string): boolean {
  return text.includes("```") && CARD_TYPE_KEYWORD_RE.test(text);
}
