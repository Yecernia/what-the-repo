import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// Explicit opt-in configuration. The normal build never includes this dev link.
export default mergeConfig(base, defineConfig({
  server: { host: '127.0.0.1', port: 5391, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8391', changeOrigin: false } } },
  plugins: [{ name: 'admin-local-data-controls', apply: 'serve', transformIndexHtml: () => [
    { tag: 'a', attrs: { href: 'http://127.0.0.1:8491/', target: '_blank', rel: 'noopener',
      style: 'position:fixed;right:16px;bottom:16px;z-index:9999;background:#243d32;color:white;padding:10px 16px;border-radius:9px;font:14px system-ui;text-decoration:none;box-shadow:0 2px 10px #0002' },
      children: '本机开发 · 切换模拟数据', injectTo: 'body' },
  ] }],
}));
