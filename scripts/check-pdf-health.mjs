/**
 * 解析提交前的 PDF 体检：完整性 + 来源页数 + 年份自洽。
 *
 * 用法：
 *   node scripts/check-pdf-health.mjs                      # 检查全部「未解析且有 PDF」的论文
 *   node scripts/check-pdf-health.mjs --list data/papers/<清单>.txt
 *
 * 为什么需要（2026-09-17/18 事故教训）：
 *   抓取端一旦用「只读一次响应体」的方式下载，连接被中途掐断时会把**截断的 PDF**
 *   当成成功落盘。这种文件开头是合法的 `%PDF`，很容易蒙混过关，但送去 MinerU 解析
 *   要么失败、要么产出残缺正文，**而这会消耗按页计费的每日额度**。
 *   本批 30 篇里曾实测到 12 篇截断（体积精确落在 256KB 的整数倍上，是缓冲区截断的指纹）。
 *
 * 判据：
 *   1. 体积 > 20KB
 *   2. 开头是 `%PDF` 魔数
 *   3. 尾部 4KB 内出现 `%%EOF` 结束标记（截断检测的关键判据）
 *   4. 真解析器（vendored pdf-parse）能读出至少 1 页
 *
 * ⚠ 踩过的坑：最初用「正则数 `/Type /Page` 文本」估页数，对新式 PDF（页面对象被压进
 *   对象流）会**误报损坏**——曾把两篇完全正常的论文判为"数不到页面对象"。页数一律
 *   用真解析器判定，不要用文本正则。
 */

import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
}
const listFile = opt('--list')

const requireVendor = createRequire('D:/Code/VScodeRepo/dsh-plugin/packages/vendor/dsh-ai4scholar/package.json')
const pdfParseEntry = requireVendor.resolve('pdf-parse')
const { PDFParse } = await import(pathToFileURL(pdfParseEntry).href)

const database = new PaperDatabase('data/papers/metadata.db')

let rows
if (listFile !== undefined) {
  const ids = (await readFile(listFile, 'utf8')).split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '' && !s.startsWith('#'))
  const ph = ids.map(() => '?').join(',')
  rows = database.raw.prepare(`SELECT paper_id, title, year, arxiv_id, pdf_path FROM papers WHERE paper_id IN (${ph})`).all(...ids)
} else {
  rows = database.raw.prepare(`
    SELECT paper_id, title, year, arxiv_id, pdf_path FROM papers
    WHERE (parse_channel IS NULL OR parse_channel = '')
      AND pdf_path IS NOT NULL AND pdf_path != ''
    ORDER BY year DESC, paper_id ASC
  `).all()
}

const problems = []
console.log(`体检 ${rows.length} 篇（判据：体积 / %PDF 魔数 / %%EOF 结束标记 / 解析器可读页数）\n`)

for (const row of rows) {
  const issues = []
  let size = 0
  let pages = null
  try {
    const info = await stat(row.pdf_path)
    size = info.size
    if (size < 20_000) issues.push(`体积过小 ${size}B`)
    const buf = await readFile(row.pdf_path)
    if (!buf.subarray(0, 5).toString('latin1').startsWith('%PDF')) issues.push('魔数异常')
    const tail = buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1')
    if (!tail.includes('%%EOF')) issues.push('缺少 %%EOF（疑似截断）')
    try {
      const pdf = new PDFParse({ data: buf })
      try {
        pages = Number((await pdf.getText()).total) || null
      } finally {
        await pdf.destroy()
      }
    } catch (error) {
      issues.push(`解析器读不出：${String(error.message).slice(0, 50)}`)
    }
    if (pages === null || pages === 0) issues.push('页数为 0')
  } catch (error) {
    issues.push(`读取失败：${error.message}`)
  }

  const arxiv = row.arxiv_id === null ? '' : String(row.arxiv_id).trim()
  if (/^\d{4}\.\d{4,5}$/.test(arxiv)) {
    const yy = Number(arxiv.slice(0, 2))
    const arxivYear = yy >= 90 ? 1900 + yy : 2000 + yy
    if (arxivYear - Number(row.year) > 1) issues.push(`年份可疑：库内 ${row.year} vs arXiv ${arxiv}`)
  }

  if (issues.length === 0) {
    console.log(`✓ ${row.paper_id}  ${Math.round(size / 1024)}KB  ${pages}p`)
  } else {
    console.log(`⚠ ${row.paper_id}  ${Math.round(size / 1024)}KB  ← ${issues.join('；')}`)
    problems.push({ paper_id: row.paper_id, issues, pages })
  }
}

console.log(`\n有问题的 ${problems.length}/${rows.length} 篇`)
if (problems.length > 0) {
  console.log('清单（这些不要提交解析，先用 scripts/fetch-arxiv-pdf.mjs --force 重下）：')
  for (const p of problems) console.log(`  ${p.paper_id}`)
}

let totalPages = 0
for (const p of problems) totalPages += p.pages ?? 0
database.close()
