import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split heavy third-party dependencies out of the main entry chunk so
        // no single chunk exceeds the 500 kB warning threshold. Grouping only —
        // this changes how modules are packaged into output files, never the
        // module code, env handling, or any security boundary.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // React core + react-dom (+ jsx runtime) grouped on their own; all
          // other third-party libraries land in a single `vendor` chunk.
          if (id.includes('/react-dom/') || id.includes('/react/')) return 'vendor-react'
          return 'vendor'
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
