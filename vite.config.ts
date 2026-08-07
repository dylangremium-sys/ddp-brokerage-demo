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
    // Vitest's default is 5s. That is ample for the node tests, which dominate,
    // but the `.test.tsx` files mount a real component tree in jsdom and the
    // security-migration guard reads the whole SQL corpus — those take seconds
    // each on an idle machine and blow 5s on a busy one.
    //
    // Measured during the W1 work: three consecutive full-suite runs failed with
    // 2, then 9, then 2 tests red, a DIFFERENT subset every time, and EVERY one
    // of them passed in isolation. Files hit included farmOnboardingValidation,
    // submitOutcomeTruthfulness, ErrorBoundary, BrowserOnlyProvenanceNotice,
    // AiDraftPanel, farmerRegisterLanguage and guardRedefinition — i.e. every
    // rendering test plus the corpus guard, which is the signature of a timeout
    // rather than a defect.
    //
    // Raised globally rather than per file, because per-file timeouts are
    // whack-a-mole: the next `.test.tsx` anyone writes starts flaky and the
    // author has no reason to suspect why. A gate test that fails
    // intermittently is worse than no test, because it teaches people to re-run
    // CI until it passes — and this suite gates a compliance system.
    //
    // This does NOT hide a slow test: a genuine hang still fails, just at 20s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
