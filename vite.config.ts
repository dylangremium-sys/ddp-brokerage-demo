import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // Stays 'node' for the whole suite. Rendering tests opt in per file with a
    // `// @vitest-environment jsdom` docblock, so adding them cannot slow down
    // or change the behaviour of the 2600+ existing node tests.
    environment: 'node',
    // src tests are TypeScript; the staging security *script* is ESM JS, so its
    // colocated regression test is .mjs and lives beside it. `.test.tsx` is for
    // tests that actually RENDER a component — until these existed, nothing in
    // this repo executed a single line of JSX, so a screen could break while the
    // suite stayed green.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs', 'api/**/*.test.ts'],
  },
})
