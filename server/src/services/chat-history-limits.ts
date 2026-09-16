import type { Message } from '../domain/conversation.js';
import { serviceError } from './errors.js';

export const DEFAULT_CHAT_MAX_ROUNDS = 10_000;
export const DEFAULT_CHAT_MAX_CONTENT_BYTES = 100 * 1024 * 1024;

export interface ChatHistoryLimits {
  chatMaxRounds?: number;
  chatMaxContentBytes?: number;
}

/** Admission limits, not truncation: an admitted answer is always retained. */
export function assertChatHistoryCapacity(
  messages: readonly Message[],
  content: string,
  replaceMessageId: string | undefined,
  limits: ChatHistoryLimits,
): void {
  const replaceIndex = replaceMessageId === undefined ? -1
    : messages.findIndex(message => message.message_id === replaceMessageId);
  const retained = replaceIndex < 0 ? messages : messages.slice(0, replaceIndex);
  const rounds = retained.reduce((total, message) => total + Number(message.role === 'user'), 0);
  if (rounds >= (limits.chatMaxRounds ?? DEFAULT_CHAT_MAX_ROUNDS)) {
    throw serviceError('site_project_chat_round_limit', '此项目已达到聊天上限', 409);
  }
  const bytes = retained.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0)
    + Buffer.byteLength(content, 'utf8');
  if (bytes >= (limits.chatMaxContentBytes ?? DEFAULT_CHAT_MAX_CONTENT_BYTES)) {
    throw serviceError('site_project_chat_size_limit', '此项目已达到聊天上限', 409);
  }
}
