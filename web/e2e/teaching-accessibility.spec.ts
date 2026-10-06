import { expect, test, type Page } from '@playwright/test';

// UI regressions use deterministic HTTP fixtures; no model or repository request is made.
async function workspace(page: Page) {
  const now = '2026-10-03T00:00:00Z';
  let owner = 'guest:keyboard';
  let sourceFails = false;
  let created = 0;
  const summaries = ['Alpha', 'Beta'].map((title, i) => ({ project_id: `project-${i}`, title,
    source_kind: 'fixture', source_value: title, analysis_stage: 'done', teaching_phase: 'orienting',
    message_count: 1, updated_at: now }));
  const settings = { base_url: '', model: 'test', thinking_level: 'medium', available_models: ['test'], model_options: [],
    providers: [], provider_presets: [{ id: 'custom', label: 'Custom', base_url: '', custom_base_url: true }],
    can_manage_api_key: true, api_key_management: 'interactive', free_experience_configured: true };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = {};
    let status = 200;
    if (path === '/api/auth/config') body = { auth_mode: 'github', github_enabled: true, guest_enabled: true };
    else if (path === '/api/auth/me') body = { owner_id: owner, login: 'keyboard', display_name: 'Keyboard', kind: 'github', auth_mode: 'github' };
    else if (path === '/api/settings') body = settings;
    else if (path === '/api/profile') body = { profile: { enabled: true, languages: [], goals: [], inferred: [],
      explanation_preference: '', experience_level: '', memory_summary: 'A saved memory.', memory_summary_mode: 'manual' } };
    else if (path === '/api/projects') {
      if (route.request().method() === 'POST') created++;
      body = summaries;
    } else if (path.endsWith('/snapshot')) body = { snapshot_id: 'snapshot',
      summary: { file_count: 1, symbol_count: 1, call_count: 0, component_count: 0 },
      graph: { semantic_mode: 'empty', nodes: [], edges: [], layers: [], unassigned_component_ids: [] },
      value_points: [], languages: [], learning_plan: { snapshot_id: 'snapshot', selected_value_point: null, steps: [] } };
    else if (path.endsWith('/source')) {
      status = sourceFails ? 503 : 200;
      body = sourceFails ? { error: { code: 'source_unavailable', message: 'Source unavailable' } }
        : { snapshot_id: 'snapshot', path: 'src/entry.ts', start_line: 1, end_line: 3,
          lines: ['export function entry(input) {', '  return input;', '}'], truncated: false };
    } else if (/\/api\/projects\/project-\d$/.test(path)) {
      const summary = summaries.find(project => path.endsWith(project.project_id))!;
      body = { snapshot_available: true, analysis_job: null, project: { ...summary,
        source: { kind: 'fixture', value: summary.title, display_name: summary.title, commit_sha: null },
        created_at: now, model_override: null,
        analysis: { stage: 'done', snapshot_id: 'snapshot', languages: [], error: null, canonical_snapshot_key: null },
        study: { phase: 'orienting', current_step: 0, total_steps: 0, selected_value_point: null,
          mastered: [], misconceptions: [], open_questions: [], used_evidence: [] },
        messages: [{ message_id: 'answer', role: 'assistant', content: '读取 `src/entry.ts:2`。', created_at: now,
          evidence: [{ stable_id: 'entry', label: 'entry', path: 'src/entry.ts', start_line: 1, end_line: 3, snapshot_id: 'snapshot', kind: 'file' }],
          model: 'test', usage: null, latency_ms: 1, error: null, placeholder: false, context_eligible: true,
          analysis_snapshot_id: 'snapshot' }],
      } };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/');
  return { changeOwner: () => { owner = 'guest:other'; }, failSource: () => { sourceFails = true; }, creations: () => created };
}

async function staysInDialog(page: Page, name: string | RegExp) {
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  for (const key of ['Tab', 'Shift+Tab', ...Array(18).fill('Tab'), ...Array(18).fill('Shift+Tab')]) {
    await page.keyboard.press(key);
    await expect.poll(() => dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
  }
}

test('native dialogs trap focus, close the topmost dialog with Escape and restore their trigger', async ({ page }) => {
  await workspace(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await staysInDialog(page, '设置');
  await page.getByRole('button', { name: '记忆摘要', exact: true }).click();
  await staysInDialog(page, '记忆摘要');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '记忆摘要' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '记忆摘要', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '添加 API 配置', exact: true }).click();
  await staysInDialog(page, '添加 API 配置');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '添加 API 配置', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
});

test('projects open with Enter/Space; source success and failure preserve focus; reload restores only this owner', async ({ page }) => {
  const fixture = await workspace(page);
  const alpha = page.getByRole('button', { name: '打开项目 Alpha', exact: true });
  await alpha.focus(); await page.keyboard.press('Enter');
  await expect(alpha).toHaveAttribute('aria-current', 'page');
  const beta = page.getByRole('button', { name: '打开项目 Beta', exact: true });
  await beta.focus(); await page.keyboard.press('Space');
  await expect(beta).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: '打开 Alpha 项目菜单' }).click();
  await page.getByRole('menuitem', { name: /重命名/ }).click();
  await expect(page.getByRole('textbox', { name: '项目标题' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(alpha).toBeFocused();
  await expect(beta).toHaveAttribute('aria-current', 'page');
  const source = page.locator('.markdown-file-reference').first();
  await source.click();
  await staysInDialog(page, /源码 src\/entry.ts:2/);
  await page.keyboard.press('Escape'); await expect(source).toBeFocused();
  fixture.failSource(); await source.click();
  await staysInDialog(page, /源码 src\/entry.ts:2/);
  await page.keyboard.press('Escape'); await expect(source).toBeFocused();
  await page.reload(); await expect(beta).toHaveAttribute('aria-current', 'page');
  fixture.changeOwner(); await page.reload();
  await expect(page.getByRole('button', { name: '打开项目 Alpha' })).toBeVisible();
  await expect(page.locator('.project-open-button[aria-current="page"]')).toHaveCount(0);
});

test('pane separator supports keys and drag with accurate values, and malformed URLs stay local', async ({ page }) => {
  const fixture = await workspace(page);
  await page.getByRole('button', { name: '打开项目 Alpha' }).click();
  await page.getByRole('button', { name: '展开项目视图' }).click();
  const separator = page.getByRole('separator', { name: '调整对话与项目视图宽度' });
  await separator.focus();
  for (const key of ['Home', 'ArrowLeft', 'End', 'ArrowRight', 'Enter']) {
    await page.keyboard.press(key);
    await expect.poll(async () => Math.abs(Number(await separator.getAttribute('aria-valuenow'))
      - await page.locator('.repository-pane').evaluate(element => element.getBoundingClientRect().width))).toBeLessThan(2);
  }
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 60);
  await page.mouse.down(); await page.mouse.move(bounds.x + 60, bounds.y + 60); await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await separator.getAttribute('aria-valuenow'))
    - await page.locator('.repository-pane').evaluate(element => element.getBoundingClientRect().width))).toBeLessThan(2);
  await page.getByRole('button', { name: '收起项目视图' }).click();
  await expect(page.locator('.repository-resizer')).toHaveAttribute('tabindex', '-1');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByPlaceholder('https://github.com/owner/repo').fill('not a repository');
  await page.getByRole('button', { name: '开始分析' }).click();
  await expect(page.getByRole('alert')).toContainText('完整的公开 GitHub');
  expect(fixture.creations()).toBe(0);
});
