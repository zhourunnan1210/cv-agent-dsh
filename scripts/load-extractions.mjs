/**
 * P2-7 · 批量装载 Reader 提取结果 + 契约校验。
 *
 * 用法：
 *   node scripts/load-extractions.mjs [--audit] [file.json ...]
 *     --audit   只校验与报告，不写库
 *     缺省目录：data/papers/extractions/*.json
 *
 * 校验（与 core PaperExtraction 契约一致）：
 *   - paper_id 必须能在 papers 表找到；
 *   - problem_statement / method_summary 为非空字符串；
 *   - innovations/future_work/limitations/benchmarks/metrics/baseline_methods 为字符串数组；
 *   - extraction_quality ∈ {full_text, abstract_only}；
 *   - extracted_at 为 ISO 串；
 *   - 一致性提示：声明 full_text 但该论文 md_path 为空 → 记为可疑（不算硬错误）。
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { PaperLibrary } from '../packages/dsh-plugin/lib/kb/library.js'

const args = process.argv.slice(2)
const auditOnly = args.includes('--audit')
const explicit = args.filter((arg) => !arg.startsWith('--'))

const ARRAY_FIELDS = ['innovations', 'future_work', 'limitations', 'benchmarks', 'metrics', 'baseline_methods']

function validate(extraction, knownPaperIds) {
  const problems = []
  const warnings = []
  if (typeof extraction.paper_id !== 'string' || extraction.paper_id === '') problems.push('paper_id 缺失')
  else if (!knownPaperIds.has(extraction.paper_id)) problems.push(`paper_id 不在 papers 表：${extraction.paper_id}`)
  for (const field of ['problem_statement', 'method_summary']) {
    if (typeof extraction[field] !== 'string' || extraction[field].trim() === '') problems.push(`${field} 为空`)
  }
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(extraction[field])) problems.push(`${field} 不是数组`)
    else if (extraction[field].some((item) => typeof item !== 'string')) problems.push(`${field} 含非字符串元素`)
  }
  if (!['full_text', 'abstract_only'].includes(extraction.extraction_quality)) {
    problems.push(`extraction_quality 非法：${extraction.extraction_quality}`)
  }
  if (typeof extraction.extracted_at !== 'string' || Number.isNaN(Date.parse(extraction.extracted_at))) {
    problems.push('extracted_at 不是 ISO 时间串')
  }
  if (extraction.extraction_quality === 'full_text'
    && typeof extraction.problem_statement === 'string' && extraction.problem_statement.length < 20) {
    warnings.push('full_text 但 problem_statement 过短（<20 字符），疑似应付')
  }
  return { problems, warnings }
}

const database = new PaperDatabase('data/papers/metadata.db')
const library = new PaperLibrary(database)
const knownPaperIds = new Set(database.raw.prepare('SELECT paper_id FROM papers').all().map((row) => row.paper_id))
const mdPathById = new Map(database.raw.prepare('SELECT paper_id, md_path FROM papers').all().map((row) => [row.paper_id, row.md_path]))

let files = explicit
if (files.length === 0) {
  const dir = 'data/papers/extractions'
  const entries = await readdir(dir).catch(() => [])
  files = entries.filter((name) => name.endsWith('.json')).map((name) => join(dir, name))
}

console.log(`待处理提取文件：${files.length} 个${auditOnly ? '（audit 模式，不写库）' : ''}\n`)
const report = { total: files.length, valid: 0, loaded: 0, invalid: 0, warnings: 0 }
const qualityCount = { full_text: 0, abstract_only: 0 }

for (const file of files) {
  let extraction
  try {
    extraction = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    report.invalid += 1
    console.log(`✗ ${basename(file)}：JSON 解析失败（${error.message}）`)
    continue
  }
  const { problems, warnings } = validate(extraction, knownPaperIds)
  for (const warning of warnings) {
    report.warnings += 1
    console.log(`⚠ ${basename(file)}：${warning}`)
  }
  if (mdPathById.get(extraction.paper_id) === undefined) {
    report.warnings += 1
    console.log(`⚠ ${basename(file)}：该论文 md_path 为空（提取可能不是来自全文解析）`)
  }
  if (problems.length > 0) {
    report.invalid += 1
    console.log(`✗ ${basename(file)}：${problems.join('；')}`)
    continue
  }
  report.valid += 1
  if (!auditOnly) {
    library.saveExtraction(extraction)
    report.loaded += 1
  }
  if (extraction.extraction_quality === 'full_text') qualityCount.full_text += 1
  else qualityCount.abstract_only += 1
  console.log(`✓ ${basename(file)}（${extraction.extraction_quality}，创新 ${extraction.innovations.length}，方法基准 ${extraction.baseline_methods.length}）`)
}

const totalParsed = database.raw.prepare("SELECT COUNT(*) c FROM papers WHERE md_path IS NOT NULL AND md_path != ''").get().c
console.log('\n── 提取装载报告 ───────────────────────────────')
console.log(`文件 ${report.total}：契约通过 ${report.valid}、写库 ${report.loaded}、非法 ${report.invalid}、警告 ${report.warnings}`)
console.log(`质量分布：full_text ${qualityCount.full_text}，abstract_only ${qualityCount.abstract_only}`)
console.log(`库内已解析论文 ${totalParsed} 篇；已有提取 ${library.extractionCount()} 篇`)
database.close()
