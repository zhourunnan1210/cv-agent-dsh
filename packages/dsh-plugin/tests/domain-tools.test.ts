/**
 * 领域包族工具测试（P3-5）：真实 ToolRuntime + 真实文件 + 真实注册表。
 *
 * 治理规则是这一族的重点，因此测试围绕它们展开：
 * - **空签名不得冻结**（v1.2 §3.4.4 不可豁免）——core 抛错，工具必须把它变成 isError；
 * - **同版本不得重复冻结**（改 pack 必须升版本）；
 * - **契约校验前置**（权重合计、档位连续、enum 有值…不通过就不许冻）；
 * - 派生**确定性**（同输入同草案，只有时间戳不同）；
 * - 修订走 `propose_revision`（新版本 + 差异摘要），绑定只接受已冻结版本。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import * as domainTools from '../lib/domain/tools.js'
import { DOMAIN_TOOLS } from '../lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

const NOW = '2026-09-17T00:00:00Z'

async function makeEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-domain-'))
  const packDir = join(dir, 'packs')
  const app = new cordis.Context()
  let runtime
  let kb

  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      kb = new KbService(coreCtx, { dbPath: join(dir, 'metadata.db') })
    },
  })
  domainTools.apply({ tools: runtime, kb }, { packDir, projectId: 'proj-test', packId: 'demo-pack', version: '0.1' })

  // 种子：两篇论文 + 提取（喂 benchmarks/metrics）+ 四库条目（喂 schema_ext）
  for (const [index, paperId] of ['10.1/a', '10.1/b'].entries()) {
    kb.upsertPaper({
      paper_id: paperId, title: `Paper ${index}`, authors: [], source_channel: 'asta',
      pdf_status: 'downloaded', md_path: `markdown/${paperId}/full.md`, parse_channel: 'mineru',
      created_at: NOW, updated_at: NOW,
    })
    kb.saveExtraction({
      paper_id: paperId,
      problem_statement: '跨数据集泛化不足',
      method_summary: '频域分支 + CLIP 适配器',
      innovations: ['频域一致性损失'],
      future_work: [],
      limitations: ['在噪声环境下退化'],
      benchmarks: ['FaceForensics++ (FF++)', 'Celeb-DF-v2', 'FF++'],
      metrics: ['AUC', 'AUROC', 'Accuracy'],
      baseline_methods: ['Xception', 'FTCN', 'RECCE', 'SBI'],
      extraction_quality: 'full_text',
      extracted_at: NOW,
    })
  }
  kb.upsertEntry('problems', '跨数据集泛化不足：未见生成方法下性能下降', ['10.1/a'], { 'demo-pack': { modality: 'visual' } })
  kb.upsertEntry('methods', 'CLIP 适配器 + 频域分支', ['10.1/a'], { 'demo-pack': { paradigm: 'hybrid', backbone: 'CLIP' } })
  kb.upsertEntry('innovations', '频域一致性损失', ['10.1/b'], { 'demo-pack': { innovation_type: 'new_loss' } })
  kb.upsertEntry('failures', '只换分支不换主干：AUC 不升反降', ['10.1/b'], { 'demo-pack': { failure_mode: 'metric_not_improved' } })

  let seq = 0
  const execute = (name, args) => runtime.execute({
    callId: `call-${++seq}`, name, arguments: args, signal: new AbortController().signal,
  })
  return {
    execute, kb, packDir, dir,
    schemas: () => runtime.schemas().map((schema) => schema.name),
    async cleanup() { kb.close(); await rm(dir, { recursive: true, force: true }) },
  }
}

describe('领域包族工具（真实文件 + 真实注册表）', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) { await env.cleanup(); env = undefined }
  })

  it('四个工具名注册进目录（与 names.ts 契约一致）', async () => {
    env = await makeEnv()
    const names = env.schemas()
    for (const expected of Object.values(DOMAIN_TOOLS)) expect(names).toContain(expected)
    expect(names).toHaveLength(4)
  })

  it('bootstrap：从真实知识库派生草案并落盘；schema_ext 反映真实用过的 ext 键', async () => {
    env = await makeEnv()
    const result = await env.execute(DOMAIN_TOOLS.bootstrap, { notes: '首版' })
    expect(result.isError).toBe(false)
    expect(result.value.contract_problems).toEqual([])

    const summary = JSON.parse(result.value.summary_json)
    expect(summary.ref).toEqual({ pack_id: 'demo-pack', version: '0.1' })
    expect(summary.schema_ext_fields.problems).toContain('modality:enum[6]')
    expect(summary.schema_ext_fields.methods).toEqual(expect.arrayContaining(['paradigm:enum[11]', 'backbone:text']))
    expect(summary.schema_ext_fields.failures).toContain('failure_mode:enum[6]')
    expect(summary.schema_ext_fields.innovations).toEqual(expect.arrayContaining(['related_problem_ids:text', 'related_method_ids:text']))
    // 权重与阈值（含 keyword_only 的标定值）
    expect(summary.dimensions).toEqual({ novelty_problem: 30, novelty_method: 25 + 5, novelty_combo: 25, feasibility: 15 })
    expect(summary.thresholds.keyword_only.near_duplicate_similarity).toBe(0.3)

    const provenance = JSON.parse(result.value.provenance_json)
    expect(provenance.extractions).toBe(2)
    expect(provenance.included_benchmarks.join(' ')).toMatch(/FaceForensics\+\+\(4\)/) // 'FaceForensics++ (FF++)' 与 'FF++' 归一后合并计数
    expect(provenance.included_benchmarks.join(' ')).toMatch(/Celeb-DF\(2\)/) // 'Celeb-DF-v2' 归一
    expect(provenance.top_metrics.join(' ')).toMatch(/AUC\(4\)/) // AUC + AUROC 归一
    expect(result.value.draft_path).toContain('demo-pack-0.1.draft.json')
  })

  it('派生是确定性的：同输入两次派生，除时间戳外完全一致', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const first = JSON.parse(await readFile(join(env.packDir, 'demo-pack-0.1.draft.json'), 'utf8'))
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const second = JSON.parse(await readFile(join(env.packDir, 'demo-pack-0.1.draft.json'), 'utf8'))
    delete first.generated_at
    delete second.generated_at
    expect(second).toEqual(first)
  })

  it('freeze：空签名被拒（人工评审不可豁免）', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const result = await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '   ' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/reviewer 不可为空/)
    expect(env.kb.listDomainPacks()).toHaveLength(0)
  })

  it('freeze：契约校验不通过（档位不连续）→ 拒绝冻结', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const path = join(env.packDir, 'demo-pack-0.1.draft.json')
    const draft = JSON.parse(await readFile(path, 'utf8'))
    draft.scoring.suggestion_bands = { proceed: [80, 100], revise: [50, 74], abandon: [0, 49] } // 74→80 有缝
    await writeFile(path, JSON.stringify(draft))

    const result = await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/契约校验未通过/)
    expect(JSON.stringify(result.content)).toMatch(/不连续/)
    expect(env.kb.listDomainPacks()).toHaveLength(0)
  })

  it('freeze：签名 → 落盘 + 注册 + 内容哈希；同版本再冻被拒（改 pack 必须升版本）', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const frozen = await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠', bind: true })
    expect(frozen.isError).toBe(false)
    expect(frozen.value.frozen_by).toBe('周润楠')
    expect(frozen.value.content_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(frozen.value.pack_ref).toBe('demo-pack@0.1')
    expect(frozen.value.bound_project).toBe('proj-test')

    // 注册表 + 绑定都真实落了
    expect(env.kb.listDomainPacks()).toHaveLength(1)
    expect(env.kb.getProjectPackBinding('proj-test')).toEqual({ pack_id: 'demo-pack', version: '0.1' })

    // 冻结产物里**没有**生成过程元数据（provenance/generated_at 不进契约）
    const frozenJson = JSON.parse(await readFile(join(env.packDir, 'demo-pack-0.1.json'), 'utf8'))
    expect(frozenJson.provenance).toBeUndefined()
    expect(Object.keys(frozenJson).sort()).toEqual(['benchmarks', 'frozen_at', 'frozen_by', 'lexicon', 'ref', 'schema_ext', 'scoring', 'seed_papers'])

    const again = await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠' })
    expect(again.isError).toBe(true)
    expect(JSON.stringify(again.content)).toMatch(/已冻结/)
    expect(JSON.stringify(again.content)).toMatch(/propose_revision/)
  })

  it('freeze：没有草案时明确报错（不许冻一个想象中的 pack）', async () => {
    env = await makeEnv()
    const result = await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/找不到草案/)
  })

  it('propose_revision：派生新版本 + 差异摘要（含新增字段/基准/权重变化）', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠' })

    // 知识库变化：新条目带来新 ext 字段 + 新 benchmark
    env.kb.upsertEntry('methods', '音频分支：AASIST 主干', ['10.1/a'], { 'demo-pack': { modality: 'audio', paradigm: 'audio_visual' } })
    env.kb.listExtractions() // no-op，保持接口形状清晰
    const extractions = env.kb.listExtractions()
    void extractions

    const result = await env.execute(DOMAIN_TOOLS.proposeRevision, { notes: '并入音频分支' })
    expect(result.isError).toBe(false)
    expect(result.value.base_version).toBe('0.1')
    expect(result.value.new_version).toBe('0.2')
    expect(result.value.change_count).toBe(result.value.changes.length)

    // 0.2 草案可独立冻结（旧版本不受影响）
    const frozen2 = await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠', version: '0.2' })
    expect(frozen2.isError).toBe(false)
    expect(env.kb.listDomainPacks().map((pack) => pack.version).sort()).toEqual(['0.1', '0.2'])
  })

  it('propose_revision：没有任何已冻结版本时报错并指路', async () => {
    env = await makeEnv()
    const result = await env.execute(DOMAIN_TOOLS.proposeRevision, {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/还没有任何已冻结版本/)
  })

  it('bind：只接受已冻结版本；换绑会回传旧绑定', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠', version: '0.1' })
    await env.execute(DOMAIN_TOOLS.bootstrap, { version: '0.2' })
    await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '周润楠', version: '0.2' })

    const first = await env.execute(DOMAIN_TOOLS.bind, { version: '0.1' })
    expect(first.value.pack_ref).toBe('demo-pack@0.1')
    expect(first.value.previous_binding).toBe('')

    const second = await env.execute(DOMAIN_TOOLS.bind, { version: '0.2' })
    expect(second.value.previous_binding).toBe('demo-pack@0.1')
    expect(env.kb.getProjectPackBinding('proj-test')).toEqual({ pack_id: 'demo-pack', version: '0.2' })

    const unknown = await env.execute(DOMAIN_TOOLS.bind, { version: '9.9' })
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown.content)).toMatch(/只接受已冻结版本|找不到已冻结/)
  })

  it('bind：未冻结的草案版本不可绑定（草案不是权威）', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, { version: '0.3' }) // 只有草案
    const result = await env.execute(DOMAIN_TOOLS.bind, { version: '0.3' })
    expect(result.isError).toBe(true)
  })

  it('bootstrap 的 provenance 记录被排除的非深伪数据集（评审人要能看到取舍）', async () => {
    env = await makeEnv()
    // 造一条把 ImageNet 当 benchmark 的提取（来自主干网络论文的常见噪声）
    kbAddImageNet(env)
    const result = await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const provenance = JSON.parse(result.value.provenance_json)
    expect(provenance.excluded_non_deepfake_benchmarks.join(' ')).toMatch(/ImageNet/)
  })

  /**
   * provenance 必须**落到草案文件里**，不能只在工具返回值里。
   *
   * 起因（2026-09-17）：`scripts/review-pack.mjs` 读 `draft.provenance`，而
   * `bootstrap-pack.mjs` 与工具都只写 `draft` —— 于是评审视图在最后一段崩溃，
   * "为什么纳入/排除这些 benchmark"在生成后就再也看不到（§12.5 恰恰要求评审人看它）。
   * 工具返回值里那份 `provenance_json` 也救不了：它会随会话上下文一起被压缩掉。
   */
  it('provenance 与草案一起落盘（评审视图不依赖工具返回，也不依赖会话上下文）', async () => {
    env = await makeEnv()
    kbAddImageNet(env)
    const result = await env.execute(DOMAIN_TOOLS.bootstrap, {})
    const onDisk = JSON.parse(await readFile(String(result.value.draft_path), 'utf8'))

    expect(onDisk.provenance, '草案文件里必须有 provenance：评审发生在生成之后，可能隔天').toBeDefined()
    // §12.5 说的"两组全量"：纳入清单 + 排除清单，评审人要能对账
    expect(onDisk.provenance.included_benchmarks.length).toBeGreaterThan(0)
    expect(onDisk.provenance.excluded_non_deepfake_benchmarks.join(' ')).toMatch(/ImageNet/)
    expect(onDisk.provenance.all_benchmark_names.join(' ')).toMatch(/ImageNet/)
    // 已解析篇数（"这份 pack 建立在多少可读全文上"）
    expect(onDisk.provenance.parsed_papers).toBeGreaterThan(0)
  })

  it('冻结产物里**没有** provenance（它不属于 pack 契约）', async () => {
    env = await makeEnv()
    await env.execute(DOMAIN_TOOLS.bootstrap, {})
    await env.execute(DOMAIN_TOOLS.freeze, { reviewer: '评审人-A' })
    const frozen = JSON.parse(await readFile(join(env.packDir, 'demo-pack-0.1.json'), 'utf8'))
    expect(frozen.provenance, 'provenance 是派生的审计信息，不该进冻结契约').toBeUndefined()
    expect(frozen.ref).toMatchObject({ pack_id: 'demo-pack', version: '0.1' })
  })
})

/** 追加一条"通用视觉数据集"提取，验证排除逻辑在执行路径上也成立。 */
function kbAddImageNet(env) {
  env.kb.upsertPaper({
    paper_id: '10.1/c', title: 'Backbone paper', authors: [], source_channel: 'asta',
    pdf_status: 'downloaded', md_path: 'markdown/10.1/c/full.md', parse_channel: 'mineru',
    created_at: NOW, updated_at: NOW,
  })
  env.kb.saveExtraction({
    paper_id: '10.1/c',
    problem_statement: '通用主干表征',
    method_summary: 'ConvNet 主干',
    innovations: [],
    future_work: [],
    limitations: [],
    benchmarks: ['ImageNet-1K', 'COCO 2017', 'FaceForensics++ (FF++)'],
    metrics: ['Top-1 accuracy'],
    baseline_methods: ['Swin Transformer'],
    extraction_quality: 'full_text',
    extracted_at: NOW,
  })
}
