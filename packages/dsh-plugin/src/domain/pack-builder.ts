/**
 * Domain Pack 的构建与治理（P3-5）：派生草案 → 契约校验 → 冻结 → 版本对比。
 *
 * 为什么把它从脚本搬进插件：pack 的**生成**（`bootstrap-pack.mjs`）与**冻结**
 * （`freeze-pack.mjs`）原本是两条独立脚本流程，而 Phase 3 要把它们变成会话内工具
 * （`cvagent_domain_bootstrap/freeze/…`）。两套实现必然漂移——尤其"契约校验"
 * 那几十行规则（权重合计 100、档位连续、enum 必须有值…），一旦脚本与工具不一致，
 * 就会出现"脚本说能冻、工具说不能"这类最难查的问题。因此：**逻辑只写一份**，
 * 脚本与工具都调它。
 *
 * 数据来源：全部读 `KbService`（论文库 + 提取 + 四库条目），不再读
 * `data/papers/extractions/*.json`——DB 才是权威（文件是导入过程的中间产物）。
 */

import { createHash } from 'node:crypto'

import {
  freezeDomainPack,
  STORE_ID_PREFIX,
  STORE_NAMES,
  type ExtensionFieldSpec,
  type FrozenDomainPack,
  type StoreName,
} from '@cv-research/core'

import type { PaperExtraction } from '@cv-research/core'

import type { PaperDatabase } from '../kb/db.js'

/** 派生所需的输入（由 KbService 提供，保持本模块不依赖具体服务实现）。 */
export interface PackSource {
  readonly papers: readonly { paper_id: string; title: string; year: number | null; venue: string | null }[]
  readonly extractions: readonly PaperExtraction[]
  readonly entries: readonly { entry_id: string; store: StoreName; statement: string; ext: Record<string, Record<string, unknown>> }[]
  /**
   * 已解析全文的论文数（可选）。
   *
   * 为什么单列：审阅 pack 时要回答"这份 pack 是从多少可读全文里得出的"——
   * 只报论文总数会把"243 篇只有元数据"的库说成"素材很足"。缺省时溯源里不写这个数
   * （而不是写 0：0 会被读成"一篇都没解析"）。
   */
  readonly parsedPapers?: number
}

/** 派生结果：草案 + 溯源统计。 */
export interface DerivedDraft {
  readonly draft: Record<string, unknown>
  readonly provenance: Record<string, unknown>
}

/** 派生选项。 */
export interface DeriveOptions {
  readonly packId: string
  readonly version: string
  readonly generatedBy: string
  /**
   * ext 里的**包键**。缺省等于 `packId`——这是本项目的约定：条目 ext 按
   * `{ [pack_id]: {…} }` 命名空间隔离（勘误 §7.5.2）。
   *
   * ⚠️ 它必须是参数而不是常量：写死的话，一旦 pack_id 与命名空间不同（多领域包
   * 并存、或测试用别的 pack id），派生的 schema_ext 就会**静默变成空的**——
   * 表面看是"这个领域没有扩展字段"，实际是读错了键。
   */
  readonly packNamespace?: string
}

/**
 * 显式声明的扩展字段：语料里可能还没人填，但 pack 必须允许（甚至鼓励）填写。
 *
 * 教训：只按"实测出现过"生成 schema_ext，会把设计上必需的字段漏掉——
 * `revisit_when` 就是这样消失的（67 条失败种子里全部留空，因为它需要判断）。
 */
const DECLARED_FIELDS: Record<string, Record<string, ExtensionFieldSpec>> = {
  innovations: {
    related_problem_ids: { type: 'text', extraction_hint: '字符串数组：该创新针对的 problems 条目 ID（如 ["P002"]）。' },
    related_method_ids: { type: 'text', extraction_hint: '字符串数组：该创新所属的 methods 条目 ID（如 ["M015"]）。' },
  },
  failures: {
    revisit_when: { type: 'text', extraction_hint: '什么条件下值得再试这条失败做法。**这是判断字段，不要机械填充**；留空表示"尚无人评估过复现条件"。' },
  },
}

