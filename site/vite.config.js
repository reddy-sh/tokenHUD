import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // The ranking lives in shared/ at the repo root so the cloud API and the
      // browser import the same file. That is one directory above this app, and
      // the dev server refuses to serve outside its root unless told.
      allow: ['..'],
    },
  },
})
