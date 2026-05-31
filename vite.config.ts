import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Read version from pyproject.toml at build time
const pyprojectContent = readFileSync(resolve(__dirname, '../finamt/pyproject.toml'), 'utf-8')
const versionMatch = pyprojectContent.match(/^version\s*=\s*"(.+)"/m)
const packageVersion = versionMatch ? versionMatch[1] : 'unknown'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), ],
  build: {
    outDir: "../finamt/src/finamt/ui/static",
    emptyOutDir: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageVersion),
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/tax": "http://127.0.0.1:8000",
      "/taxpayer": "http://127.0.0.1:8000",
      "/receipts": "http://127.0.0.1:8000",
      "/settings": "http://127.0.0.1:8000",
    },
  },
})
