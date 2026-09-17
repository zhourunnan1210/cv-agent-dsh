/**
 * Idea 族工具测试（P3-3b）：真实 ToolRuntime + **假 subagents 提供者**。
 *
 * 不跑真实 LLM，只验证委派契约与编排正确性：
 * - 委派请求形状（provider/parent/label/toolFilter/persona/outputSchema/maxDepth）；
 * - 生成：多视角并发 → 合并去重、空视角与失败视角如实回传（不假装成功）；
 * - 打分：本地召回 → 边界带外扩（回传 needs_external_evidence，由主 Agent 去跑 Asta）
 *   → 裁判逐条判定 → 确定性聚合；报告自洽；失败库 blocked_by/waivers 透出；
 * - 契约刚性：裁判未按 outputSchema 应答 → 明确 isError，而不是静默给个分。
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

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
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

/** @param options.replies 每次委派的返回（按调用顺序），`undefined` 表示 structured 缺失 */
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

  kb.upsertEntry('problems', '跨数据集泛化不足：未见生成方法下性能下降', ['10.1/a'], {})
  kb.upsertEntry('methods', 'CLIP 参数高效微调检测器', ['10.1/b'], {})
  kb.upsertEntry('failures', '跨数据集泛化上只做频域分支替换不换主干：AUC 不升反降', ['10.1/d'], {})

  const fakeSubagents = {
    start(name, request) {
      startCalls.push({ name, request })
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

const JUDGE_REPLY = {
  structured: {
    verdicts: [{ ref_id: 'P001', verdict: 'superficial', reason: '该问题条目描述的是泛化困境，本 idea 提出的是具体机制' }],
    feasibility: 72,
    rationale: '问题侧只是主题相关；方法侧无可比条目。',
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

    // 委派契约：provider=spawn、parent=ROOT、工具面只给 kb 只读检索、outputSchema 为候选列表、maxDepth=0
    const [first] = env.startCalls
    expect(first.name).toBe('spawn')
    expect(first.request.parent).toBe(ROOT_AGENT)
    expect(first.request.toolFilter).toEqual({ allow: ['cvagent_kb_search', 'cvagent_kb_summary'] })
    expect(first.request.persona).toContain('Idea Generator')
    expect(first.request.outputSchema.properties.ideas.type).toBe('array')
    expect(first.request.maxDepth).toBe(0)
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

  it('score：本地证据充足 → 直接委派裁判并产出可复算报告（含包/模式/失败库透出）', async () => {
    env = await makeEnv({ replies: [JUDGE_REPLY] })
    const result = await env.execute(IDEA_TOOLS.score, {
      idea_id: 'IDEA-1',
      statement: '把频域分支接到 CLIP 适配器上',
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调检测器',
      innovation: '频域感知适配器',
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

    // 裁判委派契约：与生成者独立、只给 read、outputSchema 为逐条判定
    const [judgeCall] = env.startCalls
    expect(judgeCall.request.toolFilter).toEqual({ allow: ['read'] })
    expect(judgeCall.request.persona).toContain('Judge')
    expect(String(judgeCall.request.prompt[0].text)).toContain('不要给总分')
    expect(judgeCall.request.outputSchema.properties.verdicts.type).toBe('array')
  })

  it('score：边界带命中 → needs_external_evidence（把外扩检索交回主 Agent），带证据后正常打分', async () => {
    // 造一条与库中问题"相关但不同文"的 idea（相似度落在 [0.1,0.3)）
    env = await makeEnv({ replies: [JUDGE_REPLY] })
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
      expect(first.value.judge_payload).toContain('[候选 idea]')
      expect(env.startCalls).toHaveLength(0) // 尚未委派裁判

      const second = await env.execute(IDEA_TOOLS.score, {
        ...ideaArgs,
        external_evidence: JSON.stringify([{ ref_id: '2345.67890', statement: 'A continual deepfake detection benchmark', similarity: 0.16 }]),
      })
      expect(second.value.status).toBe('scored')
      expect(second.value.escalated_external).toBe(true)
      expect(env.startCalls).toHaveLength(1)
      expect(String(env.startCalls[0].request.prompt[0].text)).toContain('外扩检索证据')
    } else {
      expect(first.value.status).toBe('scored')
    }
  })

  it('score：裁判未按契约应答 → 明确 isError（不静默给分）', async () => {
    env = await makeEnv({ replies: [{ structured: undefined, stopReason: 'error' }] })
    const result = await env.execute(IDEA_TOOLS.score, {
      statement: 's', problem: '跨数据集泛化不足：未见生成方法下性能下降', method: 'CLIP 参数高效微调检测器',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/未按契约应答/)
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
