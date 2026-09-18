/**
 * Idea 族工具测试（P3-3b）：真实 ToolRuntime + **假 subagents 提供者**。
 *
 * 不跑真实 LLM，只验证委派契约与编排正确性：
 * - 委派请求形状（provider/parent/label/toolFilter/persona/outputSchema/maxDepth）；
 * - 生成：多视角并发 → 合并去重、空视角与失败视角如实回传（不假装成功）；
 * - 打分：子代理读全库粗筛 → 若它说"本地库不够"则回传 needs_external_evidence（由主 Agent 去跑 Asta）
 *   → **三专家面板**（并行委派 + 分歧一轮讨论 + 中位数聚合）；报告自洽；失败库 blocked_by/waivers 透出；
 * - 契约刚性：三位专家全部未按 outputSchema 应答 → 明确 isError，而不是静默给个分；
 *   部分失败 → 按存活专家聚合，但报告必须点名谁没参与。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import { IdeaScoreService } from '../lib/scoring/service.js'
import * as ideaTools from '../lib/scoring/tools.js'
import { IDEA_TOOLS } from '../lib/tools/names.js'

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
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

const ROOT_AGENT = { id: 'session-root' }

/** 只取专家委派（`expert:*`），把粗筛那次 `screen:*` 排除掉。 */
function expertCalls(env) {
  return env.startCalls.filter((call) => String(call.request.label ?? '').startsWith('expert:'))
}

/** 只取粗筛委派（`screen:*`）。 */
function screenCalls(env) {
  return env.startCalls.filter((call) => String(call.request.label ?? '').startsWith('screen:'))
}

