import type { ResolvedAgentAccount } from "../../types/index.js";
import type { WecomTarget } from "../../target.js";
import { sendAgentApiMedia, sendAgentApiText } from "./client.js";

export async function sendAgentApiTextReply(params: {
  agent: ResolvedAgentAccount;
  target: WecomTarget;
  text: string;
}): Promise<void> {
  await sendAgentApiText({
    agent: params.agent,
    toUser: params.target.touser,
    toParty: params.target.toparty,
    toTag: params.target.totag,
    chatId: params.target.chatid,
    text: params.text,
  });
}

export async function sendAgentApiMediaReply(params: {
  agent: ResolvedAgentAccount;
  target: WecomTarget;
  mediaId: string;
  mediaType: "image" | "voice" | "video" | "file";
  title?: string;
  description?: string;
}): Promise<void> {
  await sendAgentApiMedia({
    agent: params.agent,
    toUser: params.target.touser,
    toParty: params.target.toparty,
    toTag: params.target.totag,
    chatId: params.target.chatid,
    mediaId: params.mediaId,
    mediaType: params.mediaType,
    title: params.title,
    description: params.description,
  });
}
