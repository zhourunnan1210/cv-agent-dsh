import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 同上：避开受限策略下的子进程 spawn 限制。
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
  },
})
