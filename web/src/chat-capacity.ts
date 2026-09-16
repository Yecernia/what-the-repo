import type { Message, Project } from './types';

const encoder = new TextEncoder();

export function chatHistoryUsage(messages: readonly Message[]) {
  let rounds = 0;
  let bytes = 0;
  for (const message of messages) {
    // Rejected requests and streaming placeholders are not stored history.
    if (message.message_id.startsWith('client:')) continue;
    rounds += Number(message.role === 'user');
    bytes += encoder.encode(message.content).byteLength;
  }
  return { rounds, bytes };
}

export function chatCapacityReached(
  usage: ReturnType<typeof chatHistoryUsage>,
  limits: Project['chat_limits'],
  content = '',
): boolean {
  if (!limits) return false; // Older servers still enforce admission themselves.
  return usage.rounds >= limits.max_rounds
    || usage.bytes + encoder.encode(content.trim().slice(0, 20_000)).byteLength >= limits.max_content_bytes;
}

export function isChatCapacityError(code: unknown): boolean {
  return code === 'site_project_chat_round_limit' || code === 'site_project_chat_size_limit';
}
