/**
 * 写作工具测试（P4-1）：`cvagent_write_draft` 的**上下文组装**与**委派契约**。
 *
 * 重点不是"能不能写"，而是：
 * - 组装进 prompt 的材料是否**真的**包含领域口径（pack 的规范数据集名/指标/术语）、
 *   三库条目（含 paper_id，供引用）、**实验证据的文件路径**（不是内容——溯源链不能断在工具层）、写作纪律；
 * - 委派契约是否约束到位（工具面必须含 `skill`，且不得含写库工具）；
 * - 只回摘要：正文不进父上下文。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import * as writeTools from '../lib/writing/tools.js'
import { IDEA_TOOLS } from '../lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

const ROOT_AGENT = { id: 'session-root' }
const NOW = '2026-09-17T00:00:00Z'

const FROZEN_PACK = {
  ref: { pack_id: 'deepfake-detection', version: '0.1' },
  frozen_by: '周润楠',
  frozen_at: NOW,
  seed_papers: ['10.1/a'],
  schema_ext: { problems: {}, methods: {}, innovations: {}, failures: {} },
  lexicon: { terms: [{ canonical: 'face_swap', aliases: ['faceswap', 'deepfakes'] }], query_expansion: [['a']] },
  benchmarks: {
    benchmarks: [{ name: 'FaceForensics++' }, { name: 'Celeb-DF' }],
    metrics: ['AUC', 'ACC'],
    required_protocols: [{ name: 'in_domain', description: 'd' }, { name: 'cross_dataset', description: 'd' }],
  },
  scoring: {
    dimensions: { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 },
    thresholds: { high_risk_similarity: 0.85, topk: 10, keyword_only: { related_similarity: 0.1, near_duplicate_similarity: 0.3, boundary_band: [0.1, 0.3] } },
    suggestion_bands: { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] },
  },
}

async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-write-'))
  const app = new cordis.Context()
  let runtime
  let kb
  const startCalls = []

  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      kb = new KbService(coreCtx, { dbPath: join(dir, 'metadata.db') })
    },
  })

  // 写作 skill 根（数据驱动校验用）：造三个假 skill 目录
  const skillsDir = join(dir, 'skills')
  for (const skill of options.skills ?? ['academic-paper', 'ccf-paper-writer', 'nature-writing']) {
    await mkdir(join(skillsDir, skill), { recursive: true })
    await writeFile(join(skillsDir, skill, 'SKILL.md'), `# ${skill}\n`)
  }

  // 实验归档：一个已收敛实验（含 EVIDENCE） + 一个只有目录的
  const experimentsDir = join(dir, 'experiments')
  await mkdir(join(experimentsDir, 'E001-demo'), { recursive: true })
  await writeFile(join(experimentsDir, 'E001-demo', 'RESULTS.md'), '# 结果\n\nAUC 提升 1.2 个点。\n')
  await writeFile(join(experimentsDir, 'E001-demo', 'EVIDENCE.md'), '| 数字 | 来源 |\n| --- | --- |\n| 1.2 | runs/20260917-1200-abc/metrics.json#auc |\n')

  // 冻结 pack + 绑定（可用 `pack: false` 构造"尚未冻结"的场景）
  if (options.pack !== false) {
    const packPath = join(dir, 'deepfake-detection-0.1.json')
    await writeFile(packPath, JSON.stringify(FROZEN_PACK))
    kb.registerDomainPack(FROZEN_PACK, packPath)
    kb.bindProjectPack('cv-research-default', 'deepfake-detection', '0.1')
  }

  // 三库条目（写作素材）
  kb.upsertEntry('problems', '跨数据集泛化不足：未见生成方法下性能下降', ['10.1/a'], { 'deepfake-detection': { modality: 'visual' } })
  kb.upsertEntry('methods', 'WMamba：小波特征 + Mamba 主干', ['10.1/b'], { 'deepfake-detection': { paradigm: 'hybrid' } })

  const fakeSubagents = {
    start(name, request) {
      startCalls.push({ name, request })
      return {
        result: Promise.resolve(options.reply ?? {
          structured: {
            draft_path: join(dir, 'drafts', 'method.md'),
            word_count: 812,
            sections: ['## 方法概述', '## 训练细节'],
            cited_entry_ids: ['M001'],
            evidence_refs: ['experiments/E001-demo/EVIDENCE.md', 'paper:10.1/a'],
            skill_used: 'academic-paper',
            todos: ['缺 Celeb-DF 上的消融数字'],
          },
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }
    },
  }

  writeTools.apply(
    { tools: runtime, kb, get: (n) => (n === 'subagents' ? fakeSubagents : undefined) },
    { draftsDir: join(dir, 'drafts'), experimentsDir, projectSkillsDir: skillsDir },
  )

  let seq = 0
  const execute = (name, args) => runtime.execute({
    callId: `call-${++seq}`, name, arguments: args, agent: ROOT_AGENT, signal: new AbortController().signal,
  })
  return {
    execute, kb, startCalls, dir,
    schemas: () => runtime.schemas().map((schema) => schema.name),
    async cleanup() { kb.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

describe('cvagent_write_draft（上下文组装 + Writer 委派）', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) { await env.cleanup(); env = undefined }
  })

  it('工具名注册（与 names.ts 契约一致）', async () => {
    env = await makeEnv({})
    expect(env.schemas()).toContain(IDEA_TOOLS.writeDraft)
    expect(env.schemas()).toHaveLength(1)
  })

  it('组装：prompt 里带领域口径（规范数据集/指标/术语）、三库条目、证据路径、写作纪律', async () => {
    env = await makeEnv({})
    const result = await env.execute(IDEA_TOOLS.writeDraft, { section: 'method', topic: '跨数据集泛化', extra_instructions: '目标会议：CVPR' })
    expect(result.isError).toBe(false)

    const [call] = env.startCalls
    expect(call.name).toBe('spawn')
    expect(call.request.parent).toBe(ROOT_AGENT)
    expect(call.request.maxDepth).toBe(0)
    const prompt = String(call.request.prompt[0].text)

    // 领域口径来自**已冻结 pack**（含评审人）
    expect(prompt).toContain('deepfake-detection@0.1')
    expect(prompt).toContain('评审人 周润楠')
    expect(prompt).toContain('FaceForensics++、Celeb-DF')
    expect(prompt).toContain('AUC、ACC')
    expect(prompt).toContain('in_domain、cross_dataset')
    expect(prompt).toContain('face_swap←faceswap')

    // 三库条目（带 ID 与来源论文，供引用）
    expect(prompt).toMatch(/M001|P001/)
    expect(prompt).toContain('10.1/a')

    // 证据**只给路径**（内容由 Writer 自己读——数字溯源链不能断在工具层）
    expect(prompt).toContain('E001-demo')
    expect(prompt).toContain('EVIDENCE.md')
    expect(prompt).toMatch(/必须自己 read/)

    // 写作纪律 + skill 指令 + 附加要求
    expect(prompt).toContain('docs/实验归档与组织原则.md')
    expect(prompt).toMatch(/skill\(\{ name: "academic-paper" \}\)/)
    expect(prompt).toContain('CVPR')
    expect(prompt).toContain('## TODO')
  })

  it('委派契约：工具面含 skill/read/write/present，且**不含写库工具**', async () => {
    env = await makeEnv({})
    await env.execute(IDEA_TOOLS.writeDraft, { section: 'abstract' })
    const allow = env.startCalls[0].request.toolFilter.allow
    for (const required of ['read', 'write', 'skill', 'present', 'cvagent_kb_search']) expect(allow).toContain(required)
    expect(allow).not.toContain('cvagent_kb_upsert_entry')
    expect(allow).not.toContain('cvagent_domain_freeze')
    expect(String(env.startCalls[0].request.persona)).toContain('Writer')
  })

  it('只回摘要：字数/引用计数/缺口，正文不进父上下文', async () => {
    env = await makeEnv({})
    const result = await env.execute(IDEA_TOOLS.writeDraft, { section: 'method' })
    expect(result.value.word_count).toBe(812)
    expect(result.value.sections_count).toBe(2)
    expect(result.value.cited_entry_count).toBe(1)
    expect(result.value.evidence_ref_count).toBe(2)
    expect(result.value.todos).toEqual(['缺 Celeb-DF 上的消融数字'])
    expect(result.value.skill_used).toBe('academic-paper')
    expect(result.value.available_skills).toEqual(['academic-paper', 'ccf-paper-writer', 'nature-writing'])
    const packed = JSON.parse(result.value.packed_context)
    expect(packed.experiments).toEqual(['E001-demo'])
    expect(packed.entries).toBeGreaterThan(0)
  })

  it('skill 校验：不存在的 skill 明确报错并列出可用项（数据驱动，不硬编码）', async () => {
    env = await makeEnv({})
    const result = await env.execute(IDEA_TOOLS.writeDraft, { section: 'method', skill_name: 'nature-typo' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/找不到写作 skill/)
    expect(JSON.stringify(result.content)).toMatch(/academic-paper/)
    expect(env.startCalls).toHaveLength(0)
  })

  it('无已收敛实验时：证据缺失写进 TODO，不许编造（prompt 明确说明）', async () => {
    env = await makeEnv({})
    const result = await env.execute(IDEA_TOOLS.writeDraft, { section: 'experiments' })
    const packed = JSON.parse(result.value.packed_context)
    expect(packed.experiments).toEqual(['E001-demo'])
    // 指定一个不存在的实验 → 证据清单为空，prompt 给出"写成 TODO"的指令
    const second = await env.execute(IDEA_TOOLS.writeDraft, { section: 'experiments', experiment_ids: ['E999-nope'] })
    expect(second.isError).toBe(false)
    const prompt = String(env.startCalls[1].request.prompt[0].text)
    expect(prompt).toMatch(/暂无已收敛实验|不得编造/)
  })

  it('未冻结 pack：明确标注，让 Writer 知道口径未获评审', async () => {
    env = await makeEnv({ pack: false })
    const result = await env.execute(IDEA_TOOLS.writeDraft, { section: 'introduction' })
    const prompt = String(env.startCalls[0].request.prompt[0].text)
    expect(prompt).toMatch(/尚无已冻结版本/)
    expect(prompt).toMatch(/包未冻结/)
    expect(result.isError).toBe(false)
  })

  it('Writer 未按契约应答 → 明确 isError（不静默产出空草稿）', async () => {
    env = await makeEnv({ reply: { structured: undefined, stopReason: 'error' } })
    const result = await env.execute(IDEA_TOOLS.writeDraft, { section: 'method' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/未按契约应答/)
  })
})
