import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const brandingIconPath = fileURLToPath(new URL('./public/what-the-repo-icon.png', import.meta.url))

// Set only by the opt-in Windows LAN launcher. No application/production auth changes.
const lanOrigin = process.env.WTR_DEV_LAN_ORIGIN?.trim()
const lanNavigation: Plugin = {
  name: 'local-lan-navigation',
  apply: 'serve',
  configureServer(server) {
    if (!lanOrigin) return
    const canonicalHost = new URL(lanOrigin).host
    server.middlewares.use((request, response, next) => {
      const path = request.url ?? '/'
      const navigation = request.headers.accept?.includes('text/html')
        || path === '/' || path.split('?')[0] === '/api/auth/github/start'
      if (!navigation || !['GET', 'HEAD'].includes(request.method ?? '')
        || request.headers.host === canonicalHost) return next()
      // A fixed configured origin, never a return URL from the request. Do not cache mode switches.
      response.writeHead(302, { Location: lanOrigin + (path.startsWith('/') ? path : '/'), 'Cache-Control': 'no-store' })
      response.end()
    })
  },
}

export default defineConfig({
  plugins: [react(), lanNavigation],
  server: {
    host: lanOrigin ? '0.0.0.0' : '127.0.0.1',
    port: 5307,
    strictPort: true,
    // Windows can report EBUSY while an image in public/ is being replaced
    // by the browser or an editor. Polling keeps Vite alive and the ignored
    // branding asset never needs hot reload.
    watch: {
      usePolling: true,
      interval: 250,
      ignored: [brandingIconPath],
    },
    proxy: {
      '/api': {
        target: process.env.WHAT_THE_REPO_BACKEND_URL ?? 'http://127.0.0.1:8307',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5308,
    strictPort: true,
  },
})
