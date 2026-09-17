/**
 * 检查会话存储：cv-research preset 是否挂载成功、会话是否拿到 cvagent 工具。
 *
 * 会话文件是 zstd 压缩的 jsonl，所以要解压后再搜。用 Node 内置 zstd（Node 22.15+）。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, found)
    else if (entry.isFile() && entry.name.includes('session')) found.push(full)
  }
  return found
}

const files = (await walk(root))
  .map((path) => ({ path }))
  .sort()
const withTime = []
for (const file of files) {
  try {
    const info = await stat(file.path)
    withTime.push({ ...file, mtime: info.mtime, size: info.size })
  } catch {}
}
withTime.sort((a, b) => b.mtime - a.mtime)

const needles = [
  'cvagent_scope_set', 'cvagent_kb_scout', 'cvagent_kb_analyze', 'cvagent_idea_generate',
  'cvagent_kb_extract', 'mcp__asta__snippet_search', 'cvagent_state_advance',
]
console.log(`会话文件 ${withTime.length} 个，检查最近 6 个\n`)
for (const file of withTime.slice(0, 6)) {
  const raw = await readFile(file.path)
  let text
  try {
    text = zstdDecompressSync(raw).toString('utf8')
  } catch (error) {
    console.log(`${file.mtime.toISOString().slice(5, 16)}  ${(file.size / 1024).toFixed(0)}KB  ✗ 解压失败：${error.message}`)
    continue
  }
  const hits = needles.filter((needle) => text.includes(needle))
  const agentPreset = /"agentPreset"\s*:\s*"([^"]+)"/.exec(text)?.[1]
    ?? /cv-research/.test(text) ? (agentPreset0 => agentPreset0)(/"cv-research"/.test(text) ? 'cv-research(出现字符串)' : undefined) : undefined
  console.log(`${file.mtime.toISOString().slice(5, 16)}  ${(file.size / 1024).toFixed(0)}KB  解压 ${(text.length / 1024).toFixed(0)}KB`)
  console.log(`    cvagent/asta 工具名命中：${hits.length === 0 ? '（无）' : hits.join(', ')}`)
  console.log(`    含 "cv-research" 字样：${/cv-research/.test(text) ? '是' : '否'}`)
}
