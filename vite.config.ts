import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // src tests are TypeScript; the staging security *script* is ESM JS, so its
    // colocated regression test is .mjs and lives beside it.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
})
