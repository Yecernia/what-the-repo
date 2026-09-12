import { expect, test } from '@playwright/test';

const repositoryUrl = process.env.WHAT_THE_REPO_E2E_REPOSITORY_URL
  ?? 'https://github.com/pallets/itsdangerous';
const repositoryTitle = new URL(repositoryUrl).pathname
  .replace(/^\/+|\/+$/g, '')
  .replace(/\.git$/, '');

test('guest analyzes a real public GitHub repository in the hosted product flow', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  await page.goto('/');

  await expect(page.getByText(/访客记录由此浏览器的签名 Cookie 关联/)).toBeVisible();
  await page.getByRole('button', { name: '以访客身份体验' }).click();
  await page.getByRole('button', { name: '新建项目' }).click();

  await expect(page.getByText('公开 GitHub 仓库地址')).toBeVisible();
  await expect(page.getByText('本地来源')).toHaveCount(0);
  await expect(page.getByLabel('选择样本')).toHaveCount(0);
  await page.getByPlaceholder('https://github.com/owner/repo').fill(repositoryUrl);
  await page.getByRole('button', { name: '开始分析' }).click();

  await expect(page.getByTestId('analysis-activity')).toBeVisible({ timeout: 15_000 });
  const projectView = page.getByRole('button', { name: '展开项目视图' });
  const analysisError = page.locator('.chat-analysis-error');
  await expect(projectView.or(analysisError)).toBeVisible({ timeout: 240_000 });
  if (await analysisError.isVisible()) {
    throw new Error(`Real GitHub analysis failed: ${await analysisError.innerText()}`);
  }
  await expect(page.locator('.project-item.active')).toContainText(repositoryTitle);

  await projectView.click();
  await expect(page.getByTestId('component-flow')).toBeVisible();
  expect(await page.locator('.react-flow__node').count()).toBeGreaterThan(0);

  if (process.env.WHAT_THE_REPO_E2E_PROVIDER_CONFIGURED === '1') {
    const composer = page.getByPlaceholder('尽情提问');
    await composer.fill('这个仓库最值得先了解的是什么？');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.msg.user').last()).toContainText(
      '这个仓库最值得先了解的是什么？',
      { timeout: 1_000 },
    );
    await expect(page.locator('.msg.assistant').last()).toBeVisible({ timeout: 180_000 });
  }

  await page.screenshot({
    path: testInfo.outputPath('hosted-github-workspace.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
