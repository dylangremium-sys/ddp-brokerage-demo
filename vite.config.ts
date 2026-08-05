import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // SPA mode: Vite serves index.html for any path that has no matching file,
  // so deep links like /farmer work in the dev server without a proxy rule.
  appType: 'spa',
  plugins: [react()],
  server: {
    // Named hosts, NOT `true`. `allowedHosts: true` switches off Vite's Host
    // header check altogether — that check is what stops a hostile page from
    // DNS-rebinding a browser onto this dev server and reading source and env
    // off it. The suffix form below admits every *.replit.dev preview without
    // giving up the check. It is also not "dev only" as the patch notes claim:
    // from Vite 6 onward `preview.allowedHosts` falls back to this value, and
    // package.json has a `preview` script.
    // All three Replit host suffixes: webview previews are served from
    // *.replit.dev, published apps from *.replit.app, and legacy repls from
    // *.repl.co. If a preview ever 403s with "Blocked request", add that exact
    // host here — do NOT go back to `true`, which is the thing being fixed.
    allowedHosts: ['.replit.dev', '.replit.app', '.repl.co'],
  },
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
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
  },
})
