/**
 * 模板卡片的发送、缓存与回调更新。
 *
 * 移植自官方 `@wecom/wecom-openclaw-plugin@2026.8.17` 的
 * `src/template-card-manager.ts`。
 *
 * 缓存只在进程内：企微的卡片更新回调只带 `task_id`，不带卡片内容，要改按钮状态
 * 就必须拿到原卡片。重启后缓存为空，回调只能跳过——官方同样如此，不值得为它引入
 * 持久化。
 */
import type { TemplateCard, WSClient, WsFrame } from "@wecom/aibot-node-sdk";

import type { ExtractedTemplateCard } from "./parser.js";
import { missingCoreFields } from "./parser.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 300;
const LOG = "[wecom-card]";

type CacheEntry = { templateCard: TemplateCard; createdAt: number };

const sentCardsByTaskId = new Map<string, CacheEntry>();

function cacheKey(accountId: string, taskId: string): string {
  return `${accountId}:${taskId}`;
}

function cloneCard(card: TemplateCard): TemplateCard {
  return JSON.parse(JSON.stringify(card)) as TemplateCard;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of sentCardsByTaskId) {
    if (now - entry.createdAt >= CACHE_TTL_MS) {
      sentCardsByTaskId.delete(key);
    }
  }
  if (sentCardsByTaskId.size <= CACHE_MAX_SIZE) {
    return;
  }
  const oldestFirst = [...sentCardsByTaskId.entries()].sort(
    (left, right) => left[1].createdAt - right[1].createdAt,
  );
  for (const [key] of oldestFirst.slice(0, sentCardsByTaskId.size - CACHE_MAX_SIZE)) {
    sentCardsByTaskId.delete(key);
  }
}

export function saveTemplateCardToCache(accountId: string, templateCard: TemplateCard): void {
  const taskId = templateCard.task_id;
  if (!taskId) {
    return;
  }
  sentCardsByTaskId.set(cacheKey(accountId, taskId), {
    templateCard: cloneCard(templateCard),
    createdAt: Date.now(),
  });
  pruneCache();
}

export function getTemplateCardFromCache(
  accountId: string,
  taskId: string,
): TemplateCard | undefined {
  pruneCache();
  const cached = sentCardsByTaskId.get(cacheKey(accountId, taskId));
  return cached ? cloneCard(cached.templateCard) : undefined;
}

/** 仅供测试：清空进程内缓存。 */
export function __resetTemplateCardCacheForTests(): void {
  sentCardsByTaskId.clear();
}

type TemplateCardEventPayload = {
  task_id?: string;
  card_type?: string;
  selected_items?: {
    selected_item?: Array<{
      question_key?: string;
      option_ids?: { option_id?: string[] };
    }>;
  };
};

function buildSelectedOptionMap(event?: TemplateCardEventPayload): Map<string, string[]> {
  const selected = new Map<string, string[]>();
  for (const item of event?.selected_items?.selected_item ?? []) {
    const questionKey = item.question_key?.trim();
    if (!questionKey) continue;
    selected.set(questionKey, item.option_ids?.option_id?.filter(Boolean) ?? []);
  }
  return selected;
}

/**
 * 把用户这次的选择固化回卡片：禁用控件、把提交按钮改成「已提交」、勾上选中项。
 * 不这样做的话卡片会一直停在可点击状态，用户以为没提交成功。
 */
function applySelectedState(
  templateCard: TemplateCard,
  selected: Map<string, string[]>,
  event?: TemplateCardEventPayload,
): TemplateCard {
  const next = cloneCard(templateCard);
  if (event?.task_id) next.task_id = event.task_id;
  if (event?.card_type) next.card_type = event.card_type;
  if (next.submit_button?.text) next.submit_button.text = "已提交";

  if (next.checkbox?.question_key) {
    const ids = selected.get(next.checkbox.question_key) ?? [];
    next.checkbox.disable = true;
    if (Array.isArray(next.checkbox.option_list)) {
      next.checkbox.option_list = next.checkbox.option_list.map((option) => ({
        ...option,
        is_checked: ids.includes(option.id),
      }));
    }
  }

  if (Array.isArray(next.select_list)) {
    next.select_list = next.select_list.map((selection) => {
      const ids = selected.get(selection.question_key) ?? [];
      return { ...selection, disable: true, selected_id: ids[0] ?? selection.selected_id };
    });
  }

  if (next.button_selection?.question_key) {
    const ids = selected.get(next.button_selection.question_key) ?? [];
    next.button_selection.disable = true;
    if (ids[0]) next.button_selection.selected_id = ids[0];
  }

  return next;
}

/**
 * 处理 `template_card_event` 回调：把原卡片按用户选择更新回去。
 *
 * 缓存里没有对应 `task_id` 时直接返回——重启后旧卡片本就无从还原，报错没有意义。
 */
export async function updateTemplateCardOnEvent(params: {
  client: WSClient;
  frame: WsFrame;
  accountId: string;
  event?: TemplateCardEventPayload;
  userId?: string;
}): Promise<void> {
  const taskId = params.event?.task_id?.trim();
  if (!taskId) {
    return;
  }
  const cached = getTemplateCardFromCache(params.accountId, taskId);
  if (!cached) {
    console.info(
      `${LOG} update-skipped account=${params.accountId} taskId=${taskId} reason=not-in-cache`,
    );
    return;
  }
  const updated = applySelectedState(cached, buildSelectedOptionMap(params.event), params.event);
  // SDK 的形参类型叫 WsFrameHeaders，实际是 Pick<WsFrame,'headers'>——要的是整个
  // 帧，因为更新必须复用该事件的 req_id（且企微要求 5 秒内回复）。
  await params.client.updateTemplateCard(
    params.frame,
    updated,
    params.userId ? [params.userId] : undefined,
  );
  saveTemplateCardToCache(params.accountId, updated);
  console.info(`${LOG} updated account=${params.accountId} taskId=${taskId}`);
}

/**
 * 主动推送已抽出的卡片。
 *
 * 单张失败不阻塞其余卡片，也不阻塞正文投递：卡片是回复的附加形态，
 * 让整轮回复因为一张卡片失败而失败是更差的结果。返回成功发出的张数。
 */
export async function sendTemplateCards(params: {
  client: WSClient;
  chatId: string;
  chatType: "group" | "direct";
  accountId: string;
  cards: ExtractedTemplateCard[];
}): Promise<number> {
  let sent = 0;
  for (const card of params.cards) {
    const missing = missingCoreFields(card.cardJson);
    if (missing) {
      console.warn(
        `${LOG} send-skipped account=${params.accountId} cardType=${card.cardType} reason=missing-${missing}`,
      );
      continue;
    }
    const templateCard = card.cardJson as unknown as TemplateCard;
    try {
      await params.client.sendMessage(params.chatId, {
        msgtype: "template_card",
        template_card: templateCard,
        chat_type: params.chatType === "group" ? 2 : 1,
      } as Parameters<WSClient["sendMessage"]>[1]);
      sent += 1;
      saveTemplateCardToCache(params.accountId, templateCard);
      console.info(
        `${LOG} sent account=${params.accountId} cardType=${card.cardType} taskId=${templateCard.task_id ?? "n/a"}`,
      );
    } catch (error) {
      console.warn(
        `${LOG} send-failed account=${params.accountId} cardType=${card.cardType} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return sent;
}
