/**
 * 预设组合的静态预检（挂载事故的防回归，2026-09-17）。
 *
 * ## 为什么这条测试必须存在
 *
 * 事故经过：合并两个 isolate group 时漏给 `ideaScore` 服务行补 isolate 键。
 * dsh 的 `mountPreset` 会因此抛错——
 *
 *     row(s) published process-global service(s) [ideaScore]; a preset service
 *     must sit behind an `isolate` realm or move to the host composition
 *
 * ——**整份 preset 挂载失败**：宿主重启后 cv-research 会话里一个 cvagent 工具都没有，
 * 而错误只落在宿主日志里，界面上看不出原因。这类"一行坏掉全盘皆输"的机制，
 * 必须在 `pnpm test` 阶段拦下，而不是等到用户重启后才发现。
 *
 * 本测试做两件事：
 * 1. **正例**：仓库里的 cv-research preset（以及存在的工作副本）必须零问题；
 * 2. **反例**：构造一份"服务行没在 isolate 里声明"的组合，检查器**必须报出来**
 *    （护栏自身可用的证明——否则"零问题"可能只是检查没生效）。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkPreset } from '../../../scripts/lib/preset-check.mjs'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const PRESET = join(REPO_ROOT, 'packages', 'dsh-plugin', 'presets', 'cv-research', 'agent.cordis.yml')
const WORK_COPY = join(process.env.USERPROFILE ?? '', '.dsh', '.agent-presets', 'cv-research', 'agent.cordis.yml')

describe('预设组合静态预检', () => {
  it('仓库里的 cv-research preset 零问题，且三个服务行都在 isolate group 内', async () => {
    const result = await checkPreset(PRESET)
    expect(result.problems, result.problems.join('\n')).toEqual([])
    // 服务行必须齐全：少了任何一个都说明 isolate 声明与行不一致
    expect(result.serviceRows.map((row) => row.serviceName).sort()).toEqual(['ideaScore', 'kb', 'projectState'])
  })

  it('工作副本（~/.dsh/.agent-presets）若存在，必须与仓库副本一致地通过检查', async () => {
    if (!existsSync(WORK_COPY)) return // 其他机器上可能还没同步过
    const result = await checkPreset(WORK_COPY, { packageJsonPath: join(REPO_ROOT, 'packages/dsh-plugin/package.json') })
    expect(result.problems, `工作副本有问题（用 Copy-Item 从仓库同步即可）：\n${result.problems.join('\n')}`).toEqual([])

    // 两份文件必须同步——否则宿主里跑的是旧组合
    const [repoText, workText] = await Promise.all([readFile(PRESET, 'utf8'), readFile(WORK_COPY, 'utf8')])
    expect(workText, '工作副本与仓库副本不一致：宿主加载的是工作副本，请同步').toBe(repoText)
  })

  it('反例：服务行漏声明 isolate 键 → 必须被拦下（护栏自身可用的证明）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvagent-preset-'))
    try {
      const broken = join(dir, 'broken.cordis.yml')
      await writeFile(broken, [
        '- id: persona',
        "  name: '@deepseek-ai/dsh-persona'",
        '- id: group',
        '  name: cordis:group',
        '  group: true',
        '  isolate:',
        '    kb: true',
        '  config:',
        '    - id: kb',
        '      name: cv-agent-dsh/kb',
        '    - id: scoring',
        '      name: cv-agent-dsh/idea-score', // ← 漏了 ideaScore 的 isolate 声明
        '',
      ].join('\n'))
      const result = await checkPreset(broken, { packageJsonPath: join(REPO_ROOT, 'packages/dsh-plugin', 'package.json') })
      expect(result.problems.join('\n')).toMatch(/ideaScore/)
      expect(result.problems.join('\n')).toMatch(/isolate/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('反例：服务行裸放在 group 外 → 必须被拦下', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvagent-preset-'))
    try {
      const broken = join(dir, 'naked.cordis.yml')
      await writeFile(broken, [
        '- id: kb',
        '  name: cv-agent-dsh/kb', // ← 没有 group，也没有 isolate
        '',
      ].join('\n'))
      const result = await checkPreset(broken, { packageJsonPath: join(REPO_ROOT, 'packages/dsh-plugin', 'package.json') })
      expect(result.problems.join('\n')).toMatch(/不在 group 内/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('反例：行名指向不存在的 exports → 必须被拦下', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvagent-preset-'))
    try {
      const broken = join(dir, 'badexport.cordis.yml')
      await writeFile(broken, ['- id: ghost', '  name: cv-agent-dsh/does-not-exist', ''].join('\n'))
      const result = await checkPreset(broken, { packageJsonPath: join(REPO_ROOT, 'packages/dsh-plugin', 'package.json') })
      expect(result.problems.join('\n')).toMatch(/exports 里没有/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('工具目录体检脚本（离线）必须通过：装配出的 cvagent 工具面与契约一致', async () => {
    // 把 `scripts/check-tool-catalog.mjs`（装载真实工具行 + 真实 ToolRuntime 枚举目录）
    // 纳入 `pnpm test`——它正是"会话里到底有哪些工具"的唯一断言，不加守护会烂掉。
    // 离线模式不连 Asta；Asta 那 8 个由 tests/spike-asta-mcp.mjs 线上验证。
    const { execFileSync } = await import('node:child_process')
    const script = join(REPO_ROOT, 'scripts', 'check-tool-catalog.mjs')
    // stdio:'ignore'：沙箱禁止用管道捕获子进程输出；非零退出会直接抛错
    expect(() => execFileSync('node', [script], { stdio: 'ignore', timeout: 120_000 })).not.toThrow()
  })
})
