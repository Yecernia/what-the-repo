import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { LanguagePicker } from './LanguagePicker';

afterEach(cleanup);

it('selects by keyboard, escapes clipping and returns focus', async () => {
  const change = vi.fn();
  render(<div style={{ overflow: 'hidden' }}><LanguagePicker value="zh-CN" label="界面语言" onChange={change} /></div>);
  const trigger = screen.getByRole('combobox');
  await userEvent.click(trigger);
  expect(screen.getByRole('listbox').parentElement).toBe(document.body);
  expect(screen.getByRole('option', { name: '简体中文' })).toHaveFocus();
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(change).toHaveBeenCalledWith('en');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('keeps modal options interactive and hands focus back for Escape or native Tab navigation', async () => {
  const user = userEvent.setup();
  render(<dialog open><LanguagePicker value="en" label="项目语言" onChange={vi.fn()} /><button>下一项</button></dialog>);
  const trigger = screen.getByRole('combobox');
  await user.click(trigger);
  expect(screen.getByRole('listbox').parentElement?.tagName).toBe('DIALOG');
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.keyboard('{ArrowDown}');
  // Native Tab continues from this trigger in Edge; jsdom/user-event caches the old option before keydown.
  fireEvent.keyDown(screen.getByRole('option', { name: 'English' }), { key: 'Tab' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
