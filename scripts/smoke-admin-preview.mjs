import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(),
  fixture = resolve(process.argv[2] ?? '');
assert.ok(
  fixture.startsWith(join(root, '.local', 'admin-preview-')),
  'Only an isolated fixture directory is allowed',
);
const require = createRequire(join(root, 'web/package.json'));
const { chromium } = require('@playwright/test');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const out = join(fixture, 'screenshots');
await mkdir(out, { recursive: true });
try {
  await page.goto('http://127.0.0.1:5390/admin');
  await page
    .getByRole('link', { name: '使用 GitHub 登录', exact: true })
    .click();
  await page
    .getByLabel('初始化凭据')
    .fill(
      JSON.parse(
        await readFile(join(fixture, 'preview-credentials.json'), 'utf8'),
      ).bootstrap,
    );
  const enrollment = page.waitForResponse((r) =>
    r.url().endsWith('/api/admin/auth/enroll'),
  );
  await page.getByRole('button', { name: '开始绑定', exact: true }).click();
  const { seed } = await (await enrollment).json();
  await writeFile(
    join(fixture, 'test-totp-seed.json'),
    JSON.stringify({ seed }),
    { mode: 0o600 },
  );
  // The seed belongs solely to the locally generated, isolated test administrator.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0,
    value = 0;
  const bytes = [];
  for (const c of seed) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(),
    offset = hash.at(-1) & 15;
  const code = ((hash.readUInt32BE(offset) & 0x7fffffff) % 1e6)
    .toString()
    .padStart(6, '0');
  await page.getByLabel('新验证器的 6 位验证码').fill(code);
  await page.getByRole('button', { name: '确认绑定并登录' }).click();
  await page.getByRole('button', { name: '我已安全保存' }).click();
  await context.storageState({ path: join(fixture, 'browser-state.json') });
  await page.getByRole('heading', { name: '总览', exact: true }).waitFor();
  await page.screenshot({
    path: join(out, 'desktop-overview.png'),
    fullPage: true,
  });
  const visited = [];
  for (const name of [
    '任务与用户',
    'Agent 与厂商',
    '预算',
    '反馈与自进化',
    '存储管理',
    '操作记录',
  ]) {
    await page
      .getByRole('navigation', { name: '管理台导航' })
      .getByRole('button', { name: new RegExp(name) })
      .click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await page
      .getByText('正在读取…', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('alert').count(), 0, name);
    visited.push(name);
  }
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /预算/ })
    .click();
  await page.getByLabel('平台每日免费聊天限制').selectOption('unlimited');
  await page.getByRole('button', { name: '保存预算', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '操作已完成' }).waitFor();
  await page.screenshot({
    path: join(out, 'desktop-budgets.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['总览', 'Agent 与厂商', '预算', '存储管理']) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: new RegExp(name) })
      .click();
    await page
      .getByText('正在读取…', { exact: true })
      .waitFor({ state: 'hidden' });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      name + ' overflows viewport',
    );
    await page.getByText('what-the-repo · 管理接口逐项授权 · 金额为程序用量记录',{exact:true}).scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>window.scrollY>0),'Mobile page must scroll to its footer');
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({
      path: join(
        out,
        'mobile-' +
          {
            总览: 'overview',
            'Agent 与厂商': 'config',
            预算: 'budgets',
            存储管理: 'storage',
          }[name] +
          '.png',
      ),
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  await context.storageState({ path: join(fixture, 'browser-state.json') });
  await writeFile(
    join(fixture, 'browser-evidence.json'),
    JSON.stringify(
      {
        visited,
        desktop: [1440, 1050],
        mobile: [390, 844],
        errors,
        passed: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'Preview acceptance passed: GitHub challenge + real TOTP enrollment, seven pages, budget save without another OTP, desktop and mobile.',
  );
} finally {
  await browser.close();
}
