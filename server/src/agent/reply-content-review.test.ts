import assert from 'node:assert/strict';
import test from 'node:test';
import { createModels, type Api, type Context, type Model } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { reviewReplyContent, REPLY_REVIEW_LIMITS } from './reply-content-review.js';
import { createModelRuntime } from './model-runtime.js';
import { resolveDeploymentProvider } from './provider-resolver.js';

// Controlled review outputs test the actual structured-worker submission pipeline.
// These examples do not measure a real model's semantic classification accuracy.
function runtime(first: string[], second?: string[]) {
  const faux = fauxProvider({ provider: 'reply-content-review-pipeline' });
  const models = createModels(); models.setProvider(faux.provider);
  let calls = 0;
  faux.setResponses([
    context => {
      calls++;
      assert.match(context.systemPrompt ?? '', /untrusted data/);
      assert.match(JSON.stringify(context.messages), /immutable_prose/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { action_control_spans: first.map(span => ({ block_kind: 'explanation', span })) }));
    },
    ...(second ? [(context: Context) => {
      calls++;
      const feedback = context.messages.find(message => message.role === 'toolResult');
      assert.ok(feedback, 'retry must receive real submit_result feedback');
      assert.match(JSON.stringify(feedback.content), /span_not_in_prose.*exactly/);
      return fauxAssistantMessage(fauxToolCall('submit_result', { action_control_spans: second.map(span => ({ block_kind: 'explanation', span })) }));
    }] : []),
  ]);
  return { modelRuntime: { models, model: faux.getModel() as Model<Api> }, calls: () => calls };
}

test('reply content pipeline accepts empty simulated findings for explanations, prior quotations and button descriptions', async () => {
  for (const text of [
    'map 返回一个新数组，slice 返回浅拷贝；数组元素若是对象，拷贝仍指向同一对象。',
    '之前说的“点确认后会跳过这一步”是旧话术示例，我们正在讨论这句话为什么容易误导。',
    '确认按钮用于提交用户选择，取消按钮用于放弃选择；这段只解释按钮用途。',
    '你要的确认题在下面，它换了个角度：',
    '下面这道题请用自己的话回答，不用复述代码。',
  ]) {
    const model = runtime([]);
    const result = await reviewReplyContent({ text, modelRuntime: model.modelRuntime });
    assert.equal(model.calls(), 1);
    assert.equal(result.completed, true);
    assert.deepEqual(result.findings.map(finding => finding.span), []);
    assert.equal(result.trace.skill_id, 'reply-content-review');
    assert.equal(result.trace.stop_reason, 'completed');
    assert.equal(result.trace.state_candidate, false);
  }
});

test('reply content pipeline preserves exact simulated current-confirmation spans', async () => {
  const span = '请点击确认跳过本步，确认后会进入下一步。';
  const model = runtime([span]);
  const result = await reviewReplyContent({ text: `这段代码遍历事件处理器。${span}`, modelRuntime: model.modelRuntime });
  assert.equal(model.calls(), 1);
  assert.equal(result.completed, true);
  assert.deepEqual(result.findings.map(finding => finding.span), [span]);
  assert.equal(result.trace.diagnostics?.submitAttempts, 1);
});

test('reply content pipeline gives exact-span feedback and accepts a corrected second submission', async () => {
  const span = '请点击 `确认` 后继续。';
  const model = runtime(['请点击确认后继续。'], [span]);
  const result = await reviewReplyContent({ text: `讲解仍然保留。${span}`, modelRuntime: model.modelRuntime });
  assert.equal(model.calls(), 2);
  assert.equal(result.completed, true);
  assert.deepEqual(result.findings.map(finding => finding.span), [span]);
  assert.equal(result.trace.diagnostics?.submitAttempts, 2);
  assert.equal(result.trace.diagnostics?.rejectedSubmissions, 1);
  assert.equal(result.trace.diagnostics?.requestCount, 2);
});

test('reply content pipeline fails closed when two non-exact submissions exhaust retries', async () => {
  const span = '请点击 `确认` 后继续。';
  for (const invalid of ['请点击确认后继续。', ` ${span} `, '   ']) {
    const model = runtime([invalid], [invalid]);
    const result = await reviewReplyContent({ text: span, modelRuntime: model.modelRuntime });
    assert.equal(model.calls(), 2);
    assert.equal(result.completed, false);
    assert.deepEqual(result.findings.map(finding => finding.span), []);
    assert.equal(result.trace.completed, false);
    assert.equal(result.trace.stop_reason, 'completed_with_validation_errors');
    assert.equal(result.trace.diagnostics?.submitAttempts, 2);
    assert.equal(result.trace.diagnostics?.rejectedSubmissions, 2);
  }
});

test('reply content pipeline makes at most two requests when the model never submits', async () => {
  const faux = fauxProvider({ provider: 'reply-content-review-no-submission' });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage('I am checking the prose.'),
    fauxAssistantMessage('I have still not submitted a result.'),
    fauxAssistantMessage(fauxToolCall('submit_result', { action_control_spans: [] })),
  ]);
  const result = await reviewReplyContent({ text: 'The explanation is retained.',
    modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(faux.state.callCount, 2, 'a later queued valid submission must not be requested');
  assert.equal(result.completed, false);
  assert.deepEqual(result.findings.map(finding => finding.span), []);
  assert.equal(result.trace.stop_reason, 'structured_output_missing');
  assert.equal(result.trace.diagnostics?.requestCount, 2);
  assert.equal(result.trace.diagnostics?.submitAttempts, 0);
});

