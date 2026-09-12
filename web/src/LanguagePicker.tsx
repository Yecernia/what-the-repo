import Languages from '@sketchyicons/react/icons/languages';
import Check from '@sketchyicons/react/icons/check';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UiLanguage } from './ui-language';

const languages = [{ value: 'zh-CN', label: '简体中文' }, { value: 'en', label: 'English' }] as const;

export function LanguagePicker({ value, onChange, label }: {
  value: UiLanguage;
  onChange: (language: UiLanguage) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  useLayoutEffect(() => {
    const el = menu.current, anchor = trigger.current;
    if (!open || !el || !anchor) return;
    el.showPopover?.();
    const place = () => {
      const rect = anchor.getBoundingClientRect(), box = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 10, top = (viewport?.offsetTop ?? 0) + 10;
      const right = left + (viewport?.width ?? window.innerWidth) - 20;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 20;
      el.style.left = `${Math.max(left, Math.min(rect.left, right - box.width))}px`;
      el.style.top = `${Math.max(top, Math.min(bottom - box.height, rect.bottom + box.height + 7 <= bottom ? rect.bottom + 7 : rect.top - box.height - 7))}px`;
    };
    place();
    el.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(el); observer.observe(anchor);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', outside, true);
    };
  }, [open]);

  return (
    <><button ref={trigger} type="button" role="combobox" className="language-picker btn btn-icon" data-tooltip={open ? undefined : label}
      aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} value={value}
      onClick={() => setOpen(current => !current)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
      }}>
      <Languages size={16} aria-hidden="true" />
      <span aria-hidden="true">{value === 'zh-CN' ? '中' : 'EN'}</span>
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" aria-label={label} popover="manual" className="language-menu"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === 'Tab') { close(true); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const options = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
        }
      }}>
      {languages.map(language => <button key={language.value} type="button" role="option" aria-selected={value === language.value}
        tabIndex={-1} onClick={() => { onChange(language.value); close(true); }}>
        <span>{language.label}</span>{value === language.value && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>, trigger.current?.closest('dialog[open]') ?? document.body)}
    </>
  );
}
