import { useLayoutEffect, useRef, useState } from 'react';
import { t } from './ui-language';
import { InkOutline } from './InkOutline';
import { useTextareaAutosize } from './useTextareaAutosize';

export function InlineMessageEditor({ content, onCancel, onSubmit }: {
  content: string; onCancel: () => void; onSubmit: (content: string) => void;
}) {
  const [draft, setDraft] = useState(content);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useTextareaAutosize(input, draft, 40, .42);
  return <div className="inline-message-editor"><InkOutline paper aged />
    <textarea ref={input} rows={1} enterKeyHint="enter" aria-label={t('编辑最后一条消息')} value={draft} onChange={event => setDraft(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && draft.trim()) { event.preventDefault(); onSubmit(draft); }
      }} />
    <div className="inline-message-editor-actions">
      <button type="button" className="btn" onClick={onCancel}>{t('取消')}</button>
      <button type="button" className="btn btn-primary" aria-label={t('发送编辑后的消息')} disabled={!draft.trim()} onClick={() => onSubmit(draft)}>{t('发送')}</button>
    </div>
  </div>;
}
