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
import { probeModelCache } from '../lib/scoring/embedding.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
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
  let coreCtx
  await app.plugin({
    name: 'core',
    apply(ctx) {
      coreCtx = ctx
      kb = new KbService(ctx, { dbPath: join(dir, 'metadata.db') })
      service = new IdeaScoreService(ctx, { packDir, packId: 'test-pack', version: '0.1', topk: 5, embeddingCacheDir: join(dir, 'no-models') })
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
    ctx: coreCtx,
    packDir,
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
        service = new IdeaScoreService(ctx, { packDir: join(dir, 'missing'), packId: 'nope', version: '9.9', embeddingCacheDir: join(dir, 'no-models') })
      },
    })
    await expect(service.packInfo()).rejects.toThrow(/找不到 Domain Pack/)
    kb.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('四库召回：命中对应库，且失败库单独一路（不是混在 hits 里）', async () => {
    env = await makeEnv({})
    const evidence = await env.service.retrieve({
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      statement: 's',
    })
    expect(evidence.hits.some((hit) => hit.source === 'problems')).toBe(true)
    expect(evidence.hits.some((hit) => hit.source === 'methods')).toBe(true)
    expect(evidence.failure_hits.length).toBeGreaterThan(0)
    expect(evidence.failure_hits.every((hit) => hit.source === 'failures')).toBe(true)
  })

  it('派生：与库中问题近乎同文 → 问题维度基线接近 0，且不必外扩（相似度超边界带）', async () => {
    env = await makeEnv({})
    const idea = { problem: '跨数据集泛化不足：未见生成方法下性能下降', method: 'CLIP 参数高效微调检测器' }
    const evidence = await env.service.retrieve({ ...idea, statement: 's' })
    const derived = await env.service.derive(idea, evidence)
    expect(derived.baselines.novelty_problem).toBeLessThanOrEqual(10)
    expect(derived.needs_external).toBe(false)
  })

  it('聚合：裁判判撞车 → 该维度封顶 20，总分与档位随之下降，报告自洽可复算', async () => {
    env = await makeEnv({})
    const idea = {
      idea_id: 'IDEA-1',
      statement: '把 CLIP 微调用到跨数据集泛化上',
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      innovation: '组合两者',
      baselines: ['10.1/b'],
    }
    const evidence = await env.service.retrieve(idea)
    const derived = await env.service.derive(idea, evidence)
    const problemHit = derived.evidence.find((item) => item.source === 'problems')

    const judged = await env.service.aggregate({
      idea,
      derived,
      evidence,
      judge: {
        verdicts: [{ ref_id: problemHit.ref_id, verdict: 'collision', reason: '同一问题已在该条目中明确列出' }],
        feasibility: 70,
        rationale: '问题侧撞车，方法侧为组合式改进。',
      },
    })
    expect(judged.dimensions.novelty_problem).toBeLessThanOrEqual(20)
    expect(judged.suggestion).not.toBe('proceed')
    expect(judged.weights_snapshot).toEqual(PACK.scoring.dimensions)
    expect(judged.retrieval_mode).toBe('keyword_only')
    const consistency = env.service.verify(judged)
    expect(consistency.consistent).toBe(true)
    expect(consistency.recomputed).toBe(judged.total)
  })

  it('失败库复查：判 collision → blocked_by；判 superficial → waivers 带理由', async () => {
    env = await makeEnv({})
    const idea = {
      idea_id: 'IDEA-2',
      statement: '只替换频域分支',
      problem: '跨数据集泛化不足',
      method: '频域分支替换',
      innovation: '换分支不换主干',
      baselines: [],
    }
    const evidence = await env.service.retrieve(idea)
    const derived = await env.service.derive(idea, evidence)
    const failureHit = derived.evidence.find((item) => item.source === 'failures')

    const blocked = await env.service.aggregate({
      idea,
      derived,
      evidence,
      judge: {
        verdicts: [{ ref_id: failureHit.ref_id, verdict: 'collision', reason: '失败条件（c23 单数据集、同主干）仍然成立' }],
        rationale: '撞上失败先例。',
      },
    })
    expect(blocked.failure_review?.blocked_by).toEqual([failureHit.ref_id])
    expect(blocked.failure_review?.waivers).toEqual([])

    const waived = await env.service.aggregate({
      idea,
      derived,
      evidence,
      judge: {
        verdicts: [{ ref_id: failureHit.ref_id, verdict: 'superficial', reason: '该失败在 c23 上、用 Xception 主干；本次改用预训练 ViT，条件已变' }],
        rationale: '失败条件不适用。',
      },
    })
    expect(waived.failure_review?.blocked_by).toEqual([])
    expect(waived.failure_review?.waivers[0]?.ref_id).toBe(failureHit.ref_id)
    expect(waived.failure_review?.waivers[0]?.reason).toMatch(/条件已变/)
    expect(waived.failure_review?.hit_refs).toContain(failureHit.ref_id)
  })

  it('裁判上下文包含逐条证据与"不要给总分"的指令', async () => {
    env = await makeEnv({})
    const idea = { statement: 'x', problem: '跨数据集泛化不足', method: 'CLIP 微调', innovation: 'i' }
    const evidence = await env.service.retrieve(idea)
    const derived = await env.service.derive(idea, evidence)
    const payload = env.service.buildJudgePayload({ idea, derived, evidence })
    expect(payload).toContain('[候选 idea]')
    expect(payload).toContain('collision')
    expect(payload).toContain('不要给总分')
    expect(payload).toMatch(/sim=0\.\d{3}/)
    const withExternal = env.service.buildJudgePayload({
      idea,
      derived,
      evidence,
      external: [{ ref_id: '2345.67890', statement: '外部检索到的论文', similarity: 0.14 }],
    })
    expect(withExternal).toContain('外扩检索证据')
    expect(withExternal).toContain('2345.67890')
  })

  it('语义排序不启用：模型就在缓存里也必须走字面（实测它不如字面，2026-09-18 已裁定否决）', async () => {
    env = await makeEnv({})
    // 指到**仓库真实缓存**（不是临时空目录）：这条用例要证的正是
    // "模型可用 ≠ 默认启用"——默认值是决策，不是探测结果
    const cacheDir = join(process.cwd(), '..', '..', 'data', 'models')
    // `ideaScore` 是 Service，同一个 ctx 只能注册一个 → 变体各自开子上下文
    const variant = async (extra) => {
      const sub = new cordis.Context()
      let svc
      await sub.plugin({
        name: 'variant',
        apply(ctx) {
          svc = new IdeaScoreService(ctx, {
            packDir: env.packDir, packId: 'test-pack', version: '0.1', embeddingCacheDir: cacheDir, ...extra,
          })
        },
      })
      return svc
    }

    const offline = await variant({})
    expect((await offline.ranker()).mode, '默认必须是字面').toBe('lexical')
    expect((await offline.packInfo()).rank_mode).toBe('lexical')

    // 反向：显式开启且模型确实缓存 → 才变语义。没下模型就不验这一半（不是"通过"，是"没验"）
    const probe = await probeModelCache(cacheDir)
    if (!probe.ready) {
      console.warn(`模型未缓存（缺 ${probe.missing.join('、')}），只验证了默认关闭这一半`)
      return
    }
    const enabled = await variant({ embeddingEnabled: true })
    expect((await enabled.ranker()).mode, '开启后模型在缓存里就必须是语义').toBe('semantic')
  })
})
