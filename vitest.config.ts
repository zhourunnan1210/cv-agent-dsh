import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 用 worker_threads 而非子进程：在受限文件策略下，Node 以管道 stdio 拉起子进程
    // 会被拒绝（spawn EPERM）。线程池不触发该限制。
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
  },
})
