/**
 * P3-2 · Domain Pack 草案生成（bootstrap）。
 *
 * 依据 v1.2 §3.4 / §18 与 `core/src/domain/pack.ts` 的契约：pack 承载一切
 * 「随细分领域变化」的东西——扩展字段、术语词典、benchmark 清单、打分权重。
 *
 * **本脚本只生成草案，不冻结**：冻结必须带人工评审签名（`freezeDomainPack`），
 * 且签名为空会直接抛错。草案里的每一条都**从数据库实测派生**，不靠手写：
 *
 *   - `schema_ext`   ← 104 条三库条目里**真实用过的** ext 字段（含取值分布，
 *                      据此判定 enum / text 并固化 enum 取值）
 *   - `benchmarks`   ← 21 篇 Reader 提取里出现的数据集与指标**频次**
 *   - `lexicon`      ← 领域规范术语 + 同义词/缩写 + 检索改写组（人工可再订正）
 *   - `scoring`      ← v1.2 §18.4 的 Deepfake 默认权重 30/30/25/15
 *
 * 用法：node scripts/bootstrap-pack.mjs [--out data/packs/deepfake-detection-0.1.draft.json]
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex >= 0 && args[outIndex + 1] !== undefined
  ? args[outIndex + 1]
  : 'data/packs/deepfake-detection-0.1.draft.json'
const PACK_ID = 'deepfake-detection'
const VERSION = '0.1'

const db = new PaperDatabase('data/papers/metadata.db')

// ── 1. schema_ext：从真实 ext 用法反推字段与枚举 ───────────────────────────
const STORES = ['problems', 'methods', 'innovations']
/** 与三库关系字段同名的字段不进 schema_ext（它们是**条目间引用**，不是领域扩展）。 */
const RELATION_FIELDS = new Set(['related_problem_ids', 'related_method_ids'])
/**
 * 枚举字段的**标准取值**：语料实测值之外必须允许的规范词表。
 * 只按实测值固化会把「没人填过但显然该允许」的值挡在外面（例如 modality 的 image/audio）。
 * 同时统一到 snake_case——语料里出现过 'cross-dataset'，规范形态是 'cross_dataset'，
 * 读取侧（load-entries 校验）对两种写法都放行。
 */
const STANDARD_ENUM_VALUES = {
  modality: ['image', 'video', 'visual', 'audio', 'audio_visual', 'other'],
  detection_target: ['entire_synthesis', 'face_swap', 'face_reenactment', 'attribute_manipulation', 'partial_region', 'audio_speech', 'other'],
  paradigm: ['frequency', 'spatial', 'hybrid', 'clip_foundation', 'reconstruction', 'proactive', 'temporal', 'audio_visual', 'continual', 'ensemble', 'other'],
  training_strategy: ['supervised', 'self_supervised', 'semi_supervised', 'adversarial', 'meta_learning', 'knowledge_distillation', 'other'],
  generalization_target: ['in_dataset', 'cross_dataset', 'cross_manipulation', 'cross_model', 'none'],
  innovation_type: ['new_method', 'new_framework', 'new_loss', 'new_dataset', 'new_benchmark', 'new_insight', 'other'],
}
const extInventory = {}
for (const store of STORES) {
  const rows = db.raw.prepare(`SELECT ext FROM ${store}`).all()
  const fieldValues = new Map()
  for (const row of rows) {
    const pack = JSON.parse(row.ext)?.[PACK_ID]
    if (pack === undefined || pack === null || typeof pack !== 'object') continue
    for (const [field, value] of Object.entries(pack)) {
      if (RELATION_FIELDS.has(field)) continue
      if (!fieldValues.has(field)) fieldValues.set(field, [])
      fieldValues.get(field).push(value)
    }
  }
  extInventory[store] = fieldValues
}

