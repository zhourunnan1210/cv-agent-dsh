/** 诊断会话文件格式：多帧 zstd？带头部？→ 用流式解压拼接所有帧。 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createZstdDecompress } from 'node:zlib'
import { Readable } from 'node:stream'

const root = join(homedir(), '.dsh', 'sessions')

async function walk(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, found)
    else if (entry.isFile() && entry.name.includes('session')) found.push(full)
  }
  return found
}

const files = []
for (const path of await walk(root)) {
  const info = await stat(path)
  files.push({ path, mtime: info.mtime, size: info.size })
}
files.sort((a, b) => b.mtime - a.mtime)

const target = files[0]
const raw = await readFile(target.path)
console.log(`文件：${target.path}`)
console.log(`大小：${raw.length}；前 16 字节：${[...raw.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`)
const magic = raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd
console.log(`zstd 魔数：${magic ? '是' : '否'}`)

// 统计帧起始位置（魔数出现次数）
let frames = 0
for (let i = 0; i + 3 < raw.length; i += 1) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) frames += 1
}
console.log(`魔数出现次数（≈帧数）：${frames}`)

// 流式解压：Node 的 zstd 流会连续处理拼接帧
const chunks = []
const decompress = createZstdDecompress()
await new Promise((resolvePromise, rejectPromise) => {
  decompress.on('data', (chunk) => chunks.push(chunk))
  decompress.on('end', resolvePromise)
  decompress.on('error', rejectPromise)
  Readable.from(raw).pipe(decompress)
})
const text = Buffer.concat(chunks).toString('utf8')
console.log(`解压后：${(text.length / 1024).toFixed(0)}KB，行数 ${text.split('\n').length}`)

const needles = ['cvagent_scope_set', 'cvagent_kb_scout', 'cvagent_kb_analyze', 'cvagent_idea_generate', 'cvagent_kb_extract', 'cvagent_state_advance', 'mcp__asta__']
for (const needle of needles) {
  const count = text.split(needle).length - 1
  console.log(`  ${needle}: ${count} 次`)
}
const presetMatch = /"(?:agentPreset|preset|presetId)"\s*:\s*"([^"]+)"/g
const presets = new Set()
let match
while ((match = presetMatch.exec(text)) !== null) presets.add(match[1])
console.log(`出现过的 preset 标识：${presets.size === 0 ? '（未匹配到字段）' : [...presets].join(', ')}`)