/** 枚举字段的标准取值：语料实测值之外必须允许的规范词表（统一 snake_case）。 */
const STANDARD_ENUM_VALUES: Record<string, string[]> = {
  modality: ['image', 'video', 'visual', 'audio', 'audio_visual', 'other'],
  detection_target: ['entire_synthesis', 'face_swap', 'face_reenactment', 'attribute_manipulation', 'partial_region', 'audio_speech', 'other'],
  paradigm: ['frequency', 'spatial', 'hybrid', 'clip_foundation', 'reconstruction', 'proactive', 'temporal', 'audio_visual', 'continual', 'ensemble', 'other'],
  training_strategy: ['supervised', 'self_supervised', 'semi_supervised', 'adversarial', 'meta_learning', 'knowledge_distillation', 'other'],
  generalization_target: ['in_dataset', 'cross_dataset', 'cross_manipulation', 'cross_model', 'none'],
  innovation_type: ['new_method', 'new_framework', 'new_loss', 'new_dataset', 'new_benchmark', 'new_insight', 'other'],
  failure_mode: ['method_invalid', 'data_issue', 'metric_not_improved', 'resource_infeasible', 'reproducibility', 'other'],
}

/** 与 pack 无关的字段：条目间引用由 link-entry-ids 机械维护，不属领域扩展。 */
const RELATION_FIELDS = new Set(['related_problem_ids', 'related_method_ids'])

/** 数据集别名归一（语料里同一数据集的多种写法）。 */
const BENCHMARK_CANONICAL: { canonical: string; aliases: RegExp[] }[] = [
  { canonical: 'FaceForensics++', aliases: [/^faceforensics\+\+/i, /^ff\+\+/i, /^faceforensics \+\+/i] },
  { canonical: 'Celeb-DF', aliases: [/^celeb-?df/i, /^celebdf/i] },
  { canonical: 'DFDC', aliases: [/^dfdc$/i, /^deepfake detection challenge/i] },
  { canonical: 'DFDC Preview', aliases: [/^dfdcp$/i, /^dfdc preview/i, /dfdc-?preview/i] },
  { canonical: 'DeeperForensics-1.0', aliases: [/^deeperforensics/i, /^df1\.0$/i] },
  { canonical: 'FFIW-10K', aliases: [/^ffiw/i] },
  { canonical: 'DF40', aliases: [/^df40/i] },
  { canonical: 'WildDeepfake', aliases: [/^wild-?deepfake/i] },
  { canonical: 'FakeAVCeleb', aliases: [/^fakeavceleb/i] },
  { canonical: 'KoDF', aliases: [/^kodf$/i] },
  { canonical: 'LAV-DF', aliases: [/^lav-?df$/i] },
  { canonical: 'AV-Deepfake1M', aliases: [/^av-?deepfake1m/i, /^avdf1m$/i] },
  { canonical: 'GenImage', aliases: [/^genimage/i] },
  { canonical: 'ForenSynths', aliases: [/^forensynths/i] },
  { canonical: 'DFD', aliases: [/^dfd$/i, /^deepfakedetection$/i] },
  { canonical: 'UADFV', aliases: [/^uadfv/i] },
  { canonical: 'DiffusionForensics', aliases: [/^diffusionforensics/i] },
  { canonical: 'UniversalFakeDetect', aliases: [/^universalfakedetect/i] },
  { canonical: 'ASVspoof', aliases: [/^asvspoof/i] },
]

/** 通用视觉数据集 / 预训练语料不进 pack（它们不是深伪检测 benchmark）。 */
const NOT_A_DEEPFAKE_BENCHMARK = [/^imagenet/i, /^coco/i, /^ade20k/i, /^lrs2/i, /^lrs3/i, /^voxceleb/i, /^lcs-558k/i]

/** 指标同义词归一。 */
const METRIC_CANONICAL: { canonical: string; aliases: RegExp[] }[] = [
  { canonical: 'AUC', aliases: [/^auroc$/i, /^auc$/i, /^frame-?level auc$/i, /^video-?level auc$/i] },
  { canonical: 'ACC', aliases: [/^acc$/i, /^accuracy$/i, /^top-?1 accuracy$/i] },
  { canonical: 'AP', aliases: [/^ap$/i, /^average precision/i, /^ap@/i] },
  { canonical: 'EER', aliases: [/^eer$/i] },
  { canonical: 'F1', aliases: [/^f1(-score)?$/i] },
]