const schemaExt = {}
for (const store of STORES) {
  const fields = {}
  for (const [field, values] of extInventory[store]) {
    const flat = values.flatMap((value) => (Array.isArray(value) ? value : [value]))
    const distinct = [...new Set(flat.filter((value) => typeof value === 'string'))]
    const allStrings = flat.every((value) => typeof value === 'string')
    const allArrays = values.every((value) => Array.isArray(value))
    if (allArrays && values.every((value) => value.every((item) => typeof item === 'string'))) {
      fields[field] = { type: 'text', extraction_hint: `字符串数组（列举，非自由描述）。实测样例：${flat.slice(0, 3).join(' / ')}` }
      continue
    }
    if (!allStrings) {
      fields[field] = { type: 'text', extraction_hint: '取值自由；实测样例：' + JSON.stringify(flat.slice(0, 2)) }
      continue
    }
    // 字符串字段：取值数少 → 固化为 enum；取值多且长 → text
    const looksLikeEnum = distinct.length <= 12 && distinct.every((value) => value.length <= 40)
    if (looksLikeEnum) {
      // 枚举是**规范性**的（不是描述性的）：统一成 snake_case，并补上本领域的
      // 标准取值——语料里没出现过 ≠ 不该允许（例如 modality 目前只有 visual/
      // audio_visual，但 image/video/audio 显然要能填）
      const standard = STANDARD_ENUM_VALUES[field] ?? []
      const observed = distinct.map((value) => value.replace(/-/g, '_'))
      const values = [...new Set([...standard, ...observed])].sort()
      fields[field] = {
        type: 'enum',
        values,
        extraction_hint: `取值必须是下列之一（snake_case；语料实测已出现：${observed.sort().join(' / ') || '无'}）`,
      }
    } else {
      fields[field] = {
        type: 'text',
        extraction_hint: `自由文本（描述性）。实测样例：${distinct.slice(0, 2).join(' / ')}`,
      }
    }
  }
  schemaExt[store] = fields
}

// ── 2. benchmarks：从 Reader 提取里数频次 ──────────────────────────────────
const extractionDir = 'data/papers/extractions'
const files = (await readdir(extractionDir)).filter((file) => file.endsWith('.json'))
const benchmarkCount = new Map()
const metricCount = new Map()
const baselineCount = new Map()
for (const file of files) {
  const extraction = JSON.parse(await readFile(`${extractionDir}/${file}`, 'utf8'))
  for (const name of extraction.benchmarks ?? []) benchmarkCount.set(name, (benchmarkCount.get(name) ?? 0) + 1)
  for (const name of extraction.metrics ?? []) metricCount.set(name, (metricCount.get(name) ?? 0) + 1)
  for (const name of extraction.baseline_methods ?? []) baselineCount.set(name, (baselineCount.get(name) ?? 0) + 1)
}
const rank = (map, min = 2) => [...map.entries()]
  .filter(([, count]) => count >= min)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

/** 数据集名的归一化别名表：语料里同一数据集的多种写法合并计数。 */
const CANONICAL = [
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
  { canonical: 'DFD', aliases: [/^dfd$/i, /^deepfakedetection$/i, /^deepfake detection \(dfd\)/i] },
  { canonical: 'UADFV', aliases: [/^uadfv/i] },
  { canonical: 'DiffusionForensics', aliases: [/^diffusionforensics/i] },
  { canonical: 'UniversalFakeDetect', aliases: [/^universalfakedetect/i] },
  { canonical: 'ASVspoof', aliases: [/^asvspoof/i] },
]
/**
 * 通用视觉数据集**不进 pack**：它们来自语料里的主干网络论文（如 OverLoCK 的
 * ImageNet/COCO/ADE20K）或音视频论文的**预训练语料**（VoxCeleb2/LRS2——是训练集
 * 不是检测 benchmark），不是深伪检测 benchmark。留在清单里会污染「本领域用哪些
 * 数据集评测」这一判断。
 *
 * ⚠️ 不要把 ExDDV 之类**确实是深伪数据集**的名字放进来（曾误排除过一次）。
 */
const NOT_A_DEEPFAKE_BENCHMARK = [/^imagenet/i, /^coco/i, /^ade20k/i, /^lrs2/i, /^lrs3/i, /^voxceleb/i, /^lcs-558k/i]

