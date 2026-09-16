/**
 * S4 spike：三库检索的实现路线压测（勘误 §5.5 第 4 项「Phase 3 前」）。
 *
 * 要回答三个问题：
 *   1. `node:sqlite` 的 FTS5 可用吗？中文检索能work 吗（unicode61 vs trigram）？
 *   2. 扩展加载（sqlite-vec 的前提）在 `node:sqlite` 里怎么开、是否可用？
 *   3. 在「无 embedding 依赖」的前提下，暴力向量扫描的性能量级（1000 条 × 384/768 维）
 *      够不够 Phase 3 用？——够的话，向量层可以等 embedding 源定了再上，先走 FTS5。
 *
 * 只读仓库之外的系统能力，**不写仓库、不加依赖**。
 */

import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

// ── 1. FTS5 可用性 ────────────────────────────────────────────────────────
let db
try {
  db = new DatabaseSync(':memory:')
  db.exec("CREATE VIRTUAL TABLE t_default USING fts5(statement)")
  record('FTS5 可用', true, 'CREATE VIRTUAL TABLE ... USING fts5 成功')
} catch (error) {
  record('FTS5 可用', false, error.message)
}

if (db !== undefined) {
  // 英文/数字：unicode61 默认分词
  try {
    db.exec("INSERT INTO t_default(statement) VALUES ('cross-dataset generalization of deepfake detection')")
    const hit = db.prepare("SELECT rowid FROM t_default WHERE t_default MATCH 'generalization'").all()
    record('FTS5 unicode61 英文检索', hit.length === 1, `命中 ${hit.length} 条`)
  } catch (error) {
    record('FTS5 unicode61 英文检索', false, error.message)
  }

  // 中文：unicode61 不做词切分，整串成 token → 子串查不到（预期失败，用于说明必须换分词器）
  try {
    db.exec("INSERT INTO t_default(statement) VALUES ('跨数据集泛化与持续学习中的灾难性遗忘')")
    const hit = db.prepare("SELECT rowid FROM t_default WHERE t_default MATCH '泛化'").all()
    record('FTS5 unicode61 中文子串检索', hit.length === 1, `命中 ${hit.length} 条（0 = 需要 trigram/分词器）`)
  } catch (error) {
    record('FTS5 unicode61 中文子串检索', false, error.message)
  }

  // trigram 分词器（SQLite ≥3.34）：对中文按 3-gram 建索引。
  // 注意 FTS5 trigram 的硬限制：**查询串必须 ≥3 字符**，2 字中文查不到。
  try {
    db.exec("CREATE VIRTUAL TABLE t_tri USING fts5(statement, tokenize='trigram')")
    db.exec("INSERT INTO t_tri(statement) VALUES ('跨数据集泛化与持续学习中的灾难性遗忘')")
    const hit2 = db.prepare("SELECT rowid FROM t_tri WHERE t_tri MATCH '泛化'").all()
    const hit3 = db.prepare("SELECT rowid FROM t_tri WHERE t_tri MATCH '灾难性'").all()
    const hit4 = db.prepare("SELECT rowid FROM t_tri WHERE t_tri MATCH '持续学习'").all()
    record('FTS5 trigram 中文 2 字查询', hit2.length === 1, `命中 ${hit2.length} 条（trigram 限制：<3 字符查不到，属预期）`)
    record('FTS5 trigram 中文 3 字查询', hit3.length === 1, `命中 ${hit3.length} 条`)
    record('FTS5 trigram 中文 4 字查询', hit4.length === 1, `命中 ${hit4.length} 条`)
  } catch (error) {
    record('FTS5 trigram 中文检索', false, error.message)
  }

  // ── 2. 扩展加载能力（sqlite-vec 的前提）────────────────────────────────
  record('DatabaseSync.loadExtension 存在', typeof db.loadExtension === 'function', `typeof = ${typeof db.loadExtension}`)
  try {
    const strict = new DatabaseSync(':memory:')
    strict.loadExtension('/nonexistent/sqlite-vec')
    record('默认允许加载扩展', true, '（意外：未抛错）')
  } catch (error) {
    const message = String(error.message)
    const needsOptIn = /not allowed|allowExtension|enableLoadExtension/i.test(message)
    record('默认允许加载扩展', false, needsOptIn
      ? '被拒（需 new DatabaseSync(path, { allowExtension: true }) 显式开启）'
      : message.slice(0, 120))
  }
  try {
    const allowed = new DatabaseSync(':memory:', { allowExtension: true })
    allowed.loadExtension('/nonexistent/sqlite-vec')
    record('allowExtension:true 后可调用 loadExtension', true, '（扩展不存在但不再被策略拒绝）')
  } catch (error) {
    const message = String(error.message)
    record('allowExtension:true 后可调用 loadExtension', !/not allowed|allowExtension/i.test(message),
      message.slice(0, 120))
  }

  // ── 3. 暴力向量扫描量级（无扩展依赖的兜底路线）─────────────────────────
  const dims = [384, 768]
  const N = 1000
  for (const dim of dims) {
    const vdb = new DatabaseSync(':memory:')
    vdb.exec('CREATE TABLE v(entry_id TEXT PRIMARY KEY, vec BLOB)')
    const insert = vdb.prepare('INSERT INTO v(entry_id, vec) VALUES (?, ?)')
    const vectors = []
    for (let i = 0; i < N; i += 1) {
      const arr = new Float32Array(dim)
      for (let d = 0; d < dim; d += 1) arr[d] = Math.sin(i * 0.01 + d)
      vectors.push(arr)
    }
    const t0 = performance.now()
    vdb.exec('BEGIN')
    for (let i = 0; i < N; i += 1) insert.run(`E${i}`, new Uint8Array(vectors[i].buffer))
    vdb.exec('COMMIT')
    const tInsert = performance.now() - t0

    const query = new Float32Array(dim).fill(0.5)
    const rows = vdb.prepare('SELECT entry_id, vec FROM v').all()
    const t1 = performance.now()
    let best = -Infinity
    let bestId = ''
    let scanned = 0
    for (let repeat = 0; repeat < 20; repeat += 1) {
      for (const row of rows) {
        const vec = new Float32Array(row.vec.buffer, row.vec.byteOffset, dim)
        let dot = 0
        for (let d = 0; d < dim; d += 1) dot += vec[d] * query[d]
        scanned += 1
        if (dot > best) { best = dot; bestId = row.entry_id }
      }
    }
    const tScan = performance.now() - t1
    record(`暴力扫描 ${N}×${dim}维`, true,
      `插入 ${tInsert.toFixed(1)}ms；20 次全扫 ${tScan.toFixed(1)}ms（单次 ${(tScan / 20).toFixed(2)}ms，扫描 ${scanned} 条）best=${bestId}`)
  }
  db.close()
}

console.log('\n── S4 spike 结论 ──────────────────────────────')
console.log(results.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}`).join('\n'))
