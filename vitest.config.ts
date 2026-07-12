import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

const alias = {
  '@': path.resolve(__dirname, './src'),
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    globals: true,
    projects: [
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./tests/setup.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          globals: true,
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/integration/setup.ts'],
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'corpus',
          globals: true,
          include: ['tests/corpus/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
