/**
 * cvagent 状态族工具：真实 ToolRuntime 管线 + 真实文件 I/O + 真实知识库。
 *
 * 与已删除的 gate-tool.test.ts 的区别：那个测试注册的是**内联假工具**验证管线
 * 机制；本测试挂载**真实实现**（`cv-agent-dsh/state` 服务 + `cv-agent-dsh/state-tools`
 * 工具行 + `cv-agent-dsh/kb` 服务），验证的是交付物本身。
 *
 * 覆盖：
 * - 6 个工具的参数校验 / isError 形状（真实 execute 管线）
 * - **真实数字判据**（P3-4）：空库不放行、缺什么说什么、事实来自 kb 而非模型自报
 * - 研究范围落盘（scope_set）与它对知识阶段放行的影响
 * - 三段式门控的完整往返、快照与回滚（真实磁盘）
 * - 动态 prompt 章节随阶段/模式变化（勘误 §4.5 的落点）
 * - 达标流水线在三模式下五阶段走通并可回滚（**用真实数字喂饱判据**）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import { ProjectStateService } from '../lib/state/service.js'
import * as stateTools from '../lib/state/tools.js'
import { statePaths } from '../lib/state/store.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

/**
 * 挂载服务链：systemPrompt → ToolRuntime → projectState + kb → state-tools。
 *
 * kb 必须挂**同一个 ctx**：`ProjectStateService.collectFacts()` 用
 * `this.ctx.get('kb')` 读真实数字——判据的真实性完全依赖这条解析路径，
 * 所以这里刻意用真服务而不是打桩。
 */
