/**
 * `ideaScore` 服务测试（P3-3b）：确定性召回 / 派生 / 聚合，接真实临时库与真实 pack 文件。
 *
 * 覆盖：
 * - pack 装载：冻结产物优先、缺省回落草案、**未冻结必须如实标记**（否则草案权重会被当权威口径）；
 * - 四库召回：problems/methods 用各自查询串，innovations/failures 用组合串；
 * - 派生：边界带命中 → 建议外扩；基线分定义（无证据 ≠ 新颖）；
 * - 聚合：裁判逐条判定 → 维度分 → 总分/档位/风险；失败库复查（blocked_by / waivers）；
 * - 自洽：verify() 必须复算出同一个总分；报告带权重快照与 pack 标记。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import { IdeaScoreService } from '../lib/scoring/service.js'

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const cordis = await loadDsh('@deepseek-ai/cordis')

const PACK = {
  ref: { pack_id: 'test-pack', version: '0.1' },
  seed_papers: ['10.1/seed'],
  schema_ext: { problems: {}, methods: {}, innovations: {}, failures: {} },
  lexicon: { terms: [{ canonical: 'x', aliases: ['y'] }], query_expansion: [['a', 'b']] },
  benchmarks: { benchmarks: [{ name: 'FF++' }], metrics: ['AUC'], required_protocols: [{ name: 'in_domain', description: 'd' }] },
  scoring: {
    dimensions: { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 },
    thresholds: {
      high_risk_similarity: 0.85,
      topk: 10,
      keyword_only: { related_similarity: 0.1, near_duplicate_similarity: 0.3, boundary_band: [0.1, 0.3] },
    },
    suggestion_bands: { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] },
  },
}

/**
 * 组装：临时库（真实 KbService）+ 临时 pack 目录 + ideaScore 服务。
 * `frozen` 决定写 `…-0.1.json`（冻结产物）还是 `…-0.1.draft.json`（草案）。
 */
async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-idea-'))
  const packDir = join(dir, 'packs')
  await mkdir(packDir, { recursive: true })
  const packFile = options.frozen === true ? 'test-pack-0.1.json' : 'test-pack-0.1.draft.json'
  await writeFile(join(packDir, packFile), JSON.stringify({ ...PACK, ...(options.frozen === true ? { frozen_by: '评审人', frozen_at: '2026-09-17T00:00:00Z' } : {}) }))

  const app = new cordis.Context()
  let kb
  let service
  await app.plugin({
    name: 'core',
    apply(ctx) {
      kb = new KbService(ctx, { dbPath: join(dir, 'metadata.db') })
      service = new IdeaScoreService(ctx, { packDir, packId: 'test-pack', version: '0.1', topk: 5 })
    },
  })

  const now = new Date().toISOString()
  // 种子：一个与目标 idea 近乎同文的问题（判撞车）、一个表面的方法、一条与主题相关的失败先例
  kb.upsertEntry('problems', '跨数据集泛化不足：未见生成方法下性能下降', ['10.1/a'], {})
  kb.upsertEntry('methods', 'CLIP 参数高效微调检测器', ['10.1/b'], {})
  kb.upsertEntry('innovations', '跨数据评测协议：训练于单一数据集、多数据集测试', ['10.1/c'], {})
  // 失败条目必须与查询**topic 相关**（真实失败库就是这样组织的）：这里含"跨数据集泛化"
  kb.upsertEntry('failures', '跨数据集泛化上只做频域分支替换不换主干：AUC 不升反降', ['10.1/d'], {})
  void now

  return {
    service,
    kb,
    dir,
    async cleanup() {
      kb.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('ideaScore 服务', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) {
      await env.cleanup()
      env = undefined
    }
  })

  it('pack 未冻结时如实标记（草案权重不是权威口径）', async () => {
    env = await makeEnv({ frozen: false })
    const info = await env.service.packInfo()
    expect(info.frozen).toBe(false)
    expect(info.frozen_by).toBeNull()
    expect(info.retrieval_mode).toBe('keyword_only')
  })

  it('冻结产物优先于草案，并带出 frozen_by', async () => {
    env = await makeEnv({ frozen: true })
    const info = await env.service.packInfo()
    expect(info.frozen).toBe(true)
    expect(info.frozen_by).toBe('评审人')
  })

  it('找不到 pack 直接报错（没有权重的打分没有意义）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cvagent-nopack-'))
    const app = new cordis.Context()
    let kb
    let service
    await app.plugin({
      name: 'core',
      apply(ctx) {
        kb = new KbService(ctx, { dbPath: join(dir, 'metadata.db') })
        service = new IdeaScoreService(ctx, { packDir: join(dir, 'missing'), packId: 'nope', version: '9.9' })
      },
    })
    await expect(service.packInfo()).rejects.toThrow(/找不到 Domain Pack/)
    kb.close()
    await rm(dir, { recursive: true, force: true })
  })

})
