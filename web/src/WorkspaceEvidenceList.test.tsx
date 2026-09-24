import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceEvidenceList } from './WorkspaceEvidenceList';
import type { GraphEvidence } from './types';
import { setUiLanguage } from './ui-language';
const rows = (count: number, prefix = 'core'): GraphEvidence[] => Array.from({ length: count }, (_, i) => ({
  stable_id: `${prefix}:${i}`, label: `file ${i}`, path: `${prefix}/file-${i}.ts`, start_line: i + 1,
  end_line: i + 1, kind: 'file',
}));

describe('bounded workspace evidence', () => {
  it.each([10_869, 6_537])('keeps %i items reachable without mounting them all', count => {
    const evidence = rows(count); const open = vi.fn();
    const { container } = render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={open} />);
    expect(container.querySelectorAll('button').length).toBeLessThan(25);
    const first = screen.getByRole('button', { name: /core\/file-0.ts:1$/ });
    act(() => first.focus()); fireEvent.keyDown(first, { key: 'End' });
    const last = screen.getByRole('button', { name: new RegExp(`core/file-${count - 1}.ts:${count}$`) });
    expect(last).toHaveFocus(); expect(last.closest('[role=listitem]')).toHaveAttribute('aria-posinset', String(count));
    fireEvent.click(last); expect(open).toHaveBeenLastCalledWith(evidence[count - 1]);
    fireEvent.keyDown(last, { key: 'Home' }); expect(first.isConnected).toBe(false);
    expect(screen.getByRole('button', { name: /core\/file-0.ts:1$/ })).toHaveFocus();
    expect(container.querySelectorAll('button').length).toBeLessThan(25);
  });
  it('scrolls in original order, retains focus and resets when details change', () => {
    const evidence = rows(10_869); const open = vi.fn();
    const { container, rerender } = render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={open} />);
    const first = screen.getByRole('button', { name: /core\/file-0.ts:1$/ });
    act(() => first.focus());
    const list = screen.getByRole('list'); fireEvent.scroll(list, { target: { scrollTop: 5400 } });
    expect(first).toHaveFocus(); expect(container.querySelectorAll('button').length).toBeLessThan(30);
    const item = screen.getByRole('button', { name: /core\/file-100.ts:101$/ });
    fireEvent.click(item); expect(open).toHaveBeenLastCalledWith(evidence[100]);
    rerender(<WorkspaceEvidenceList evidence={rows(6_537, 'extension')} onOpenEvidence={open} />);
    expect(list.scrollTop).toBe(0); expect(screen.queryByRole('button', { name: /core\// })).toBeNull();
    expect(screen.getByRole('button', { name: /extension\/file-0.ts:1$/ })).toBeInTheDocument();
  });
  it('keeps small lists and unavailable source items unchanged', () => {
    const evidence = rows(3); evidence[1]!.path = '';
    render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getAllByRole('button')[1]).toBeDisabled();
  });
});

it('virtual keyboard navigation skips unavailable endpoints without losing the tab entry', () => {
  const evidence = rows(100); evidence[0]!.path = ''; evidence[99]!.path = '';
  render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={vi.fn()} />);
  const entry = screen.getByRole('button', { name: /core\/file-1.ts:2$/ });
  expect(entry).toHaveAttribute('tabindex', '0');
  act(() => entry.focus()); fireEvent.keyDown(entry, { key: 'End' });
  const end = screen.getByRole('button', { name: /core\/file-98.ts:99$/ });
  expect(end).toHaveFocus(); fireEvent.keyDown(end, { key: 'Home' });
  expect(screen.getByRole('button', { name: /core\/file-1.ts:2$/ })).toHaveFocus();
});

it('updates accessible navigation help when the UI language changes', () => {
  const evidence = rows(100);
  render(<WorkspaceEvidenceList evidence={evidence} onOpenEvidence={vi.fn()} />);
  expect(screen.getByText(/共 100 项/)).toBeInTheDocument();
  act(() => setUiLanguage('en'));
  expect(screen.getByText(/100 items\. Navigate/)).toBeInTheDocument();
});