async function makeEnv(projectDir) {
  const app = new cordis.Context()
  let runtime
  let service
  let kb
  let prompt
  await app.plugin({
    name: 'state-host-outer',
    async apply(ctx) {
      await ctx.plugin(systemPromptModule.default)
    },
  })
  await app.plugin({
    name: 'state-host-core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      kb = new KbService(coreCtx, { dbPath: join(projectDir, 'metadata.db') })
      service = new ProjectStateService(coreCtx, { projectDir, experimentsDir: join(projectDir, 'experiments') })
      prompt = coreCtx.systemPrompt
    },
  })
  stateTools.apply({ tools: runtime, projectState: service })

  let callSeq = 0
  const execute = (name, args) =>
    runtime.execute({
      callId: `call-${++callSeq}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })

  const section = async (name) => {
    const assembly = await prompt.assemble()
    return assembly.sections.find((s) => s.name === name)?.text
  }

  return { execute, service, kb, section, projectDir }
}

/** 把知识库喂到满足 `knowledge_building` 判据（真实写入，不是打桩数字）。 */
function seedSatisfiedKnowledge(kb) {
  const now = new Date().toISOString()
  for (let i = 0; i < 100; i += 1) {
    const parsed = i < 50
    kb.upsertPaper({
      paper_id: `10.1000/p${i}`,
      title: `Paper ${i}`,
      authors: [],
      source_channel: 'asta',
      pdf_status: parsed ? 'downloaded' : 'pending',
      ...(parsed ? { md_path: `markdown/10.1000/p${i}/full.md`, parse_channel: 'mineru' } : {}),
      created_at: now,
      updated_at: now,
    })
  }
  for (let i = 0; i < 20; i += 1) {
    kb.saveExtraction({
      paper_id: `10.1000/p${i}`,
      problem_statement: `问题 ${i}`,
      method_summary: `方法 ${i}`,
      innovations: [],
      future_work: [],
      limitations: [],
      benchmarks: [],
      metrics: [],
      baseline_methods: [],
      extraction_quality: 'full_text',
      extracted_at: now,
    })
  }
  const fill = (store, count, prefix) => {
    for (let i = 0; i < count; i += 1) kb.upsertEntry(store, `${prefix} 条目 ${i}`, [`10.1000/p${i}`], {})
  }
  fill('problems', 5, '问题卡')
  fill('methods', 5, '方法卡')
  fill('innovations', 10, '创新卡')
  fill('failures', 5, '失败先例')
}

/** 造一个"已收敛实验"（目录 + RESULTS.md），供 experiment 阶段判据使用。 */
async function writeConvergedExperiment(projectDir, name = 'E001-demo') {
  const dir = join(projectDir, 'experiments', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'RESULTS.md'), '# 结果\n\n## 负面结论\n\n无。\n')
}

const MET_STAGES = ['knowledge_building', 'idea_generation', 'idea_scoring', 'experiment'] as const

/** 走完一个阶段的完整门控往返：advance → gate_resolve(advance)。 */
async function walkStage(execute, summary) {
  const advanced = await execute('cvagent_state_advance', { summary })
  expect(advanced.isError).toBe(false)
  expect(advanced.value.satisfied).toBe(true)
  expect(advanced.value.gate_requested).toBe(true)
  const resolved = await execute('cvagent_gate_resolve', { decision: 'advance', comment: `同意（${summary}）` })
  expect(resolved.isError).toBe(false)
  return resolved.value
}

describe('cvagent 状态族工具（真实实现 + 真实管线）', () => {
  let dir
  let env

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-state-tools-'))
    env = await makeEnv(dir)
  })

  afterEach(async () => {
    env.kb.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('全新项目：state_get 报 exists:false，且不创建状态文件', async () => {
    const result = await env.execute('cvagent_state_get', {})
    expect(result.isError).toBe(false)
    expect(result.value.exists).toBe(false)
    expect(result.value.state).toBeUndefined()
    expect(await env.service.getState()).toBeUndefined()
  })

  it('无 config 构造（preset 行不带 config 的场景）：默认值解析完整', async () => {
    const { resolveStateConfig } = await import('../lib/state/service.js')
    expect(resolveStateConfig(undefined)).toEqual({
      projectDir: 'data/projects/default',
      stateFilename: 'project_state.json',
      projectId: 'cv-research-project',
      experimentsDir: 'experiments',
    })
    expect(resolveStateConfig({ projectDir: dir })).toMatchObject({
      projectDir: dir,
      projectId: 'cv-research-project',
      experimentsDir: 'experiments',
    })
  })

  it('advance 缺摘要 → 参数校验拦下并返回 isError', async () => {
    const result = await env.execute('cvagent_state_advance', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/summary/)
  })

  // ── P3-4：真实数字判据 ───────────────────────────────────────────────────
  it('空知识库 → 不放行，且缺失项是真实数字（不是"摘要为空"）', async () => {
    const result = await env.execute('cvagent_state_advance', { summary: '知识构建完成（口头声称）' })
    expect(result.isError).toBe(false)
    expect(result.value.satisfied).toBe(false)
    expect(result.value.gate_requested).toBe(false)
    // 模型自报"完成了"不算数：判据看真实数字
    expect(result.value.missing).toEqual(expect.arrayContaining([
      expect.stringMatching(/研究范围未确定/),
      expect.stringMatching(/论文库 0\/100/),
      expect.stringMatching(/已解析全文 0\/50/),
      expect.stringMatching(/结构化提取（抽检口径）0\/20/),
      expect.stringMatching(/问题卡 0\/5/),
      expect.stringMatching(/方法卡 0\/5/),
      expect.stringMatching(/创新卡 0\/10/),
      expect.stringMatching(/失败方法库 0\/5/),
    ]))
    const facts = JSON.parse(result.value.facts_json)
    expect(facts.papers).toBe(0)
    expect(facts.sub_domain).toBeNull()
  })

  it('scope_set 落盘研究范围；只传 keywords 时不影响 sub_domain', async () => {
    const set = await env.execute('cvagent_scope_set', { sub_domain: '  音频深伪检测  ', keywords: ['audio deepfake', 'ASVspoof', 'audio deepfake'] })
    expect(set.isError).toBe(false)
    expect(set.value.sub_domain).toBe('音频深伪检测')
    expect(set.value.keywords).toEqual(['audio deepfake', 'ASVspoof'])
    expect(set.value.scope_ready).toBe(true)

    const again = await env.execute('cvagent_scope_set', { keywords: ['speech anti-spoofing'] })
    expect(again.value.sub_domain).toBe('音频深伪检测') // 未被覆盖
    expect(again.value.keywords).toEqual(['speech anti-spoofing'])

    // 清空
    const cleared = await env.execute('cvagent_scope_set', { sub_domain: '' })
    expect(cleared.value.sub_domain).toBe('')
    expect(cleared.value.scope_ready).toBe(false)
  })

  it('喂饱知识库并落盘范围 → 知识阶段放行；缺失项随之清空', async () => {
    seedSatisfiedKnowledge(env.kb)
    await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测', keywords: ['audio deepfake'] })

    const stillMissing = await env.execute('cvagent_state_advance', { summary: '复核' })
    // 还差"已收敛实验"以外的项都应满足（experiment 判据属于后面的阶段）
    expect(stillMissing.value.satisfied).toBe(true)
    const facts = JSON.parse(stillMissing.value.facts_json)
    expect(facts.papers).toBe(100)
    expect(facts.parsed).toBe(50)
    expect(facts.extractions).toBe(20)
    expect(facts.entries).toMatchObject({ problems: 5, methods: 5, innovations: 10, failures: 5 })
  })

  it('advance 达标 → 写入待决门控；动态章节反映待决状态（A 模式要求先问用户）', async () => {
    seedSatisfiedKnowledge(env.kb)
    await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测' })
    await env.execute('cvagent_mode_set', { mode: 'confirm' })

    const result = await env.execute('cvagent_state_advance', { summary: '知识构建完成：papers=100（真实）' })
    expect(result.value.satisfied).toBe(true)
    expect(result.value.gate_requested).toBe(true)

    const text = await env.section('cvagent:state')
    expect(text).toContain('knowledge_building')
    expect(text).toContain('有待决门控')
    expect(text).toContain('ask_user_question')
  })

  it('gate_resolve 无待决门控 → isError 且不推进、不改状态', async () => {
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    const result = await env.execute('cvagent_gate_resolve', { decision: 'advance' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/没有待决 gate/)
    const state = await env.service.getState()
    expect(state?.current_stage).toBe('knowledge_building')
    expect(state?.resolved_gates).toEqual([])
  })

  it('完整往返：advance → resolve(advance) → 快照 → 回滚', async () => {
    seedSatisfiedKnowledge(env.kb)
    await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测' })
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    await walkStage(env.execute, '知识构建完成')

    const state = await env.service.getState()
    expect(state?.current_stage).toBe('idea_generation')
    expect(state?.sub_domain).toBe('音频深伪检测') // 范围随状态持久化
    expect(state?.rollback_points).toEqual(['after_knowledge_building'])
    expect(await env.service.listSnapshots()).toEqual(['after_knowledge_building'])

    const { readFile } = await import('node:fs/promises')
    const snapshot = JSON.parse(await readFile(join(statePaths({ projectDir: dir }).snapshotRoot, 'after_knowledge_building.json'), 'utf8'))
    expect(snapshot.current_stage).toBe('idea_generation')

    const rollback = await env.execute('cvagent_state_rollback', { point: 'after_knowledge_building' })
    expect(rollback.isError).toBe(false)
    expect(rollback.value.restored_stage).toBe('idea_generation')
    expect((await env.service.getState())?.current_stage).toBe('idea_generation')
  })

  it('动态 prompt 章节随阶段推进变化', async () => {
    seedSatisfiedKnowledge(env.kb)
    await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测' })
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    expect(await env.section('cvagent:state')).toContain('knowledge_building')
    await walkStage(env.execute, '知识构建完成')
    expect(await env.section('cvagent:state')).toContain('idea_generation')

    await env.service.noteIdeaActivity('generated', 3)
    await walkStage(env.execute, 'Idea 生成完成')
    expect(await env.section('cvagent:state')).toContain('idea_scoring')
  })

  it('idea 阶段判据看生成/打分的真实计数（noteIdeaActivity）', async () => {
    seedSatisfiedKnowledge(env.kb)
    await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测' })
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    await walkStage(env.execute, '知识构建完成')

    // 没生成过 idea → 不放行
    const noIdeas = await env.execute('cvagent_state_advance', { summary: '声称想好了' })
    expect(noIdeas.value.satisfied).toBe(false)
    expect(noIdeas.value.missing.join(' ')).toMatch(/候选 idea 0\/3/)

    await env.service.noteIdeaActivity('generated', 3)
    await walkStage(env.execute, '生成 3 条候选')

    // 未打分 → 不放行
    const noScore = await env.execute('cvagent_state_advance', { summary: '声称打过分' })
    expect(noScore.value.satisfied).toBe(false)
    expect(noScore.value.missing.join(' ')).toMatch(/已打分 idea 0\/1/)
    await env.service.noteIdeaActivity('scored', 1)
    await walkStage(env.execute, '完成打分')
    expect((await env.service.getState())?.current_stage).toBe('experiment')
  })

  it('experiment 阶段判据数 experiments/ 下有 RESULTS.md 的实验', async () => {
    seedSatisfiedKnowledge(env.kb)
    await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测' })
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    await walkStage(env.execute, '知识构建完成')
    await env.service.noteIdeaActivity('generated', 3)
    await walkStage(env.execute, '生成候选')
    await env.service.noteIdeaActivity('scored', 1)
    await walkStage(env.execute, '完成打分')

    // 只有目录没有 RESULTS.md → 不算收敛
    await mkdir(join(dir, 'experiments', 'E002-empty'), { recursive: true })
    const notYet = await env.execute('cvagent_state_advance', { summary: '声称跑完了' })
    expect(notYet.value.satisfied).toBe(false)
    expect(notYet.value.missing.join(' ')).toMatch(/已收敛实验 0\/1/)

    await writeConvergedExperiment(dir)
    await walkStage(env.execute, '实验收敛')
    expect((await env.service.getState())?.current_stage).toBe('writing')
  })

  describe('达标流水线：三模式五阶段走通并可回滚', () => {
    for (const mode of ['confirm', 'supervised', 'full_auto'] as const) {
      it(`模式 ${mode}：推进到 writing，可回滚`, async () => {
        seedSatisfiedKnowledge(env.kb)
        await writeConvergedExperiment(dir)
        await env.execute('cvagent_scope_set', { sub_domain: '音频深伪检测' })
        await env.execute('cvagent_mode_set', { mode })
        await env.service.noteIdeaActivity('generated', 3)
        await env.service.noteIdeaActivity('scored', 1)

        for (const stage of MET_STAGES) {
          const resolved = await walkStage(env.execute, `${stage} 完成`)
          expect(resolved.current_stage).not.toBe(stage)
        }
        const finalAdvance = await walkStage(env.execute, 'writing 完成')
        expect(finalAdvance.current_stage).toBe('writing')

        const state = await env.service.getState()
        expect(state?.current_stage).toBe('writing')
        expect(state?.rollback_points.length).toBe(MET_STAGES.length + 1)

        const rollback = await env.execute('cvagent_state_rollback', { point: 'after_knowledge_building' })
        expect(rollback.value.restored_stage).toBe('idea_generation')

        const text = await env.section('cvagent:state')
        if (mode === 'confirm') expect(text).toContain('ask_user_question')
        else expect(text).not.toContain('必须先经 ask_user_question')
      })
    }
  })
})
