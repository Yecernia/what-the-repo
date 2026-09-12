import { useState } from 'react';
import { Plus } from './HandIcons';
import RefreshCw from '@sketchyicons/react/icons/refresh-cw';
import Trash2 from '@sketchyicons/react/icons/trash-2';
import { t } from './ui-language';

export function ProviderModelList({ models, busy, canVerify, onFetch, onVerify, onRemove }: {
  models: string[];
  busy: boolean;
  canVerify: boolean;
  onFetch: () => Promise<void>;
  onVerify: (model: string) => Promise<boolean>;
  onRemove: (model: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const duplicate = models.includes(name.trim());
  async function verify() {
    if (!name.trim() || duplicate || busy || !canVerify) return;
    if (await onVerify(name.trim())) { setName(''); setAdding(false); }
  }
  return <section className="provider-models" aria-label={t('模型列表')}>
    <div className="provider-models-heading">
      <strong>{t('模型列表')} <span>{models.length}</span></strong>
      <div className="provider-models-actions">
        <button className="btn" type="button" disabled={busy || models.length >= 100} onClick={() => setAdding(value => !value)}><Plus size={14} /> {t('添加模型')}</button>
        <button className="btn" type="button" disabled={busy || !canVerify} onClick={() => void onFetch()}><RefreshCw size={14} /> {t('从上游获取')}</button>
      </div>
    </div>
    {adding && <div className="provider-model-add">
      <label className="form-label" htmlFor="manual-provider-model">{t('模型名称')}</label>
      <div className="provider-model-add-controls">
        <input id="manual-provider-model" className="form-input" autoFocus maxLength={500} value={name} disabled={busy}
          placeholder={t('输入厂商提供的完整模型名称')}
          onChange={event => setName(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void verify(); } }} />
        <button className="btn" type="button" disabled={busy || !canVerify || !name.trim() || duplicate} onClick={() => void verify()}>{t('验证并添加')}</button>
      </div>
      <p className="settings-status-note">{duplicate ? t('这个模型已在列表中') : t('将发送一次简短对话进行验证，可能产生少量费用。')}</p>
    </div>}
    {models.length ? <ul className="provider-model-rows">
      {models.map(model => <li key={model}>
        <span>{model}</span>
        <button className="model-remove-button" type="button" disabled={busy} aria-label={t('删除模型 {0}', model)} onClick={() => onRemove(model)}><Trash2 size={18} /></button>
      </li>)}
    </ul> : <p className="provider-models-empty">{t('从上游获取模型，或手动添加并验证。至少保留一个模型才能保存。')}</p>}
  </section>;
}
