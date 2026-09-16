import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const product = read('./index.css');
const theme = read('./admin-theme.css');
const admin = read('./admin.css');
function variables(css: string, selector: string) {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing palette: ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2]]));
}
const equivalents: Record<string, string> = {
  paper: 'chat-bg', ink: 'fg', line: 'border', accent: 'accent', surface: 'panel', input: 'input-bg',
  sidebar: 'sidebar-material', hover: 'control-hover', active: 'accent-soft', 'active-ink': 'accent-dim',
  primary: 'primary', 'primary-ink': 'primary-fg', 'primary-hover': 'primary-hover', muted: 'fg-muted',
  link: 'accent', focus: 'accent-ring', 'subtle-line': 'border', 'empty-surface': 'control-bg',
  'chart-guest': 'warn', 'success-dot': 'ok', 'success-ring': 'ok-soft', danger: 'err',
  'danger-line': 'err', 'danger-surface': 'err-soft', 'warning-dot': 'warn', 'warning-ring': 'warn-soft',
  'warning-surface': 'warn-soft', 'warning-ink': 'warn', 'warning-line': 'warn',
  'notice-surface': 'ok-soft', 'notice-ink': 'ok', 'notice-line': 'ok',
  'code-surface': 'code-bg', 'code-ink': 'fg', 'code-muted': 'fg-tertiary',
  'diff-add': 'ok-soft', 'diff-remove': 'err-soft', 'diff-hunk': 'selection-blue-soft',
  'code-header': 'toolbar-material', backdrop: 'scrim',
};
for (const token of ['comment', 'keyword', 'string', 'number', 'title', 'built-in', 'meta']) {
  equivalents['code-' + token] = 'syntax-' + token;
}

for (const mode of ['light', 'dark'] as const) {
  it(`${mode} admin colors match the product without depending on its selected theme`, () => {
    const source = variables(product, mode === 'light' ? ':root {' : ':root[data-theme="dark"]');
    const target = variables(theme, mode === 'light' ? ":root, :root[data-admin-theme='light']" : ":root[data-admin-theme='dark']");
    for (const [name, counterpart] of Object.entries(equivalents)) {
      expect(target.get('--admin-' + name), name).toBe(source.get('--' + counterpart));
      expect(target.get('--admin-' + name), name).toBeDefined();
    }
    for (const match of (theme + admin).matchAll(/var\((--admin-[\w-]+)/g)) {
      expect(target.has(match[1]), `Undefined ${mode} color: ${match[1]}`).toBe(true);
    }
    expect(target.get('--admin-color-scheme')).toBe(mode);
  });
}
it('maps every source-code syntax group to the same admin color role', () => {
  const sourceRules = product.split('\n').filter(line => line.startsWith('.source-code .hljs-'));
  expect(sourceRules).toHaveLength(8);
  for (const rule of sourceRules) {
    expect(admin).toContain(rule.replaceAll('.source-code', '.admin-code')
      .replaceAll('var(--syntax-', 'var(--admin-code-').replaceAll('var(--fg)', 'var(--admin-code-ink)'));
  }
});
it('retains native scrollbar rules and distinguishes additions from deletions', () => {
  expect(admin).toContain('scrollbar-width: auto !important;');
  expect(admin).toContain('scrollbar-color: auto !important;');
  expect(admin).toContain('.admin-diff-added { background: var(--admin-diff-add,');
  expect(admin).toContain('.admin-diff-removed { background: var(--admin-diff-remove,');
});
