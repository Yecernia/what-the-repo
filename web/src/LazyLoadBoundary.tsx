import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from './ui-language';

interface Props {
  children: ReactNode;
  beforeReload?: () => boolean;
}

/** A failed feature import must not unmount its sibling chat or silently reload drafts. */
export class LazyLoadBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not copy module URLs or arbitrary error text into the user-facing message.
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="workspace-error" role="alert">
      <strong>{t('界面加载失败')}</strong>
      <span>{t('请检查网络连接后重新加载页面。')}</span>
      <button type="button" className="btn" onClick={() => {
        // Browsers can cache a rejected ES module. Recreating React.lazy is not a reliable retry.
        if (this.props.beforeReload?.() === false) return;
        window.location.reload();
      }}>{t('重新加载页面')}</button>
    </div>;
  }
}
