import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 用 worker_threads 而非子进程：在受限文件策略下，Node 以管道 stdio 拉起子进程
    // 会被拒绝（spawn EPERM）。线程池不触发该限制。
    pool: 'threads',
    include: ['tests/**/*.test.ts'],
    // 尚无测试的包（如 mcp-server 占位阶段）不应让整个 workspace 的
    // `pnpm test` 以非零退出——那会把「还没写测试」伪装成「测试失败」。
    passWithNoTests: true,
  },
})
