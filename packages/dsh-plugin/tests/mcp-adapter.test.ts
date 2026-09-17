/**
 * core 契约适配器测试（Spike S5 落地）：`sqlite → KnowledgeBase`。
 *
 * 这一层要证明的是**口径一致**，不是"能查出来"：
 * 同一个问题在 dsh 会话里问（`cvagent_kb_search`）和在 MCP 客户端里问，
 * 必须得到同一批候选与同一个分数——否则就是"两套实现迟早分叉"。
 * 所以断言里直接拿 core 的 `lexicalSimilarity` 当基准，而不是写死一组数字。
 *
 * 另外钉住一条**设计决定**：这个适配器是只读的，四个 `upsert*` 必须抛错并说清原因
 * （写路径要走 dsh 工具层的去重规则）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lexicalSimilarity } from '@cv-research/core'

import { createCoreKnowledgeBase, type KnowledgeBaseAdapter } from '../lib/mcp/kb-adapter.js'
import { KbService } from '../lib/kb/service.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(DSH + '@deepseek-ai/dsh-system-prompt/package.json')
const systemPromptModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(pathToFileURL(createRequire(DSH + '@deepseek-ai/cordis/package.json').resolve('@deepseek-ai/cordis')).href)

describe('core KnowledgeBase 适配器（sqlite → core 契约）', () => {
  let dir
  let service
  let adapter

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-mcp-adapter-'))
    const dbPath = join(dir, 'metadata.db')

    // 用真实 KbService 造数据（走真实写入路径，而不是直接 SQL）
    const app = new cordis.Context()
    await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
    await app.plugin({
      name: 'writer',
      inject: ['systemPrompt'],
      apply(ctx) { service = new KbService(ctx, { dbPath }) },
    })
    service.upsertEntry('problems', '跨数据集泛化性能显著下降，未见生成器上几乎失效', ['10.1/a'], {})
    service.upsertEntry('problems', '实时部署时算力开销过大，难以落地', ['10.1/b'], {})
    service.upsertEntry('methods', '多尺度频域融合网络用于伪造痕迹提取', ['10.1/c'], {})
    service.upsertEntry('failures', '小样本条件下该对比损失不收敛', ['10.1/d'], {})
    service.upsertEntry('innovations', '可学习的频域注意力模块', ['10.1/e'], {})
    service.close()

    adapter = createCoreKnowledgeBase({ dbPath })
  })

  afterEach(async () => {
    adapter?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('检索：如实标注 keyword_only，且分数与 core 的 lexicalSimilarity 完全一致', async () => {
    const query = '跨数据集泛化'
    const result = await adapter.kb.similarProblems(query, 5)

    expect(result.mode, '没有 embedding 就不能声称是向量检索（v1.2 §19）').toBe('keyword_only')
    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      // 与 dsh 侧 ideaScore.retrieve() 用的是同一个函数 → 同一个分数
      expect(hit.score).toBe(lexicalSimilarity(query, hit.entry.statement))
    }
    // 按分数降序（调用方期望"最像的在前面"）
    const scores = result.hits.map((hit) => hit.score)
    expect([...scores].sort((left, right) => right - left)).toEqual(scores)
  })

  it('检索：按库分派（problems / methods / failures 各走各的库）', async () => {
    const problems = await adapter.kb.similarProblems('泛化', 5)
    const methods = await adapter.kb.similarMethods('频域', 5)
    const failures = await adapter.kb.similarFailures('对比损失', 5)
    expect(problems.hits.every((hit) => hit.entry.store === 'problems')).toBe(true)
    expect(methods.hits.every((hit) => hit.entry.store === 'methods')).toBe(true)
    expect(failures.hits.every((hit) => hit.entry.store === 'failures')).toBe(true)
    expect(methods.hits[0]?.entry.statement).toContain('频域')
    expect(failures.hits[0]?.entry.statement).toContain('不收敛')
  })

  it('检索：limit 生效且被夹住上限（防一次拉爆上下文）', async () => {
    expect((await adapter.kb.similarProblems('泛化', 1)).hits).toHaveLength(1)
    expect((await adapter.kb.similarProblems('泛化', 0)).hits.length).toBeGreaterThan(0) // 非法值回落默认
    expect((await adapter.kb.similarProblems('泛化', 9999)).hits.length).toBeLessThanOrEqual(200)
  })

  it('摘要：四库计数 + 每库代表条目（条数受 limit 约束）', async () => {
    const summary = await adapter.kb.summarize(1)
    expect(summary.counts).toMatchObject({ problems: 2, methods: 1, innovations: 1, failures: 1 })
    expect(summary.problems).toHaveLength(1)
    expect(summary.methods).toHaveLength(1)
    // 代表条目带来源论文（下游要做溯源）
    expect(summary.problems[0].source_papers.length).toBeGreaterThan(0)
  })

  it('只读：四个 upsert 一律抛错，并说清该走哪条路', async () => {
    for (const call of [
      () => adapter.kb.upsertProblem({} as never),
      () => adapter.kb.upsertMethod({} as never),
      () => adapter.kb.upsertInnovation({} as never),
      () => adapter.kb.upsertFailure({} as never),
    ]) {
      await expect(call()).rejects.toThrow(/写路径必须走 dsh 侧的工具层/)
    }
  })

  it('close 后可安全重复释放（供进程退出钩子调用）', () => {
    const disposable: KnowledgeBaseAdapter = createCoreKnowledgeBase({ dbPath: join(dir, 'metadata.db') })
    disposable.close()
    expect(() => disposable.close()).not.toThrow()
  })
})