/** 指标同义词归一：语料里 AUC/AUROC、ACC/Accuracy 混用。 */
const METRIC_CANONICAL = [
  { canonical: 'AUC', aliases: [/^auroc$/i, /^auc$/i, /^frame-?level auc$/i, /^video-?level auc$/i] },
  { canonical: 'ACC', aliases: [/^acc$/i, /^accuracy$/i, /^top-?1 accuracy$/i] },
  { canonical: 'AP', aliases: [/^ap$/i, /^average precision/i, /^ap@/i] },
  { canonical: 'EER', aliases: [/^eer$/i] },
  { canonical: 'F1', aliases: [/^f1(-score)?$/i] },
]

const canonicalBenchmarks = new Map()
const excludedBenchmarks = new Map()
const recognizedNames = new Set(CANONICAL.map((entry) => entry.canonical))
for (const [name, count] of benchmarkCount) {
  // 去掉尾随括号注释再匹配（'DeepFake Detection Challenge (DFDC)' 曾因此没并进 DFDC）
  const bare = name.trim().replace(/\s*[（(][^)）]*[)）]\s*$/, '')
  const hit = CANONICAL.find((entry) => entry.aliases.some((pattern) => pattern.test(bare)))
  const key = hit?.canonical ?? bare
  const target = NOT_A_DEEPFAKE_BENCHMARK.some((pattern) => pattern.test(key)) ? excludedBenchmarks : canonicalBenchmarks
  target.set(key, (target.get(key) ?? 0) + count)
}

/**
 * 纳入规则（而不是单一频次门槛）：
 * - **已识别的规范数据集一律纳入**——LAV-DF/AVDF1M/KoDF/FakeAVCeleb 这类音视频
 *   检测集在语料里各自只出现 1 次（本批只有 2 篇音视频论文），但它们是本领域
 *   标准 benchmark，按频次卡掉会让 pack 丢掉整个音频/音视频分支；
 * - 未识别的自由文本名需要 ≥2 篇提及（一次性出现的名字是噪声）。
 */
const includedBenchmarks = [...canonicalBenchmarks.entries()]
  .filter(([name, count]) => recognizedNames.has(name) || count >= 2)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

const canonicalMetrics = new Map()
for (const [name, count] of metricCount) {
  const bare = name.trim().replace(/\s*[（(][^)）]*[)）]\s*$/, '')
  const hit = METRIC_CANONICAL.find((entry) => entry.aliases.some((pattern) => pattern.test(bare)))
  const key = hit?.canonical ?? bare
  canonicalMetrics.set(key, (canonicalMetrics.get(key) ?? 0) + count)
}

const benchmarks = {
  // 数据集：见上文的纳入规则（识别名一律纳入，自由文本名 ≥2）
  benchmarks: includedBenchmarks.map(([name, count]) => ({
    name,
    ...(count >= 3 ? { metric_protocol: '见各论文报告口径（AUC/ACC 为主，视频级另有 AP/PD@FAR）' } : {}),
  })),
  metrics: rank(canonicalMetrics, 2).map(([name]) => name),
  required_protocols: [
    { name: 'in_domain', description: '同数据集内训练与测试（FF++ c23/c40 最常见）' },
    { name: 'cross_dataset', description: '单数据集训练、其它数据集测试——本领域泛化结论的主口径' },
    { name: 'cross_manipulation', description: '同数据集内跨伪造类型（DF/FS/F2F/NT）泛化' },
    { name: 'cross_model', description: '跨生成模型（GAN ↔ 扩散、未见生成器）泛化' },
  ],
}