test('reply content pipeline caps repeated unknown-tool calls at two model requests', async () => {
  const faux = fauxProvider({ provider: 'reply-content-review-unknown-tool-bound' });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage(fauxToolCall('nonexistent_tool', {}))));
  const result = await reviewReplyContent({ text: 'The explanation is retained.',
    modelRuntime: { models, model: faux.getModel() as Model<Api> } });
  assert.equal(faux.state.callCount, 2);
  assert.equal(result.completed, false);
  assert.deepEqual(result.findings.map(finding => finding.span), []);
  assert.equal(result.trace.stop_reason, 'worker_call_limit_exceeded');
  assert.equal(result.trace.diagnostics?.requestCount, 2);
  assert.equal(result.trace.diagnostics?.submitAttempts, 0);
  assert.equal(result.trace.diagnostics?.toolDispatchErrorCount, 2);
});

test('short reply classification sends a dedicated disabled-thinking/output budget and truncation fails closed', async () => {
  for (const truncated of [false, true]) {
    const config = resolveDeploymentProvider({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash', apiKey: 'test-only', connectionId: 'review-budget-test' })!;
    const modelRuntime = createModelRuntime(config);
    const bodies: Record<string, unknown>[] = [];
    modelRuntime.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const chunks = [
        { id: 'bounded', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, delta: { role: 'assistant',
          ...(truncated ? { content: 'incomplete' } : { tool_calls: [{ index: 0, id: 'result', type: 'function', function: { name: 'submit_result', arguments: '{"action_control_spans":[]}' } }] }) }, finish_reason: null }] },
        { id: 'bounded', object: 'chat.completion.chunk', created: 1, model: config.modelId,
          choices: [{ index: 0, delta: {}, finish_reason: truncated ? 'length' : 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: truncated ? 1536 : 12, total_tokens: truncated ? 1544 : 20 } },
      ];
      return new Response(chunks.map(row => 'data: ' + JSON.stringify(row) + '\n\n').join('') + 'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const text = '下面这道题请用自己的话回答，不用复述代码。';
    const result = await reviewReplyContent({ text, blocks: [{ kind: 'explanation', text }], action: null,
      replyKind: 'lesson', questionContext: 'new_question', modelRuntime });
    assert.equal(bodies.length, 1, 'a truncated classification terminates without spending a second request');
    for (const body of bodies) {
      assert.equal(body.max_tokens, REPLY_REVIEW_LIMITS.maxOutputTokens);
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.ok(!body.reasoning_effort);
    }
    assert.equal(result.completed, !truncated);
    assert.equal(result.trace.diagnostics!.requestCount, bodies.length);
    assert.ok(result.trace.diagnostics!.durationMs >= 0);
    assert.equal(result.trace.usage.outputTokens, truncated ? 1536 : 12);
    if (truncated) assert.equal(result.trace.stop_reason, 'worker_output_limit_exceeded');
    for (const request of result.trace.diagnostics!.requests) assert.equal(request.requestLimits!.wireMaxTokens, 1536);
  }
});

test('reply review carries source-tagged blocks and cannot return a span crossing two sources', async () => {
  const model = runtime(['评分。\n\n解释。'], []);
  const result = await reviewReplyContent({ text: '评分。\n\n解释。',
    blocks: [{ kind: 'assessment', text: '评分。' }, { kind: 'explanation', text: '解释。' }],
    action: { action: 'advance_learning_step', execution_policy: 'confirm', status: 'pending' },
    replyKind: 'action', modelRuntime: model.modelRuntime });
  assert.equal(result.completed, true);
  assert.equal(model.calls(), 2);
});

test('the reply checker deadline terminates a stalled provider and does not approve prose', { timeout: 25_000 }, async () => {
  const config = resolveDeploymentProvider({ providerId: 'deepseek', baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash', apiKey: 'test-only', connectionId: 'review-deadline-test' })!;
  const modelRuntime = createModelRuntime(config);
  let requests = 0;
  modelRuntime.fetch = async (_input, init) => {
    requests++;
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  // The SDK intentionally unrefs its timers; this keeps the isolated timeout test alive.
  const hold = setInterval(() => {}, 1000);
  try {
    const result = await reviewReplyContent({ text: '解释。', modelRuntime });
    assert.equal(result.completed, false);
    assert.deepEqual(result.findings, []);
    assert.equal(result.trace.stop_reason, 'worker_time_limit_exceeded');
    assert.equal(requests, 1);
    assert.equal(result.trace.diagnostics!.requestCount, 1);
    assert.ok(result.trace.diagnostics!.durationMs >= REPLY_REVIEW_LIMITS.timeoutMs - 50);
    assert.ok(result.trace.diagnostics!.durationMs < 23_000);
  } finally { clearInterval(hold); }
});
