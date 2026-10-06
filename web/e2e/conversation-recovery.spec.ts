import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';

// Use real HTTP streams: response close events reveal a lost browser subscription.
// A deferred route.fulfill cannot distinguish a held socket from an aborted fetch.
for (const reload of [false, true]) {
  test(`R5-2 ${reload ? 'reload GET recovery' : 'ordinary POST'} holds its stream while another project is open`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(75_000);
    const now = new Date().toISOString();
    const summary = { project_id: 'recovery-project', title: 'Recovery fixture', source_kind: 'fixture', source_value: 'fixture', analysis_stage: 'done', teaching_phase: 'orienting', message_count: 0, updated_at: now };
    const other = { ...summary, project_id: 'other-project', title: 'Other fixture' };
    const user = { message_id: 'fixed-user', role: 'user', content: '恢复问题', created_at: now, evidence: [], model: null, usage: null, latency_ms: null, error: null, placeholder: false };
    let runId = '';
    let posts = 0;
    let gets = 0;
    let committed = false;
    let cancelled = false;
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const subscribers = new Set<ServerResponse>();
    const connections: Array<{ method: string; runId: string; opened: number; closed?: number }> = [];
    const assistant = () => ({ ...user, message_id: 'fixed-answer', role: 'assistant', content: '原run的最终回答', trace_id: runId, analysis_snapshot_id: 'snapshot' });
    const terminal = () => ({ user_message: user, assistant_message: assistant(), teaching_phase: 'orienting', validation_errors: [], tools_used: [], state_changed: false });
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://fixture').pathname;
      if (!path.startsWith('/api/')) {
        const proxy = httpRequest(new URL(request.url ?? '/', baseURL!), { method: request.method, headers: { ...request.headers, host: new URL(baseURL!).host } }, upstream => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        });
        proxy.on('error', () => { response.writeHead(502); response.end(); });
        request.pipe(proxy);
        return;
      }
      if (path.endsWith('/messages/stream') || /\/runs\/[^/]+\/stream$/.test(path)) {
        if (request.method === 'POST') {
          let raw = '';
          for await (const chunk of request) raw += chunk;
          posts++;
          const body = JSON.parse(raw);
          runId = body.run_id;
          expect(body.content).toBe(user.content);
        } else {
          gets++;
          expect(path).toBe(`/api/projects/recovery-project/runs/${runId}/stream`);
        }
        if (disconnectTimer) clearTimeout(disconnectTimer);
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        response.write(`event: connected\ndata: ${JSON.stringify({ run_id: runId, resumed: request.method === 'GET' })}\n\n`);
        subscribers.add(response);
        const connection = { method: request.method!, runId, opened: Date.now(), closed: undefined as number | undefined };
        connections.push(connection);
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 1_000);
        response.on('close', () => {
          clearInterval(heartbeat);
          connection.closed = Date.now();
          subscribers.delete(response);
          if (!committed && subscribers.size === 0) disconnectTimer = setTimeout(() => { cancelled = true; }, 30_000);
        });
        return;
      }
      let body: unknown = {};
      if (path === '/api/auth/config') body = { auth_mode: 'github', guest_enabled: true };
      else if (path === '/api/auth/me') body = { owner_id: 'owner:recovery', login: 'recovery', display_name: 'Recovery', kind: 'github', auth_mode: 'github', avatar_url: null };
      else if (path === '/api/projects') body = [summary, other];
      else if (path === '/api/settings') body = { model: 'fixture', has_api_key: true, thinking_level: 'medium', available_models: ['fixture'], providers: [], model_options: [], provider_presets: [], can_manage_api_key: true, api_key_management: 'interactive', free_experience_configured: true };
      else if (path === '/api/profile') body = { profile: { enabled: true, languages: [], goals: [], inferred: [], explanation_preference: '', experience_level: '', memory_summary: '' } };
      else if (path.endsWith('/snapshot')) body = { snapshot_id: 'snapshot', summary: { file_count: 0, symbol_count: 0, call_count: 0, component_count: 0 }, graph: { semantic_mode: 'empty', nodes: [], edges: [], layers: [], unassigned_component_ids: [] }, value_points: [], languages: [], learning_plan: { snapshot_id: 'snapshot', selected_value_point: null, steps: [] } };
      else if (path === '/api/projects/recovery-project' || path === '/api/projects/other-project') {
        const selected = path.endsWith('/other-project') ? other : summary;
        body = { snapshot_available: true, analysis_job: null, project: { ...selected, source: { kind: 'fixture', value: 'fixture', display_name: 'fixture', commit_sha: null }, created_at: now, model_override: null, analysis: { stage: 'done', snapshot_id: 'snapshot', languages: [], error: null }, study: { phase: 'orienting', current_step: 0, total_steps: 0, selected_value_point: null, mastered: [], misconceptions: [], open_questions: [], used_evidence: [] }, messages: selected === other ? [] : committed ? [user, assistant()] : runId ? [user] : [] } };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const url = `http://127.0.0.1:${address.port}`;
    try {
      await page.goto(url);
      await page.getByRole('button', { name: '打开项目 Recovery fixture', exact: true }).click();
      await page.getByPlaceholder('尽情提问').fill(user.content);
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect.poll(() => posts).toBe(1);
      await expect.poll(() => page.evaluate(() => localStorage.getItem('conversation-active-runs-v1'))).toContain('recovery-project');
      if (reload) {
        await page.reload();
        await expect.poll(() => gets).toBe(1);
      }
      await expect(page.getByRole('button', { name: '取消本轮回答', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '打开项目 Other fixture', exact: true }).click();
      await expect(page.getByPlaceholder('尽情提问')).toBeEnabled();
      const held = connections.at(-1)!;
      const switchedAt = Date.now();
      // Longer than the real ConversationRunHub's 30 second disconnect grace.
      await page.waitForTimeout(31_000);
      expect(Date.now() - switchedAt).toBeGreaterThan(30_000);
      expect(held.closed).toBeUndefined();
      expect(subscribers.size).toBe(1);
      expect(cancelled).toBe(false);
      expect(posts).toBe(1);
      expect(gets).toBe(reload ? 1 : 0);
      expect(new Set(connections.map(connection => connection.runId)).size).toBe(1);
      committed = true;
      for (const subscriber of subscribers) subscriber.end(`event: result\ndata: ${JSON.stringify(terminal())}\n\nevent: done\ndata: {}\n\n`);
      await expect.poll(() => page.evaluate(() => localStorage.getItem('conversation-active-runs-v1'))).toBe('[]');
      await expect(page.getByText(assistant().content, { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '打开项目 Recovery fixture', exact: true }).click();
      await expect(page.getByText(assistant().content, { exact: true })).toHaveCount(1);
      await expect(page.getByText(user.content, { exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: '取消本轮回答', exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.getByText(assistant().content, { exact: true })).toHaveCount(1);
      expect(posts).toBe(1);
      expect(gets).toBe(reload ? 1 : 0);
      const evidencePath = testInfo.outputPath('http-stream-lifecycle.json');
      await writeFile(evidencePath, JSON.stringify({ runId, posts, gets, cancelled, switchedAt, heldUntil: switchedAt + 31_000, connections, userMessages: 1, assistantMessages: 1 }, null, 2));
      await testInfo.attach('http-stream-lifecycle', { path: evidencePath, contentType: 'application/json' });
    } finally {
      if (disconnectTimer) clearTimeout(disconnectTimer);
      for (const subscriber of subscribers) subscriber.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
