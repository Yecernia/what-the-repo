import assert from 'node:assert/strict';
import test from 'node:test';
import { displayForEvent, displayFromRecord } from './run-display.js';

test('UJ-03 submission is an answer phase on live events and persisted replay, independent of labels', () => {
  for (const type of ['tool_call_requested', 'tool_result_received'] as const) {
    const input = { type, summary: '正在核对回答与学习状态', toolName: 'submit_conversation_reply' };
    const live = displayForEvent(input);
    const replay = displayFromRecord({ stage: type, label: input.summary, tool_name: input.toolName });
    assert.equal(live.stage, 'answer');
    assert.equal(replay?.stage, 'answer');
    assert.equal(live.status, type === 'tool_call_requested' ? 'running' : 'completed');
  }
  assert.equal(displayForEvent({ type: 'tool_result_received', summary: '', toolName: 'submit_conversation_reply', isError: true }).status, 'failed');
  assert.equal(displayForEvent({ type: 'tool_call_requested', summary: '正在保存画像', toolName: 'update_learner_profile' }).stage, 'tool');
});
