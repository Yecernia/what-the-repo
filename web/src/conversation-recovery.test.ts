import { beforeEach, expect, it } from 'vitest';
import { CONVERSATION_RECOVERY_KEY, CONVERSATION_RECOVERY_TTL, findConversationRun, forgetConversationRun, rememberConversationRun } from './conversation-recovery';

beforeEach(() => localStorage.clear());
const run = { ownerId: 'one', projectId: 'p', snapshotId: 's', runId: 'r', startedAt: Date.now() };
it('stores only bounded descriptors without content or authorization', () => {
  for (let i = 0; i < 20; i++) rememberConversationRun({ ...run, projectId: String(i), content: 'secret' } as typeof run);
  const text = localStorage.getItem(CONVERSATION_RECOVERY_KEY)!;
  expect(JSON.parse(text)).toHaveLength(16);
  expect(text).not.toContain('secret');
});
it('isolates owner, project and snapshot, and expires old descriptors', () => {
  rememberConversationRun(run);
  expect(findConversationRun('one', 'other', 's').run).toBeUndefined();
  expect(findConversationRun('one', 'p', 'different').unavailable).toBe('snapshot');
  rememberConversationRun({ ...run, startedAt: Date.now() - CONVERSATION_RECOVERY_TTL });
  expect(findConversationRun('one', 'p', 's').unavailable).toBe('expired');
  rememberConversationRun(run);
  expect(findConversationRun('two', 'p', 's').run).toBeUndefined();
  expect(localStorage.getItem(CONVERSATION_RECOVERY_KEY)).toBe('[]');
});
it('clears only matching run and owner on terminal or logout', () => {
  rememberConversationRun(run);
  forgetConversationRun('one', 'p', 'different');
  expect(findConversationRun('one', 'p', 's').run?.runId).toBe('r');
  forgetConversationRun('one');
  expect(findConversationRun('one', 'p', 's').run).toBeUndefined();
});

it('retains only the bounded program action association for reconnecting before source persistence',()=>{
 rememberConversationRun({...run,lessonActionId:'action'});
 expect(findConversationRun('one','p','s').run).toMatchObject({runId:'r',lessonActionId:'action'});
 localStorage.setItem(CONVERSATION_RECOVERY_KEY,JSON.stringify([{...run,lessonActionId:{content:'untrusted'}}]));
 expect(findConversationRun('one','p','s').run).toBeUndefined();
});