/** 规范术语与检索改写组（领域相关的都在 pack 里，代码不写领域字面量的规则在此例外：这是 pack 的**内容**）。 */
const LEXICON = {
  terms: [
    { canonical: 'face_swap', aliases: ['faceswap', 'face swap', 'deepfakes', 'deep fake', 'identity swap', 'inswap', 'blendface'] },
    { canonical: 'face_reenactment', aliases: ['face2face', 'reenactment', 'neuraltextures', 'expression manipulation', 'talking head'] },
    { canonical: 'entire_synthesis', aliases: ['entire face synthesis', 'fully synthetic', 'gan-generated', 'diffusion-generated', 't2i', 'text-to-image', 't2v', 'text-to-video', 'stylegan'] },
    { canonical: 'attribute_manipulation', aliases: ['attribute editing', 'facial attribute', 'gan editing', 'makeup transfer'] },
    { canonical: 'audio_deepfake', aliases: ['audio deepfake', 'voice deepfake', 'speech spoofing', 'audio spoofing', 'voice conversion', 'tts', 'asvspoof', 'anti-spoofing'] },
    { canonical: 'audio_visual_deepfake', aliases: ['audio-visual deepfake', 'multimodal deepfake', 'lip sync', 'av deepfake'] },
    { canonical: 'partial_manipulation', aliases: ['partial deepfake', 'local manipulation', 'temporal localization', 'forgery localization', 'temporal forgery'] },
    { canonical: 'frequency_artifact', aliases: ['frequency domain', 'dct', 'fft', 'wavelet', 'high-frequency', 'spectral artifact'] },
    { canonical: 'blending_boundary', aliases: ['blending artifact', 'boundary artifact', 'face x-ray', 'sbi', 'self-blended images'] },
    { canonical: 'foundation_model_detector', aliases: ['clip-based', 'vision-language', 'vlm', 'foundation model', 'adapter', 'parameter-efficient', 'lora', 'prompt tuning'] },
    { canonical: 'generalization', aliases: ['cross-dataset', 'cross-manipulation', 'cross-model', 'unseen forgery', 'domain shift'] },
    { canonical: 'continual_learning', aliases: ['incremental learning', 'catastrophic forgetting', 'lifelong learning', 'continual detection'] },
    { canonical: 'proactive_defense', aliases: ['watermarking', 'proactive forensics', 'identity cloaking', 'anti-deepfake', 'adversarial perturbation'] },
    { canonical: 'explainability', aliases: ['interpretable', 'explainable', 'reasoning', 'vqa', 'text explanation', 'human-readable'] },
    { canonical: 'fairness', aliases: ['bias', 'demographic bias', 'fairness', 'attribute bias', 'unbiased'] },
  ],
  query_expansion: [
    ['deepfake detection', 'face forgery detection', 'face manipulation detection', 'synthetic face detection'],
    ['generalization', 'cross-dataset', 'cross-manipulation', 'unseen manipulation', 'robustness'],
    ['frequency', 'spectral', 'wavelet', 'DCT', 'high-frequency artifact'],
    ['CLIP', 'vision-language model', 'foundation model', 'parameter-efficient tuning', 'adapter'],
    ['audio deepfake', 'voice spoofing', 'speech anti-spoofing', 'ASVspoof'],
    ['explainable', 'interpretable', 'localization', 'forensic reasoning'],
    ['continual', 'incremental', 'catastrophic forgetting', 'lifelong'],
    ['proactive', 'watermark', 'adversarial protection', 'identity cloaking'],
  ],
}

/** keyword_only 模式的阈值：来自真实语料标定（scripts/calibrate-similarity2.mjs）。 */
const KEYWORD_ONLY_THRESHOLDS = { related_similarity: 0.1, near_duplicate_similarity: 0.3, boundary_band: [0.1, 0.3] }

/**
 * 从知识库派生 pack 草案（确定性；同样的输入必得同样的草案）。
 */