// ── 3. lexicon：规范术语 + 同义词 + 检索改写组 ─────────────────────────────
const lexicon = {
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

// ── 4. scoring：Deepfake 默认权重（v1.2 §18.4）+ **按模式区分的阈值**─────────
// keyword_only 的三个值来自真实语料标定（scripts/calibrate-similarity2.mjs，
// 69 对「同内容被改写」正例 vs 69 对无关论文负例）：
//   ≥0.10 → 召回 62%、误报 1/69；≥0.30 → 召回 10%、误报 0/69（此档基本是同文）。
// 余弦口径的 0.85 直接套到 keyword 模式会严重漏判（实测负例最大仅 0.135）。
const scoring = {
  dimensions: {
    novelty_problem: 30,
    novelty_method: 30,
    novelty_combo: 25,
    feasibility: 15,
  },
  thresholds: {
    high_risk_similarity: 0.85,
    topk: 10,
    keyword_only: {
      related_similarity: 0.1,
      near_duplicate_similarity: 0.3,
      boundary_band: [0.1, 0.3],
    },
  },
  suggestion_bands: {
    proceed: [75, 100],
    revise: [50, 74],
    abandon: [0, 49],
  },
}

// ── 5. 种子论文：语料里被引用/提取最多的那批 ───────────────────────────────
const extractedRows = db.raw
  .prepare("SELECT paper_id FROM papers WHERE md_path IS NOT NULL AND md_path != '' LIMIT 20")
  .all()
const seedPapers = extractedRows.map((row) => row.paper_id)

const draft = {
  ref: { pack_id: PACK_ID, version: VERSION },
  generated_at: new Date().toISOString(),
  generated_by: 'scripts/bootstrap-pack.mjs（从 metadata.db 实测派生）',
  seed_papers: seedPapers,
  schema_ext: schemaExt,
  lexicon,
  benchmarks,
  scoring,
  /** 非契约字段：给评审人看的派生统计。 */
  provenance: {
    papers: db.raw.prepare('SELECT COUNT(*) c FROM papers').get().c,
    parsed: db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE md_path IS NOT NULL AND md_path != ''").get().c,
    extractions: files.length,
    entries: Object.fromEntries(STORES.map((store) => [store, db.raw.prepare(`SELECT COUNT(*) c FROM ${store}`).get().c])),
    observed_ext_fields: Object.fromEntries(STORES.map((store) => [store, [...extInventory[store].keys()]])),
    top_benchmarks: rank(canonicalBenchmarks, 3).slice(0, 15),
    all_benchmark_names: rank(canonicalBenchmarks, 1).map(([name, count]) => `${name}(${count})`),
    included_benchmark_names: includedBenchmarks.map(([name, count]) => `${name}(${count})`),
    excluded_non_deepfake_benchmarks: rank(excludedBenchmarks, 1).map(([name, count]) => `${name}(${count})`),
    top_metrics: rank(canonicalMetrics, 2).slice(0, 12),
    all_metric_names: rank(canonicalMetrics, 1).map(([name, count]) => `${name}(${count})`),
    top_baselines: rank(baselineCount, 4).slice(0, 15),
  },
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(draft, null, 2)}\n`)
db.close()

console.log(`Domain Pack 草案已生成：${OUT}`)
console.log(`  种子论文 ${seedPapers.length} 篇；schema_ext：` +
  STORES.map((store) => `${store} ${Object.keys(schemaExt[store]).length} 字段`).join('、'))
console.log(`  benchmarks ${benchmarks.benchmarks.length} 个、metrics ${benchmarks.metrics.length} 个、协议 ${benchmarks.required_protocols.length} 条`)
console.log(`  lexicon：${lexicon.terms.length} 术语 / ${lexicon.query_expansion.length} 改写组`)
console.log('\n频次前列的 benchmark（≥3 篇提及）：')
for (const [name, count] of rank(canonicalBenchmarks, 3).slice(0, 12)) console.log(`  ${count}×  ${name}`)
console.log('\n各库实测 ext 字段：')
for (const store of STORES) {
  console.log(`  ${store}：${[...extInventory[store].entries()].map(([field, values]) => `${field}(${values.length})`).join(', ') || '(无)'}`)
}
console.log('\n下一步（冻结需人工评审，不可跳过）：')
console.log(`  1) 评审 ${OUT}`)
console.log('  2) node scripts/freeze-pack.mjs --reviewer "<你的标识>"')
