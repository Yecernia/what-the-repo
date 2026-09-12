import { ActivityIcon } from './ActivityIcon';
import { X } from './HandIcons';
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

export function MessageEditNotice({ onCancel }: { onCancel: () => void }) {
  return <div className="message-edit-notice">
    <span><ActivityIcon name="revise" size={22} />{t('编辑最后一条消息')}</span>
    <button type="button" className="message-action cancel-edit" onClick={onCancel}>
      <X size={17} aria-hidden="true" /><span>{t('取消编辑')}</span>
    </button>
  </div>;
}
