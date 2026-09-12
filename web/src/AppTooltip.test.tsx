import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTooltip } from './AppTooltip';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('shared tooltip layer', () => {
  it('ignores touch-induced focus but keeps keyboard explanations available', () => {
    render(<><button data-tooltip="收起项目栏">侧栏</button><AppTooltip /></>);
    const button = screen.getByRole('button');
    fireEvent.pointerDown(button, { pointerType: 'touch' });
    fireEvent.focusIn(button);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Tab' });
    fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('收起项目栏');
  });

  it('opens on hover and ignores unrelated pointer exits after keyboard focus moves', () => {
    vi.useFakeTimers();
    render(<><button data-tooltip="鼠标提示">第一项</button><button data-tooltip="键盘提示">第二项</button><AppTooltip /></>);
    const first = screen.getByRole('button', { name: '第一项' });
    const second = screen.getByRole('button', { name: '第二项' });
    fireEvent.pointerOver(first, { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(180));
    expect(screen.getByRole('tooltip')).toHaveTextContent('鼠标提示');
    fireEvent.focusIn(second);
    fireEvent.pointerOut(first);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('tooltip')).toHaveTextContent('键盘提示');
  });

  it('puts focused hints outside clipped panels and restores existing descriptions', () => {
    render(<><div style={{ overflow: 'hidden', height: 20 }}>
      <button data-tooltip="说明内容" aria-describedby="existing">设置</button>
    </div><AppTooltip /></>);
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);
    const hint = screen.getByRole('tooltip');
    expect(hint.parentElement).toBe(document.body);
    expect(hint).toHaveAttribute('popover', 'manual');
    expect(hint).toHaveTextContent('说明内容');
    expect(button.getAttribute('aria-describedby')).toBe(`existing ${hint.id}`);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-describedby', 'existing');
  });

  it('keeps modal hints inside their dialog and dismisses on click', () => {
    render(<><dialog open><button data-tooltip="界面语言">语言</button></dialog><AppTooltip /></>);
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip').parentElement?.tagName).toBe('DIALOG');
    fireEvent.click(button);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('replaces native title hints without leaving duplicate browser bubbles', () => {
    render(<><button title="放大">+</button><AppTooltip /></>);
    const button = screen.getByRole('button');
    fireEvent.focusIn(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('放大');
    expect(button).not.toHaveAttribute('title');
    fireEvent.scroll(document);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('title', '放大');
  });
});
