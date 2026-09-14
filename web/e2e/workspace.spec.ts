import { expect, test } from '@playwright/test';

interface ProjectResponse {
  project: {
    project_id: string;
    source: { commit_sha: string | null };
    analysis: {
      stage: string;
      error: string | null;
      progress_events?: Array<{ kind: string; status: string }>;
    };
  };
  snapshot_available: boolean;
}

const repositoryUrl = process.env.WHAT_THE_REPO_E2E_REPOSITORY_URL
  ?? 'https://github.com/pallets/itsdangerous';
const repositoryTitle = new URL(repositoryUrl).pathname
  .replace(/^\/+|\/+$/g, '')
  .replace(/\.git$/, '');

test('guest repository flow enforces the configured analysis provider boundary', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.goto('/');

  await expect(page.getByText(/访客记录仅在当前浏览器可用/)).toBeVisible();
  await page.getByRole('button', { name: '以访客身份体验' }).click();
  await page.locator('.sidebar-new-project').click();

  await expect(page.getByText('公开 GitHub 仓库地址')).toBeVisible();
  await expect(page.getByText('本地来源')).toHaveCount(0);
  await expect(page.getByLabel('选择样本')).toHaveCount(0);
  await page.getByPlaceholder('https://github.com/owner/repo').fill(repositoryUrl);
  const createdResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/projects' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始分析' }).click();
  const created = await createdResponse;
  expect(created.ok()).toBe(true);
  const { project } = await created.json() as ProjectResponse;

  await expect(page.getByTestId('analysis-activity')).toBeVisible({ timeout: 15_000 });
  const projectView = page.getByRole('button', { name: '展开项目视图' });
  const analysisError = page.locator('.chat-analysis-error');
  await expect(projectView.or(analysisError)).toBeVisible({ timeout: 240_000 });
  await expect(page.locator('.project-item.active')).toContainText(repositoryTitle);

  if (process.env.WHAT_THE_REPO_E2E_PROVIDER_CONFIGURED === '1') {
    if (await analysisError.isVisible()) {
      throw new Error(`Real GitHub analysis failed: ${await analysisError.innerText()}`);
    }
    await projectView.click();
    await expect(page.getByTestId('component-flow')).toBeVisible();
    expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(0);
    const composer = page.getByPlaceholder('尽情提问');
    await composer.fill('这个仓库最值得先了解的是什么？');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.msg.user').last()).toContainText(
      '这个仓库最值得先了解的是什么？',
      { timeout: 1_000 },
    );
    await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 180_000 });
  } else {
    // Missing credentials must produce this specific failure, not a fake graph.
    const response = await page.request.get(`/api/projects/${project.project_id}`);
    expect(response.ok()).toBe(true);
    const detail = await response.json() as ProjectResponse;
    expect(detail.project.analysis.stage).toBe('failed');
    expect(detail.project.analysis.error).toBe('上游暂不可用，请稍后重试。');
    expect(detail.project.source.commit_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(detail.project.analysis.progress_events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'fetching_source', status: 'completed' }),
      expect.objectContaining({ kind: 'building_fact_graph', status: 'completed' }),
    ]));
    expect(detail.snapshot_available).toBe(false);
    await expect(analysisError).toContainText('上游暂不可用');
    await expect(analysisError.getByRole('button', { name: '重新分析' })).toBeVisible();
    await expect(projectView).toHaveCount(0);
    await page.reload();
    await page.locator('.project-item').filter({ hasText: repositoryTitle }).click();
    await expect(page.locator('.project-item.active')).toContainText(repositoryTitle);
    await expect(analysisError).toContainText('上游暂不可用');
    await expect(projectView).toHaveCount(0);
  }

  await page.screenshot({
    path: testInfo.outputPath('hosted-github-workspace.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
