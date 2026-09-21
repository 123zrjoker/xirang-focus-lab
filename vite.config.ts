import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    watch: {
      ignored: [
        '**/release/**',
        '**/release-candidate/**',
        '**/desktop-runtime/**',
        '**/.model-cache/**',
        '**/artifacts/**',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '**/release-candidate/**',
      '**/desktop-runtime/**',
      '**/backups/**',
    ],
  },
})
