import { Moon, Sun } from './HandIcons';
import type { AdminTheme } from './admin-theme';

export function AdminThemeToggle({ theme, toggle }: { theme: AdminTheme; toggle: () => void }) {
  const dark = theme === 'dark';
  return <button type="button" className="admin-theme-toggle" role="switch"
    aria-label="深色模式" aria-checked={dark} title={dark ? '切换为浅色模式' : '切换为深色模式'}
    onClick={toggle}>
    {dark ? <Moon size={17} /> : <Sun size={17} />}<span>{dark ? '深色' : '浅色'}</span>
  </button>;
}
