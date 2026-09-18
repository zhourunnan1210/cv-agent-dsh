// 固化「与课题相关、待提取」的论文清单（重启后直接照单执行，不重新判断）
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/papers/metadata.db', { readOnly: true })

const AUDIO = /audio|speech|voice|asv|spoof|acoustic|speaker|mel-?spectrogram|mfcc|vocoder|voiceprint|singing|spoken/i
const FACE = /face|facial|forgery|deepfake detection|image forgery|synthetic image|portrait|video deepfake|face swap/i
const CL = /continual|incremental|catastrophic forgetting|lifelong|rehearsal|replay|class-incremental|domain-incremental/i

const pending = db.prepare(`
  SELECT p.paper_id, p.title, p.year, p.parse_channel, p.md_path
  FROM papers p
  WHERE p.md_path IS NOT NULL AND p.md_path != ''
    AND NOT EXISTS (SELECT 1 FROM paper_extractions e WHERE e.paper_id = p.paper_id)
`).all()

const buckets = { core: [], visual: [], cl: [], audio: [], other: [] }
for (const row of pending) {
  const t = String(row.title ?? '')
  const isAudio = AUDIO.test(t)
  const isFace = FACE.test(t)
  const isCl = CL.test(t)
  if (isFace && isCl) buckets.core.push(row)
  else if (isFace) buckets.visual.push(row)
  else if (isAudio) buckets.audio.push(row)
  else if (isCl) buckets.cl.push(row)
  else buckets.other.push(row)
}

const relevant = [...buckets.core, ...buckets.visual, ...buckets.cl]

const payload = {
  generated_at: new Date().toISOString(),
  note: '本清单 = 已解析且未提取、且与课题（持续学习 × 图像/视频深伪，不做音频）相关的论文。用户 2026-09-18 已裁定：只提取这批。',
  total_pending: pending.length,
  relevant_count: relevant.length,
  groups: {
    core_face_plus_cl: buckets.core.length,
    visual_face: buckets.visual.length,
    continual_learning_method: buckets.cl.length,
    excluded_audio: buckets.audio.length,
    excluded_other: buckets.other.length,
  },
  papers: relevant.map((r) => ({ paper_id: r.paper_id, title: r.title, year: r.year, group: r.group })),
}

writeFileSync('data/papers/extraction-list-relevant.json', `${JSON.stringify(payload, null, 2)}\n`)
writeFileSync('data/papers/extraction-list-relevant.txt', `${relevant.map((r) => r.paper_id).join('\n')}\n`)

console.log('=== 清单已固化 ===')
console.log(`待提取总数 ${pending.length} → 与课题相关 ${relevant.length}`)
console.log(`  正中课题（人脸深伪 + 持续学习）：${buckets.core.length}`)
console.log(`  人脸/图像深伪：${buckets.visual.length}`)
console.log(`  持续学习方法学：${buckets.cl.length}`)
console.log(`  [排除] 音频：${buckets.audio.length}`)
console.log(`  [排除] 其它：${buckets.other.length}`)
console.log('\n产出：data/papers/extraction-list-relevant.txt / .json')
console.log('\n=== 正中课题的那几篇（最该先做）===')
for (const r of buckets.core) console.log(`  · ${r.paper_id}\n    ${String(r.title).slice(0, 84)}`)
db.close()
