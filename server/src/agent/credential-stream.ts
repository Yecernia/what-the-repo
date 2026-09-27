import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { credentialRedactor } from '../security/secret-redaction.js';
import { providerDiagnosticMessage } from './provider-error.js';

type Delta = Extract<AssistantMessageEvent, { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta' }>;
/** Filter before Agent events, sessions, tool arguments or application traces see output. */
export async function* credentialSafeEvents(source: AsyncIterable<AssistantMessageEvent>, secrets: string[]): AsyncGenerator<AssistantMessageEvent> {
  const redactor = credentialRedactor(secrets);
  const channels = new Map<string, { stream: ReturnType<typeof redactor.stream>; template: Delta }>();
  let replayChanged = false;
  for await (const raw of source) {
    const event = redactor.data(raw);
    const originalMessage = 'partial' in raw ? raw.partial : raw.type === 'done' ? raw.message : raw.error;
    const safeMessage = 'partial' in event ? event.partial : event.type === 'done' ? event.message : event.error;
    if (event.type === 'done' || event.type === 'error') {
      replayChanged ||= JSON.stringify(originalMessage.content) !== JSON.stringify(safeMessage.content);
    }
    const scrubJoined = (message: AssistantMessage) => {
      const blocks = message.content.filter(block => block.type === 'text');
      const joined = blocks.map(block => block.text).join('');
      const clean = redactor.text(joined);
      if (clean !== joined) {
        replayChanged = true;
        blocks.forEach((block, index) => { block.text = index ? '' : clean; });
      }
    };
    if ('partial' in event) scrubJoined(event.partial);
    else if (event.type === 'done') scrubJoined(event.message);
    else scrubJoined(event.error);
    if (raw.type === 'text_delta' || raw.type === 'thinking_delta' || raw.type === 'toolcall_delta') {
      const id = raw.type === 'text_delta' ? 'text_delta' : raw.type + ':' + raw.contentIndex;
      let channel = channels.get(id);
      if (!channel) {
        if (channels.size >= 128) throw new Error('provider_invalid_response');
        channel = { stream: redactor.stream(), template: event as Delta }; channels.set(id, channel);
      }
      channel.template = { ...event as Delta, delta: '' };
      const delta = channel.stream.push(raw.delta);
      if (delta) yield { ...channel.template, delta };
      continue;
    }
    if (raw.type === 'thinking_end' || raw.type === 'toolcall_end') {
      const id = raw.type.replace('_end', '_delta') + ':' + raw.contentIndex;
      const channel = channels.get(id);
      if (channel) {
        const delta = channel.stream.finish();
        if (delta) yield { ...channel.template, delta };        channels.delete(id);
      }
    }
    if (event.type === 'done') {
      for (const channel of channels.values()) {
        const delta = channel.stream.finish();
        if (delta) yield { ...channel.template, delta };
      }
      channels.clear();
    }
    if ((event.type === 'done' || event.type === 'error') && replayChanged) {
      // Sanitized content must never be replayed as though its signature were still valid.
      const message = event.type === 'done' ? event.message : event.error;
      message.content = message.content.filter(block => block.type !== 'thinking').map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        const { thoughtSignature: _signature, ...tool } = block;
        return tool;
      });
      if (event.type === 'done' && originalMessage.content.some(block => block.type === 'thinking' && block.thinkingSignature)) {
        // Stop this turn rather than execute tools with altered signed reasoning.
        yield { type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: 'provider_invalid_response' } };
        continue;
      }
    }
    if (event.type === 'error') {
      channels.clear();
      event.error.errorMessage = providerDiagnosticMessage(raw.type === 'error' ? raw.error.errorMessage : undefined);
    }
    yield event;
  }
}
