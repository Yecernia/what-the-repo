import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkspaceEvidenceList } from './WorkspaceEvidenceList';
import type { GraphEvidence } from './types';
import { setUiLanguage } from './ui-language';

const rows = (count: number, prefix = 'core'): GraphEvidence[] => Array.from({ length: count }, (_, i) => ({
  stable_id: `${prefix}:${i}`, label: `file ${i}`, path: `${prefix}/file-${i}.ts`, start_line: i + 1,
  end_line: i + 1, kind: 'file',
}));
const files = () => within(screen.getByRole('list')).getAllByRole('button').map(button => button.getAttribute('aria-label'));
const expand = () => fireEvent.click(screen.getByRole('button', { name: /展开全部/ }));

it('keeps small lists and unavailable source items unchanged', () => {
  const evidence = rows(3); evidence[1]!.path = '';
  render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={vi.fn()} />);
  expect(screen.getAllByRole('button')).toHaveLength(3);
  expect(screen.getAllByRole('button')[1]).toBeDisabled();
});

it('shows five references until the learner unfolds them, then folds them again', () => {
  render(<WorkspaceEvidenceList evidence={rows(12)} onOpenEvidence={vi.fn()} />);
  expect(files()).toHaveLength(5);
  expand();
  expect(files()).toHaveLength(10);
  fireEvent.click(screen.getByRole('button', { name: '收起' }));
  expect(files()).toHaveLength(5);
});

it('pages through thousands of references without mounting them all', () => {
  const evidence = rows(10_869); const open = vi.fn();
  render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={open} />);
  expand();
  expect(files()).toHaveLength(10);
  expect(screen.getByRole('button', { name: '首页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(files()[0]).toMatch(/core\/file-10.ts:11$/);
  fireEvent.click(screen.getByRole('button', { name: '末页' }));
  expect(screen.getByRole('textbox', { name: '页码' })).toHaveValue('1087');
  expect(files()).toEqual(['file 10860 core/file-10860.ts:10861', ...Array.from({ length: 8 }, (_, i) =>
    `file ${10_861 + i} core/file-${10_861 + i}.ts:${10_862 + i}`)]);
  fireEvent.click(screen.getByRole('button', { name: /core\/file-10868.ts:10869$/ }));
  expect(open).toHaveBeenLastCalledWith(evidence[10_868]);
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('jumps to a typed page and keeps the number in range', () => {
  render(<WorkspaceEvidenceList evidence={rows(95)} onOpenEvidence={vi.fn()} />);
  expand();
  const page = screen.getByRole('textbox', { name: '页码' });
  fireEvent.change(page, { target: { value: '4' } });
  fireEvent.keyDown(page, { key: 'Enter' });
  expect(files()[0]).toMatch(/core\/file-30.ts:31$/);
  fireEvent.change(page, { target: { value: '99' } });
  fireEvent.blur(page);
  expect(page).toHaveValue('10');
  expect(files()).toHaveLength(5);
});

it('searches file paths and starts the results from the first page', () => {
  const evidence = [...rows(30), ...rows(12, 'extension')];
  render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={vi.fn()} />);
  expand();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索文件名' }), { target: { value: 'EXTENSION/' } });
  expect(files()[0]).toMatch(/extension\/file-0.ts:1$/);
  expect(screen.getByText('12 / 42 个')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: '页码' })).toHaveValue('1');
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索文件名' }), { target: { value: 'missing' } });
  expect(screen.getByText('没有匹配的文件')).toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: '翻页' })).toBeNull();
});

it('translates the pager with the UI language', () => {
  render(<WorkspaceEvidenceList evidence={rows(40)} onOpenEvidence={vi.fn()} />);
  expand();
  expect(screen.getByText('共 40 个')).toBeInTheDocument();
  act(() => setUiLanguage('en'));
  expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
  expect(screen.getByText('40 files')).toBeInTheDocument();
  act(() => setUiLanguage('zh-CN'));
});
