import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Native top-layer modality handles nested dialogs and makes the page inert. */
export function Modal({ children, onClose, className = 'settings-panel', label, labelledBy, returnFocus }: {
  children: ReactNode; onClose: () => void; className?: string; label?: string; labelledBy?: string;
  returnFocus?: () => HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      const target = trigger?.isConnected && trigger !== document.body ? trigger : returnFocusRef.current?.();
      target?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={ref} className={`modal-shell ${className}`} aria-modal="true" tabIndex={-1}
    aria-label={label} aria-labelledby={labelledBy}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab' || event.defaultPrevented
        || (event.target as Element).closest('dialog') !== event.currentTarget) return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],summary,[tabindex],[contenteditable="true"]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
          && !element.closest('[inert]') && element.getClientRects().length > 0
          && getComputedStyle(element).visibility !== 'hidden');
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); event.currentTarget.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
        event.preventDefault(); first.focus();
      }
    }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>, document.body);
}