export function derivePackDraft(source: PackSource, options: DeriveOptions): DerivedDraft {
  // ext 的包键：缺省等于 pack_id（本项目约定），可由调用方覆盖（多领域包/测试）
  const namespace = options.packNamespace ?? options.packId
  // ── schema_ext：从条目 ext 的真实用法反推字段与枚举 ──────────────────────
  const extInventory = new Map<StoreName, Map<string, unknown[]>>()
  for (const store of STORE_NAMES) extInventory.set(store, new Map())
  for (const entry of source.entries) {
    const bucket = extInventory.get(entry.store)
    if (bucket === undefined) continue
    const pack = entry.ext?.[namespace]
    if (pack === undefined || pack === null || typeof pack !== 'object') continue
    for (const [field, value] of Object.entries(pack)) {
      if (RELATION_FIELDS.has(field)) continue
      const list = bucket.get(field) ?? []
      list.push(value)
      bucket.set(field, list)
    }
  }

  const schemaExt: Record<string, Record<string, ExtensionFieldSpec>> = {}
  for (const store of STORE_NAMES) {
    const fields: Record<string, ExtensionFieldSpec> = { ...(DECLARED_FIELDS[store] ?? {}) }
    for (const [field, values] of extInventory.get(store) ?? []) {
      if (fields[field] !== undefined) continue
      const flat = values.flatMap((value) => (Array.isArray(value) ? value : [value]))
      const allArrays = values.every((value) => Array.isArray(value) && value.every((item) => typeof item === 'string'))
      if (allArrays) {
        fields[field] = { type: 'text', extraction_hint: `字符串数组（列举，非自由描述）。实测样例：${flat.slice(0, 3).join(' / ')}` }
        continue
      }
      const strings = flat.filter((value): value is string => typeof value === 'string')
      const allStrings = strings.length === flat.length
      if (!allStrings) {
        fields[field] = { type: 'text', extraction_hint: `取值自由；实测样例：${JSON.stringify(flat.slice(0, 2))}` }
        continue
      }
      const observed = [...new Set(strings.map((value) => value.replace(/-/g, '_')))].sort()
      /**
       * 固化 enum 的判据（**保守**）：
       * - 该字段在 `STANDARD_ENUM_VALUES` 里有规范词表 → 直接 enum（这是明确的知识）；
       * - 否则要求**至少 3 个不同取值**且都短（≤40 字符）且不超过 12 个。
       *
       * 为什么不能只看"取值少"：自由文本字段在语料里可能只出现 1–2 个值
       * （如 `backbone` 恰好全是 `CLIP`），按"少即枚举"会把它固化成 `enum[1]`，
       * 之后 Analyst 填别的骨干名就会被判非法。**枚举是约束，不能从一两个样本发明**。
       */
      const standard = STANDARD_ENUM_VALUES[field] ?? []
      const looksLikeEnum = standard.length > 0
        || (observed.length >= 3 && observed.length <= 12 && observed.every((value) => value.length <= 40))
      fields[field] = looksLikeEnum
        ? {
            type: 'enum',
            values: [...new Set([...standard, ...observed])].sort(),
            extraction_hint: `取值必须是下列之一（snake_case；语料实测已出现：${observed.join(' / ') || '无'}）`,
          }
        : { type: 'text', extraction_hint: `自由文本（描述性）。实测样例：${observed.slice(0, 2).join(' / ')}` }
    }
    schemaExt[store] = fields
  }

  // ── benchmarks / metrics：从提取里数频次并归一 ──────────────────────────
  const benchmarkCount = new Map<string, number>()
  const metricCount = new Map<string, number>()
  const baselineCount = new Map<string, number>()
  for (const extraction of source.extractions) {
    for (const name of extraction.benchmarks) benchmarkCount.set(name, (benchmarkCount.get(name) ?? 0) + 1)
    for (const name of extraction.metrics) metricCount.set(name, (metricCount.get(name) ?? 0) + 1)
    for (const name of extraction.baseline_methods) baselineCount.set(name, (baselineCount.get(name) ?? 0) + 1)
  }

  const stripParen = (name: string): string => name.trim().replace(/\s*[（(][^)）]*[)）]\s*$/, '')
  const canonicalize = (counts: Map<string, number>, table: { canonical: string; aliases: RegExp[] }[]): Map<string, number> => {
    const out = new Map<string, number>()
    for (const [name, count] of counts) {
      const bare = stripParen(name)
      const hit = table.find((entry) => entry.aliases.some((pattern) => pattern.test(bare)))
      const key = hit?.canonical ?? bare
      out.set(key, (out.get(key) ?? 0) + count)
    }
    return out
  }

  const allBenchmarks = canonicalize(benchmarkCount, BENCHMARK_CANONICAL)
  const recognized = new Set(BENCHMARK_CANONICAL.map((entry) => entry.canonical))
  const excludedBenchmarks = new Map<string, number>()
  const includedBenchmarks = new Map<string, number>()
  for (const [name, count] of allBenchmarks) {
    if (NOT_A_DEEPFAKE_BENCHMARK.some((pattern) => pattern.test(name))) excludedBenchmarks.set(name, count)
    // 识别出的规范数据集一律纳入（哪怕只出现 1 次）；自由文本名要求 ≥2 篇
    else if (recognized.has(name) || count >= 2) includedBenchmarks.set(name, count)
  }
  const metrics = canonicalize(metricCount, METRIC_CANONICAL)
  const rank = (map: Map<string, number>, min: number): [string, number][] =>
    [...map.entries()].filter(([, count]) => count >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const draft = {
    ref: { pack_id: options.packId, version: options.version },
    generated_at: new Date().toISOString(),
    generated_by: options.generatedBy,
    seed_papers: source.extractions.slice(0, 20).map((extraction) => extraction.paper_id),
    schema_ext: schemaExt,
    lexicon: LEXICON,
    benchmarks: {
      benchmarks: rank(includedBenchmarks, 1).map(([name, count]) => ({
        name,
        ...(count >= 3 ? { metric_protocol: '见各论文报告口径（AUC/ACC 为主，视频级另有 AP/PD@FAR）' } : {}),
      })),
      metrics: rank(metrics, 2).map(([name]) => name),
      required_protocols: [
        { name: 'in_domain', description: '同数据集内训练与测试（FF++ c23/c40 最常见）' },
        { name: 'cross_dataset', description: '单数据集训练、其它数据集测试——本领域泛化结论的主口径' },
        { name: 'cross_manipulation', description: '同数据集内跨伪造类型（DF/FS/F2F/NT）泛化' },
        { name: 'cross_model', description: '跨生成模型（GAN ↔ 扩散、未见生成器）泛化' },
      ],
    },
    scoring: {
      dimensions: { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 },
      // ⚠️ 阈值按模式区分：余弦口径的 0.85 套到 trigram 会严重漏判（勘误 §11.5）
      thresholds: { high_risk_similarity: 0.85, topk: 10, keyword_only: KEYWORD_ONLY_THRESHOLDS },
      suggestion_bands: { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] },
    },
  }

  const provenance = {
    papers: source.papers.length,
    ...(source.parsedPapers === undefined ? {} : { parsed_papers: source.parsedPapers }),
    extractions: source.extractions.length,
    entries: Object.fromEntries(STORE_NAMES.map((store) => [store, source.entries.filter((entry) => entry.store === store).length])),
    observed_ext_fields: Object.fromEntries([...extInventory.entries()].map(([store, fields]) => [store, [...fields.keys()]])),
    included_benchmarks: [...includedBenchmarks.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}(${count})`),
    excluded_non_deepfake_benchmarks: [...excludedBenchmarks.entries()].map(([name, count]) => `${name}(${count})`),
    /**
     * **全量** benchmark 名（含只出现一次的自由文本名）。
     *
     * 与 `included_benchmarks` 的区别是审阅的关键：纳入表只列"够格进 pack"的，
     * 而评审要问的是"有没有该进没进的"——那需要看见全部观测值。
     */
    all_benchmark_names: [...allBenchmarks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => `${name}(${count})`),
    top_metrics: rank(metrics, 2).map(([name, count]) => `${name}(${count})`),
    top_baselines: rank(baselineCount, 4).map(([name, count]) => `${name}(${count})`),
  }

  return { draft, provenance }
}

/** 校验结果。 */
export interface DraftValidation {
  readonly problems: readonly string[]
  readonly notes: readonly string[]
}

/**
 * 契约校验（冻结前的最后一道闸）：字段类型 / enum 必须有值 / 权重合计 100 /
 * 档位连续且覆盖 0–100 / 各段非空。规则与 `scripts/freeze-pack.mjs` 同源。
 */
export function validatePackDraft(draft: Record<string, unknown>): DraftValidation {
  const problems: string[] = []
  const notes: string[] = []
  const ref = draft.ref as { pack_id?: unknown; version?: unknown } | undefined
  if (typeof ref?.pack_id !== 'string' || ref.pack_id === '') problems.push('ref.pack_id 缺失')
  if (typeof ref?.version !== 'string' || ref.version === '') problems.push('ref.version 缺失')

  const seedPapers = draft.seed_papers as unknown
  if (!Array.isArray(seedPapers) || seedPapers.length === 0) problems.push('seed_papers 为空（pack 必须可溯源到种子论文）')

  const schemaExt = draft.schema_ext as Record<string, Record<string, ExtensionFieldSpec>> | undefined
  for (const store of STORE_NAMES) {
    const fields = schemaExt?.[store]
    if (fields === undefined || typeof fields !== 'object') {
      problems.push(`schema_ext.${store} 缺失`)
      continue
    }
    for (const [field, spec] of Object.entries(fields)) {
      if (!['text', 'enum', 'number', 'boolean'].includes(spec?.type)) {
        problems.push(`schema_ext.${store}.${field}.type 非法：${spec?.type}`)
      }
      if (spec?.type === 'enum' && (!Array.isArray(spec.values) || spec.values.length === 0)) {
        problems.push(`schema_ext.${store}.${field} 是 enum 但没有 values`)
      }
    }
  }

  const lexicon = draft.lexicon as { terms?: unknown; query_expansion?: unknown } | undefined
  if (!Array.isArray(lexicon?.terms) || lexicon.terms.length === 0) problems.push('lexicon.terms 为空')
  for (const term of (lexicon?.terms ?? []) as { canonical?: unknown; aliases?: unknown }[]) {
    if (typeof term.canonical !== 'string' || !Array.isArray(term.aliases)) {
      problems.push(`lexicon 词条形态非法：${JSON.stringify(term).slice(0, 60)}`)
    }
  }
  if (!Array.isArray(lexicon?.query_expansion) || lexicon.query_expansion.length === 0) problems.push('lexicon.query_expansion 为空')

  const benchmarks = draft.benchmarks as { benchmarks?: unknown; metrics?: unknown; required_protocols?: unknown } | undefined
  if (!Array.isArray(benchmarks?.benchmarks) || benchmarks.benchmarks.length === 0) problems.push('benchmarks.benchmarks 为空')
  if (!Array.isArray(benchmarks?.metrics) || benchmarks.metrics.length === 0) problems.push('benchmarks.metrics 为空')
  if (!Array.isArray(benchmarks?.required_protocols) || benchmarks.required_protocols.length === 0) problems.push('benchmarks.required_protocols 为空')

  const scoring = draft.scoring as {
    dimensions?: Record<string, number>
    thresholds?: { high_risk_similarity?: unknown; topk?: unknown; keyword_only?: Record<string, unknown> }
    suggestion_bands?: Record<string, [number, number]>
  } | undefined
  const dimensions = scoring?.dimensions ?? {}
  const weightSum = Object.values(dimensions).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
  if (weightSum !== 100) problems.push(`scoring.dimensions 权重之和应为 100，实测 ${weightSum}`)
  for (const key of ['novelty_problem', 'novelty_method', 'novelty_combo', 'feasibility']) {
    if (typeof dimensions[key] !== 'number') problems.push(`scoring.dimensions.${key} 缺失或非数字`)
  }
  if (typeof scoring?.thresholds?.high_risk_similarity !== 'number') problems.push('scoring.thresholds.high_risk_similarity 缺失')
  if (typeof scoring?.thresholds?.topk !== 'number') problems.push('scoring.thresholds.topk 缺失')
  const keywordOnly = scoring?.thresholds?.keyword_only
  if (keywordOnly === undefined) {
    notes.push('scoring.thresholds.keyword_only 缺失：keyword_only 模式的阈值会回落到余弦口径（会严重漏判撞车）')
  } else if (!Array.isArray(keywordOnly.boundary_band) || keywordOnly.boundary_band.length !== 2) {
    problems.push('scoring.thresholds.keyword_only.boundary_band 必须是 [min,max]')
  }

  const bands = scoring?.suggestion_bands ?? {}
  for (const key of ['proceed', 'revise', 'abandon'] as const) {
    const band = bands[key]
    if (!Array.isArray(band) || band.length !== 2 || band.some((value) => typeof value !== 'number')) {
      problems.push(`scoring.suggestion_bands.${key} 必须是 [min,max]`)
    }
  }
  const isBand = (value: unknown): value is [number, number] =>
    Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'number')
  const abandon = bands.abandon
  const revise = bands.revise
  const proceed = bands.proceed
  // 逐个收窄（`Array.prototype.every` 带类型谓词不会把元素收窄，TS 会一路报 possibly undefined）
  if (isBand(abandon) && isBand(revise) && isBand(proceed)) {
    if (abandon[0] !== 0) problems.push(`建议档位未从 0 开始（abandon 下界 ${abandon[0]}）`)
    if (proceed[1] !== 100) problems.push(`建议档位未到 100（proceed 上界 ${proceed[1]}）`)
    if (revise[0] !== abandon[1] + 1) problems.push(`建议档位不连续：${abandon} → ${revise}`)
    if (proceed[0] !== revise[1] + 1) problems.push(`建议档位不连续：${revise} → ${proceed}`)
  }
  return { problems, notes }
}

/** 冻结结果。 */
export interface FreezeOutcome {
  readonly frozen: FrozenDomainPack
  readonly contentHash: string
}

/**
 * 冻结：校验通过后才调用 core 的 `freezeDomainPack`（它在签名为空时抛错——
 * 类型级强制「空签名 = 跳过评审」）。
 *
 * 只保留契约字段：草案里的 `generated_at` / `generated_by` / `provenance`
 * 属于生成过程元数据，不进冻结产物（否则"改 pack 才升版本"的规则会被元数据噪声污染）。
 */
export function freezeDraft(draft: Record<string, unknown>, reviewer: string, now: string): FreezeOutcome {
  const validation = validatePackDraft(draft)
  if (validation.problems.length > 0) {
    throw new Error(`pack 契约校验未通过（${validation.problems.length} 条）：\n- ${validation.problems.join('\n- ')}`)
  }
  const contract = {
    ref: draft.ref,
    seed_papers: draft.seed_papers,
    schema_ext: draft.schema_ext,
    lexicon: draft.lexicon,
    benchmarks: draft.benchmarks,
    scoring: draft.scoring,
  } as unknown as Parameters<typeof freezeDomainPack>[0]
  const frozen = freezeDomainPack(contract, reviewer, now)
  const contentHash = createHash('sha256').update(JSON.stringify(frozen)).digest('hex').slice(0, 16)
  return { frozen, contentHash }
}

/** 两份 pack 的差异摘要（改版时必须让评审人看清"改了什么"）。 */
export function diffPacks(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const changes: string[] = []
  const prevSchema = (previous.schema_ext ?? {}) as Record<string, Record<string, unknown>>
  const nextSchema = (next.schema_ext ?? {}) as Record<string, Record<string, unknown>>
  for (const store of STORE_NAMES) {
    const prevFields = new Set(Object.keys(prevSchema[store] ?? {}))
    const nextFields = new Set(Object.keys(nextSchema[store] ?? {}))
    for (const field of nextFields) if (!prevFields.has(field)) changes.push(`schema_ext.${store} 新增字段 ${field}`)
    for (const field of prevFields) if (!nextFields.has(field)) changes.push(`schema_ext.${store} 删除字段 ${field}`)
    for (const field of nextFields) {
      if (!prevFields.has(field)) continue
      const a = JSON.stringify(prevSchema[store]?.[field])
      const b = JSON.stringify(nextSchema[store]?.[field])
      if (a !== b) changes.push(`schema_ext.${store}.${field} 定义变化`)
    }
  }
  const prevWeights = JSON.stringify((previous.scoring as { dimensions?: unknown })?.dimensions)
  const nextWeights = JSON.stringify((next.scoring as { dimensions?: unknown })?.dimensions)
  if (prevWeights !== nextWeights) changes.push(`scoring.dimensions 变化：${prevWeights} → ${nextWeights}`)

  const names = (pack: Record<string, unknown>): Set<string> =>
    new Set(((pack.benchmarks as { benchmarks?: { name: string }[] })?.benchmarks ?? []).map((item) => item.name))
  const prevNames = names(previous)
  const nextNames = names(next)
  for (const name of nextNames) if (!prevNames.has(name)) changes.push(`benchmarks 纳入 ${name}`)
  for (const name of prevNames) if (!nextNames.has(name)) changes.push(`benchmarks 移除 ${name}`)

  const countTerms = (pack: Record<string, unknown>): number =>
    ((pack.lexicon as { terms?: unknown[] })?.terms ?? []).length
  if (countTerms(previous) !== countTerms(next)) changes.push(`lexicon 术语数 ${countTerms(previous)} → ${countTerms(next)}`)
  return changes
}

/** 版本号自增（`0.1` → `0.2`）。 */
export function bumpVersion(version: string): string {
  const parts = version.split('.')
  const last = Number(parts[parts.length - 1])
  if (!Number.isFinite(last)) throw new Error(`版本号无法自增：${version}`)
  parts[parts.length - 1] = String(last + 1)
  return parts.join('.')
}

/**
 * 派生视图的**唯一 SQL 实现**（插件与 CLI 脚本共用）。
 *
 * 为什么放在这里：`cvagent_domain_bootstrap`（工具）与 `scripts/bootstrap-pack.mjs`
 * （CLI）都要读同样的三份数据。让脚本自己写 SQL 就是第二份实现——而两份实现
 * 迟早会在"读哪些列 / 怎么排序 / 怎么解析 JSON"上分叉，产出的 pack 也就不一致了。
 */
export function loadPaperRows(db: PaperDatabase): { paper_id: string; title: string; year: number | null; venue: string | null }[] {
  return db.raw
    .prepare('SELECT paper_id, title, year, venue FROM papers ORDER BY paper_id')
    .all() as unknown as { paper_id: string; title: string; year: number | null; venue: string | null }[]
}

/** 已解析全文的论文数（PackSource 的 `parsedPapers` 来源）。 */
export function loadParsedPaperCount(db: PaperDatabase): number {
  return (db.raw
    .prepare("SELECT COUNT(*) AS c FROM papers WHERE md_path IS NOT NULL AND md_path != ''")
    .get() as { c: number }).c
}

/** 有提取结果的 paper_id 列表（按 paper_id 排序，保证确定性）。 */export function loadExtractionIds(db: PaperDatabase): string[] {
  return db.raw
    .prepare('SELECT paper_id FROM paper_extractions ORDER BY paper_id')
    .all()
    .map((row) => (row as { paper_id: string }).paper_id)
}

/** 四库全部条目（含 store 与解析后的 ext）。 */
export function loadEntryRows(db: PaperDatabase): { entry_id: string; store: StoreName; statement: string; ext: Record<string, Record<string, unknown>> }[] {
  const out: { entry_id: string; store: StoreName; statement: string; ext: Record<string, Record<string, unknown>> }[] = []
  for (const store of STORE_NAMES) {
    const rows = db.raw
      .prepare(`SELECT entry_id, statement, ext FROM ${store} ORDER BY entry_id`)
      .all() as unknown as { entry_id: string; statement: string; ext: string }[]
    for (const row of rows) {
      out.push({ entry_id: row.entry_id, store, statement: row.statement, ext: JSON.parse(row.ext) as Record<string, Record<string, unknown>> })
    }
  }
  return out
}

/** 供工具层展示：草案的关键数字（避免把整份 pack 灌进模型上下文）。 */export function summarizeDraft(draft: Record<string, unknown>): Record<string, unknown> {
  const schemaExt = (draft.schema_ext ?? {}) as Record<string, Record<string, ExtensionFieldSpec>>
  const benchmarks = draft.benchmarks as { benchmarks?: unknown[]; metrics?: unknown[]; required_protocols?: unknown[] }
  const scoring = draft.scoring as { dimensions?: Record<string, number>; suggestion_bands?: unknown; thresholds?: unknown }
  const lexicon = draft.lexicon as { terms?: unknown[]; query_expansion?: unknown[] }
  return {
    ref: draft.ref,
    seed_papers: Array.isArray(draft.seed_papers) ? (draft.seed_papers as unknown[]).length : 0,
    schema_ext_fields: Object.fromEntries(
      STORE_NAMES.map((store) => [
        store,
        Object.entries(schemaExt[store] ?? {}).map(([field, spec]) => (spec.type === 'enum' ? `${field}:enum[${spec.values?.length ?? 0}]` : `${field}:${spec.type}`)),
      ]),
    ),
    benchmarks: benchmarks?.benchmarks?.length ?? 0,
    metrics: benchmarks?.metrics?.length ?? 0,
    protocols: benchmarks?.required_protocols?.length ?? 0,
    lexicon_terms: lexicon?.terms?.length ?? 0,
    query_expansion_groups: lexicon?.query_expansion?.length ?? 0,
    dimensions: scoring?.dimensions,
    suggestion_bands: scoring?.suggestion_bands,
    thresholds: scoring?.thresholds,
    store_prefixes: STORE_ID_PREFIX,
  }
}
