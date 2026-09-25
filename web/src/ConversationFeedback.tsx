import { ActivityIcon } from './ActivityIcon';
import { t } from './ui-language';

/** Shared by the chat and visual review; App owns the actions. */
export function LastMessageActions({ onEdit, onResend }: { onEdit?: () => void; onResend?: () => void }) {
  return <div className="last-message-actions">
    {onEdit && <button type="button" className="message-action" onClick={onEdit} aria-label={t('编辑')} data-tooltip={t('编辑')}>
      <ActivityIcon name="revise" size={20} />
    </button>}
    {onResend && <button type="button" className="message-action" onClick={onResend} aria-label={t('重新发送')} data-tooltip={t('重新发送')}>
      <ActivityIcon name="resend" size={20} />
    </button>}
  </div>;
}

export function ConversationErrorNotice({ text }: { text: string }) {
  return <div className="conversation-error" role="alert">
    <ActivityIcon name="failure" size={23} /><span>{text}</span>
  </div>;
}