/** @param options.replies 专家委派的返回（按调用顺序）；@param options.screenReply 粗筛的返回 */
async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-ideatools-'))
  const packDir = join(dir, 'packs')
  await mkdir(packDir, { recursive: true })
  await writeFile(join(packDir, 'test-pack-0.1.draft.json'), JSON.stringify(PACK))

  const app = new cordis.Context()
  let runtime
  let kb
  let service
  const startCalls = []
  let call = 0

  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      kb = new KbService(coreCtx, { dbPath: join(dir, 'metadata.db') })
      service = new IdeaScoreService(coreCtx, { packDir, packId: 'test-pack', version: '0.1', topk: 5 })
    },
  })

  // ⚠️ 必须先建论文，条目才挂得上去：`entry_sources` 的反向索引指向 `papers` 表，
  // 论文不存在 → `papersOfEntry` 查出来是空 → **证据卡 0 篇**，专家在空证据上判分。
  // 这个夹具缺了这一层，是 2026-09-18 加粗筛测试时才暴露的（此前那些测试一直都在空证据上跑）。
  const now = new Date().toISOString()
  for (const id of ['10.1/a', '10.1/b', '10.1/c', '10.1/d']) {
    kb.upsertPaper({
      paper_id: id, title: `Paper ${id}`, authors: [], source_channel: 'asta',
      pdf_status: 'downloaded', md_path: `markdown/${id}/full.md`, parse_channel: 'mineru',
      created_at: now, updated_at: now, year: 2025,
    })
  }

  kb.upsertEntry('problems', '跨数据集泛化不足：未见生成方法下性能下降', ['10.1/a'], {})
  kb.upsertEntry('methods', 'CLIP 参数高效微调检测器', ['10.1/b'], {})
  kb.upsertEntry('innovations', '跨数据评测协议：训练于单一数据集、多数据集测试', ['10.1/c'], {})
  kb.upsertEntry('failures', '跨数据集泛化上只做频域分支替换不换主干：AUC 不升反降', ['10.1/d'], {})

  /**
   * 假 subagents：**按 label 路由**，不按调用次序。
   *
   * 粗筛（`screen:*`）与专家（`expert:*`）是两件事。共用一个次序队列的话，
   * 以后任何一步增减委派都会把一堆测试连带改掉，而且改错方向看不出来。
   * `screenReply` 单独给；`replies` 只管专家那一串。
   */
  const fakeSubagents = {
    start(name, request) {
      startCalls.push({ name, request })
      const label = String(request.label ?? '')
      if (label.startsWith('screen:')) {
        return {
          result: Promise.resolve(options.screenReply ?? {
            structured: { matched_problems: [], matched_modules: [] },
            stopReason: 'completed',
          }),
          dispose: async () => {},
        }
      }
      const reply = (options.replies ?? [])[call]
      call += 1
      return {
        result: Promise.resolve(reply ?? { structured: { ideas: [] }, stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }

  ideaTools.apply({
    tools: runtime,
    kb,
    ideaScore: service,
    get: (name) => (name === 'subagents' ? fakeSubagents : undefined),
  })

  let seq = 0
  const execute = (name, args) => runtime.execute({
    callId: `call-${++seq}`,
    name,
    arguments: args,
    agent: ROOT_AGENT,
    signal: new AbortController().signal,
  })

  return {
    execute,
    service,
    kb,
    startCalls,
    dir,
    schemas: () => runtime.schemas().map((schema) => schema.name),
    async cleanup() {
      kb.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const IDEA_REPLY = {
  structured: {
    ideas: [
      { statement: '把频域分支接到 CLIP 适配器上', problem: '跨数据集泛化不足', method: 'CLIP 适配器 + 频域分支', innovation: '频域感知的适配器', baselines: ['10.1/b'] },
      { statement: '用频域一致性正则约束适配器', problem: '跨数据集泛化不足', method: '一致性正则', innovation: '频域一致性损失', baselines: ['10.1/a'] },
    ],
  },
  stopReason: 'completed',
}

/**
 * 三位专家的结构化应答（同一位专家的通用形状：模块判定 + 四维分 + 理由）。
 *
 * 三条给**相同**的分数是刻意的：面板只在分歧（维度分差 > 15）时才跑讨论轮。
 * 测试要断言"委派了几次"，就必须让首轮无分歧、不触发第二轮。
 */
const EXPERT_REPLY = {
  structured: {
    module_verdicts: [
      { idea_module: '频域分支', status: 'partial', evidence_refs: ['M001'], reason: '库里有频域分支，但接的是别的适配器' },
    ],
    dimension_scores: { novelty_problem: 60, novelty_method: 55, novelty_combo: 50, feasibility: 70 },
    rationale: '问题侧只是主题相关；方法侧的频域分支与库中做法有关键差异。',
  },
  stopReason: 'completed',
}

describe('Idea 族工具（真实 ToolRuntime + 假 subagents）', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) {
      await env.cleanup()
      env = undefined
    }
  })

  it('两个工具名注册进目录（与 names.ts 契约一致）', async () => {
    env = await makeEnv({})
    const names = env.schemas()
    expect(names).toContain(IDEA_TOOLS.generate)
    expect(names).toContain(IDEA_TOOLS.score)
    expect(names).toHaveLength(2)
  })

  it('generate：每视角一次委派；契约形状正确；跨视角重复被合并；空视角如实标记', async () => {
    env = await makeEnv({
      replies: [
        IDEA_REPLY,
        IDEA_REPLY, // 同一批候选 → 合并去重后只留一份
        { structured: { ideas: [] }, stopReason: 'completed' }, // 空视角
      ],
    })
    const result = await env.execute(IDEA_TOOLS.generate, {
      sub_domain: '音频深伪检测',
      lenses: ['跨数据集泛化', '频域机制', '音视频一致性'],
      ideas_per_lens: 2,
    })
    expect(result.isError).toBe(false)
    expect(result.value.lens_count).toBe(3)
    expect(result.value.candidate_count).toBe(2) // 前两个视角内容重复 → 合并
    expect(result.value.candidates[0]).toMatchObject({ idea_id: 'IDEA-1', lens: '跨数据集泛化' })
    // 'duplicate' 与 'empty' 必须区分：前者是"想出来了但别人已经说过"，后者是"确实没方向"
    expect(result.value.per_lens.map((item) => item.status)).toEqual(['ok', 'duplicate', 'empty'])

    // 委派契约：provider=spawn、parent=ROOT、工具面只给 kb 只读检索、outputSchema 为候选列表、maxDepth 乐观可派
    const [first] = env.startCalls
    expect(first.name).toBe('spawn')
    expect(first.request.parent).toBe(ROOT_AGENT)
    expect(first.request.toolFilter).toEqual({ allow: ['cvagent_kb_search', 'cvagent_kb_summary'] })
    expect(first.request.persona).toContain('Idea Generator')
    expect(first.request.outputSchema.properties.ideas.type).toBe('array')
    // E33 回归：深度上限是「子代理的绝对层级上限」，必须 ≥ 1（写 0 会让任何委派都失败）。
    // 真正的判据由 tests/subagent-depth.test.ts 调真 SDK 的 resolveChildDepth 校验。
    expect(first.request.maxDepth).toBeGreaterThanOrEqual(1)
    expect(String(first.request.prompt[0].text)).toContain('音频深伪检测')
    expect(String(first.request.prompt[0].text)).toContain('failures') // 提示先查失败库
  })

  it('generate：子代理未按契约应答 → 该视角标 error 并带原因，其余视角不受影响', async () => {
    env = await makeEnv({
      replies: [
        { structured: undefined, stopReason: 'error' },
        IDEA_REPLY,
      ],
    })
    const result = await env.execute(IDEA_TOOLS.generate, { lenses: ['A', 'B'], ideas_per_lens: 1 })
    expect(result.isError).toBe(false)
    expect(result.value.per_lens[0].status).toBe('error')
    expect(result.value.per_lens[0].note).toMatch(/未按契约应答/)
    expect(result.value.per_lens[1].status).toBe('ok')
    expect(result.value.candidate_count).toBe(2)
  })

  it('generate：缺视角时从问题库取（每张问题卡一个视角）', async () => {
    env = await makeEnv({ replies: [IDEA_REPLY] })
    const result = await env.execute(IDEA_TOOLS.generate, { ideas_per_lens: 1, max_lenses: 1 })
    expect(result.value.lens_count).toBe(1)
    expect(result.value.per_lens[0].lens).toContain('跨数据集泛化不足')
  })

  it('score：本地证据充足 → 并行委派三专家并产出可复算报告（含模块对齐/专家分/包/模式透出）', async () => {
    env = await makeEnv({ replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY] })
    const result = await env.execute(IDEA_TOOLS.score, {
      idea_id: 'IDEA-1',
      statement: '把频域分支接到 CLIP 适配器上',
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      innovation: '频域感知适配器',
      method_modules: [{ name: '频域分支', role: '提取频域线索', description: '在适配器旁路加频域分支', kind: 'module' }],
      baselines: ['10.1/b'],
    })
    expect(result.isError).toBe(false)
    expect(result.value.status).toBe('scored')
    expect(result.value.pack_ref).toBe('test-pack@0.1')
    expect(result.value.pack_frozen).toBe(false) // 草案：必须如实标记
    expect(result.value.retrieval_mode).toBe('keyword_only')
    expect(result.value.report_consistent).toBe(true)
    expect(result.value.escalated_external).toBe(false)
    expect(typeof result.value.total).toBe('number')

    // 面板委派契约：三位专家、各自 persona、只给 read（不让专家自行扩大证据集合）、
    // outputSchema 为模块级对齐 + 四维分
    expect(expertCalls(env)).toHaveLength(3)
    expect(expertCalls(env).map((call) => call.request.label)).toEqual(['expert:method', 'expert:evaluation', 'expert:domain'])
    for (const call of expertCalls(env)) {
      expect(call.name).toBe('spawn')
      expect(call.request.parent).toBe(ROOT_AGENT)
      expect(call.request.toolFilter).toEqual({ allow: ['read'] })
      expect(call.request.outputSchema.properties.module_verdicts.type).toBe('array')
      expect(call.request.outputSchema.properties.dimension_scores.type).toBe('object')
      // 无分歧（三位给相同的分）→ 不该触发讨论轮
      expect(String(call.request.prompt[0].text)).not.toContain('[需要你们讨论的分歧点]')
    }
    expect(expertCalls(env)[0].request.persona).toContain('方法/架构专家')
    expect(expertCalls(env)[1].request.persona).toContain('实验/评测专家')
    expect(expertCalls(env)[2].request.persona).toContain('领域/问题专家')

    // 报告必须能回答"分数从哪来"：三位专家各自的分数都在
    expect(result.value.experts).toHaveLength(3)
    expect(result.value.experts.map((expert) => expert.expert)).toEqual(['method', 'evaluation', 'domain'])
    // 模块对齐结论按多数票给出（三位一致 → partial），且无少数派
    expect(result.value.module_alignment).toEqual([{ idea_module: '频域分支', status: 'partial', dissent: [] }])
    // 判 known 才高风险；这里是 partial 且档位由分数决定 → 只断言取值合法
    expect(['high', 'medium', 'low']).toContain(result.value.risk_level)
  })

  it('score：专家分歧 → 只跑一轮讨论；讨论后按中位数聚合', async () => {
    // 首轮 method 给 novelty_method=90、其余给 40 → 分差 50 > 阈值 15 → 触发讨论轮
    const split = (noveltyMethod, status) => ({
      structured: {
        module_verdicts: [{ idea_module: '频域分支', status, evidence_refs: ['M001'], reason: `${status} 的理由` }],
        dimension_scores: { novelty_problem: 60, novelty_method: noveltyMethod, novelty_combo: 50, feasibility: 70 },
        rationale: '各自判断',
      },
      stopReason: 'completed',
    })
    const agreed = (noveltyMethod) => ({
      structured: {
        module_verdicts: [{ idea_module: '频域分支', status: 'partial', evidence_refs: ['M001'], reason: '讨论后维持 partial' }],
        dimension_scores: { novelty_problem: 60, novelty_method: noveltyMethod, novelty_combo: 50, feasibility: 70 },
        rationale: '讨论后修正',
      },
      stopReason: 'completed',
    })
    env = await makeEnv({
      replies: [
        split(90, 'new'), split(40, 'known'), split(40, 'known'), // 首轮
        agreed(50), agreed(50), agreed(50),                        // 讨论轮
      ],
    })
    const result = await env.execute(IDEA_TOOLS.score, {
      idea_id: 'IDEA-D',
      statement: 's', problem: '跨数据集泛化不足：未见生成方法下性能下降', method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    })
    expect(result.isError).toBe(false)
    // 3 首轮 + 3 讨论轮：**只讨论一轮**，不无限收敛
    expect(expertCalls(env)).toHaveLength(6)
    for (const call of expertCalls(env).slice(3)) {
      expect(call.request.label).toMatch(/:r2$/)
      expect(String(call.request.prompt[0].text)).toContain('[需要你们讨论的分歧点]')
    }
    // 聚合取讨论后的第二轮（未收敛的分歧仍要如实报出来）
    expect(result.value.experts.map((expert) => expert.novelty_method)).toEqual([50, 50, 50])
    expect(result.value.dimensions.novelty_method).toBe(50)
    expect(Array.isArray(result.value.panel_notes)).toBe(true)
  })

  it('score：边界带命中 → needs_external_evidence（把外扩检索交回主 Agent），带证据后正常打分', async () => {
    // 造一条与库中问题"相关但不同文"的 idea（相似度落在 [0.1,0.3)）
    env = await makeEnv({ replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY] })
    const ideaArgs = {
      idea_id: 'IDEA-9',
      statement: '跨数据集泛化下的增量检测',
      problem: '持续学习中的灾难性遗忘问题',
      method: '增量学习回放',
      innovation: '少量回放',
      baselines: [],
    }
    // 先往库里加一条"相关但措辞不同"的问题条目，制造边界带
    env.kb.upsertEntry('problems', '增量深伪检测的灾难性遗忘与历史样本回放开销', ['10.1/e'], {})

    const first = await env.execute(IDEA_TOOLS.score, ideaArgs)
    expect(first.isError).toBe(false)
    // 要么直接打分（相似度超出边界带），要么要求外扩——断言不漏两种合法路径
    if (first.value.status === 'needs_external_evidence') {
      expect(first.value.escalation_reason).toMatch(/边界带/)
      expect(first.value.panel_context).toContain('[候选 idea]')
      expect(expertCalls(env)).toHaveLength(0) // 尚未委派专家

      const second = await env.execute(IDEA_TOOLS.score, {
        ...ideaArgs,
        external_evidence: JSON.stringify([{ ref_id: '2345.67890', statement: 'A continual deepfake detection benchmark', similarity: 0.16 }]),
      })
      expect(second.value.status).toBe('scored')
      expect(second.value.escalated_external).toBe(true)
      expect(expertCalls(env)).toHaveLength(3)
      // 外扩证据必须进专家上下文：否则"去跑 Asta"这件事对专家不可见
      expect(String(expertCalls(env)[0].request.prompt[0].text)).toContain('外扩检索证据')
      expect(String(expertCalls(env)[0].request.prompt[0].text)).toContain('2345.67890')
    } else {
      expect(first.value.status).toBe('scored')
    }
  })

  it('score：三位专家全部未按契约应答 → 明确 isError（不静默给分）', async () => {
    const broken = { structured: undefined, stopReason: 'error' }
    env = await makeEnv({ replies: [broken, broken, broken] })
    const result = await env.execute(IDEA_TOOLS.score, {
      statement: 's', problem: '跨数据集泛化不足：未见生成方法下性能下降', method: 'CLIP 参数高效微调检测器',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/三位专家全部失败/)
  })

  it('score：粗筛子代理读全库后挑中的条目 → 用它选候选论文，recall_mode=llm_screen', async () => {
    env = await makeEnv({
      // 粗筛只报条目编号，**不报论文编号**——论文索引由代码从反向索引展开
      screenReply: {
        structured: {
          matched_problems: [{ entry_id: 'P001', why: '同一个问题：跨数据集泛化' }],
          matched_modules: [{ idea_module: '频域分支', library_modules: [] }],
        },
        stopReason: 'completed',
      },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const result = await env.execute(IDEA_TOOLS.score, {
      idea_id: 'IDEA-S',
      statement: '把频域分支接到 CLIP 适配器上',
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    })
    expect(result.isError).toBe(false)
    expect(result.value.recall_mode).toBe('llm_screen')

    // 粗筛委派契约：一个子代理、label=screen:*、prompt 里带着**问题库与模块清单全文**
    const [screenCall] = screenCalls(env)
    expect(screenCalls(env)).toHaveLength(1)
    expect(screenCall.request.label).toBe('screen:IDEA-S')
    const prompt = String(screenCall.request.prompt[0].text)
    expect(prompt).toContain('[问题清单')
    expect(prompt).toContain('P001')                       // 问题库全文在 prompt 里
    expect(prompt).toContain('[做法模块清单')
    expect(prompt).toContain('只用上面清单里出现过的编号')      // 明确要求不许自己编编号
    expect(prompt).toContain('频域分支')                     // idea 自己的模块
    expect(screenCall.request.outputSchema.properties.matched_problems.type).toBe('array')

    // LLM 挑中的条目 → 代码展开成论文 → 证据卡里出现那篇论文（10.1/a）
    const evidence = String(expertCalls(env)[0].request.prompt[0].text)
    expect(evidence).toContain('10.1/a')
  })

  it('score：粗筛报了库里不存在的编号 → 丢弃并在 recall_notes 里点名（不留"引用不存在的论文"）', async () => {
    env = await makeEnv({
      screenReply: {
        structured: {
          matched_problems: [
            { entry_id: 'P001', why: '真条目' },
            { entry_id: 'P999', why: '编的' },
          ],
          matched_modules: [
            { idea_module: '频域分支', library_modules: [{ module_id: 'MOD404', why: '也是编的' }] },
          ],
        },
        stopReason: 'completed',
      },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const result = await env.execute(IDEA_TOOLS.score, {
      statement: 's', problem: '跨数据集泛化不足：未见生成方法下性能下降', method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    })
    expect(result.value.recall_mode).toBe('llm_screen') // 真条目仍在 → 不算整体失败
    const notes = result.value.recall_notes.join('\n')
    expect(notes).toMatch(/P999/)
    expect(notes).toMatch(/MOD404/)
    // 编造的模块编号不该出现在专家上下文里
    expect(String(expertCalls(env)[0].request.prompt[0].text)).not.toContain('MOD404')
  })

  it('score：粗筛失败 → 退回关键词召回，如实标 recall_mode=keyword 并说明原因', async () => {
    env = await makeEnv({
      screenReply: { structured: undefined, stopReason: 'error' },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const result = await env.execute(IDEA_TOOLS.score, {
      statement: '把频域分支接到 CLIP 适配器上', problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    })
    // 粗筛挂了不能拖垮整条链路：仍然出分，但结论强度下降必须说清楚
    expect(result.isError).toBe(false)
    expect(result.value.status).toBe('scored')
    expect(result.value.recall_mode).toBe('keyword')
    expect(result.value.recall_notes.join('\n')).toMatch(/粗筛未成功/)
    expect(result.value.recall_notes.join('\n')).toMatch(/换词同义/)
  })

  it('外扩闸门：拿到 LLM 判断 → 按它决定；`sufficient` 就不外扩', async () => {
    const ideaArgs = {
      idea_id: 'IDEA-G',
      statement: '跨数据集泛化下的增量检测',
      problem: '持续学习中的灾难性遗忘问题',
      method: '增量学习回放',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    }
    env = await makeEnv({
      screenReply: {
        structured: {
          matched_problems: [], matched_modules: [],
          local_coverage: { verdict: 'sufficient', reason: '清单里已有持续学习方向的明确工作，能看清边界' },
        },
        stopReason: 'completed',
      },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const scored = await env.execute(IDEA_TOOLS.score, ideaArgs)
    expect(scored.value.status).toBe('scored')
    expect(scored.value.external_gate).toBe('llm')
    expect(scored.value.escalated_external).toBe(false)
  })

  it('外扩闸门拿不到判断时：**三种具体场景**都仍然出分，但如实报 external_gate=unavailable', async () => {
    const ideaArgs = {
      idea_id: 'IDEA-U',
      statement: '把频域分支接到 CLIP 适配器上',
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    }

    // 场景 1：粗筛子代理没按契约应答（stopReason=error）→ 整个粗筛失败 → 退回关键词召回
    env = await makeEnv({
      screenReply: { structured: undefined, stopReason: 'error' },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const failed = await env.execute(IDEA_TOOLS.score, ideaArgs)
    expect(failed.value.status, '拿不到判断不该拦着打分').toBe('scored')
    expect(failed.value.external_gate).toBe('unavailable')
    expect(failed.value.recall_mode).toBe('keyword')
    expect(failed.value.recall_notes.join('\n')).toMatch(/粗筛未成功/)
    await env.cleanup()
    env = undefined

    // 场景 2：应答合法，但**缺 local_coverage 字段**（模型漏答那个问题）
    env = await makeEnv({
      screenReply: {
        structured: { matched_problems: [{ entry_id: 'P001', why: '相关' }], matched_modules: [] },
        stopReason: 'completed',
      },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const missing = await env.execute(IDEA_TOOLS.score, ideaArgs)
    expect(missing.value.status).toBe('scored')
    expect(missing.value.external_gate, '缺字段 ≠ 判 sufficient，要标成拿不到').toBe('unavailable')
    expect(missing.value.recall_mode, '候选还在，不该因此退回关键词').toBe('llm_screen')
    expect(missing.value.recall_notes.join('\n')).toMatch(/没有回答"本地库够不够"/)
    await env.cleanup()
    env = undefined

    // 场景 3：verdict 取值非法（不在 enum 里）
    env = await makeEnv({
      screenReply: {
        structured: {
          matched_problems: [{ entry_id: 'P001', why: '相关' }], matched_modules: [],
          local_coverage: { verdict: 'maybe', reason: '含糊其辞' },
        },
        stopReason: 'completed',
      },
      replies: [EXPERT_REPLY, EXPERT_REPLY, EXPERT_REPLY],
    })
    const invalid = await env.execute(IDEA_TOOLS.score, ideaArgs)
    expect(invalid.value.status).toBe('scored')
    expect(invalid.value.external_gate).toBe('unavailable')
    expect(invalid.value.recall_notes.join('\n')).toMatch(/没有回答"本地库够不够"/)
  })

  it('外扩闸门：粗筛判 insufficient → 外扩，带 LLM 的理由与**可直接用的检索词**', async () => {
    env = await makeEnv({
      screenReply: {
        structured: {
          matched_problems: [{ entry_id: 'P001', why: '问题相关' }],
          matched_modules: [{ idea_module: '频域分支', library_modules: [] }],
          local_coverage: {
            verdict: 'insufficient',
            reason: '清单里没有任何把频域约束用于持续学习的工作，无法判断世界上有没有',
            suggested_queries: ['continual learning frequency constraint', '频域约束 持续学习 灾难性遗忘'],
          },
        },
        stopReason: 'completed',
      },
      replies: [],
    })
    const result = await env.execute(IDEA_TOOLS.score, {
      idea_id: 'IDEA-I', statement: 's',
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    })
    expect(result.value.status).toBe('needs_external_evidence')
    expect(result.value.external_gate).toBe('llm')
    // 理由用 LLM 自己说的，而不是"相似度 0.14 落在边界带"
    expect(result.value.escalation_reason).toMatch(/没有任何把频域约束用于持续学习/)
    expect(result.value.escalation_reason).not.toMatch(/边界带/)
    // 检索词要能直接拿去用——这是外扩这一步白捡的收益
    expect(result.value.suggested_queries).toContain('continual learning frequency constraint')
    expect(result.value.suggested_queries).toHaveLength(2)
  })

  it('score：部分专家失败 → 仍按存活专家聚合，但报告如实说明谁没参与', async () => {
    env = await makeEnv({
      replies: [
        EXPERT_REPLY,
        { structured: undefined, stopReason: 'error' }, // evaluation 专家崩了
        EXPERT_REPLY,
      ],
    })
    const result = await env.execute(IDEA_TOOLS.score, {
      statement: 's', problem: '跨数据集泛化不足：未见生成方法下性能下降', method: 'CLIP 参数高效微调检测器',
      method_modules: [{ name: '频域分支', role: 'r', description: 'd', kind: 'module' }],
    })
    expect(result.isError).toBe(false)
    expect(result.value.experts).toHaveLength(2) // 只有两位参与聚合
    expect(result.value.panel_notes.join('\n')).toMatch(/evaluation/)
    expect(result.value.report_consistent).toBe(true)
  })

  it('score：external_evidence 非法 JSON → 明确 isError', async () => {
    env = await makeEnv({})
    const result = await env.execute(IDEA_TOOLS.score, {
      statement: 's', problem: 'p', method: 'm', external_evidence: '{不是 JSON',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/external_evidence 不是合法 JSON/)
  })
})
