/**
 * 模块清单（整合设计 v1.0 §3.5）的测试。
 *
 * 这一层是**逐模块撞车的对齐对象**——它回答"你的这个模块，库里有没有人做过"。
 * 所以测试重点在**归一与合并**：合并太松会把两个不同机制并成一个（撞车漏判），
 * 合并太紧会把同一机制拆成三条（撞车误判为全新）。两侧都要钉住。
 *
 * 另一条红线：**本层不做语义判断**。名字不同时它只返回候选，判定权在 Analyst（§11.3）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import { MIGRATIONS } from '../lib/kb/db.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + '@deepseek-ai/dsh-system-prompt/package.json')
const systemPromptModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(
  pathToFileURL(createRequire(DSH + '@deepseek-ai/cordis/package.json').resolve('@deepseek-ai/cordis')).href
)

describe('模块清单（逐模块撞车的对齐对象）', () => {
  let dir
  let kb

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-modules-'))
    const app = new cordis.Context()
    await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
    await app.plugin({
      name: 'kb',
      inject: ['systemPrompt'],
      apply(ctx) { kb = new KbService(ctx, { dbPath: join(dir, 'metadata.db') }) },
    })
  })

  afterEach(async () => {
    kb?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('新建：分配 MOD 序号，并记下来源论文与派生条目（可追溯链）', () => {
    const outcome = kb.upsertModule({
      name: '频域一致性约束',
      statement: '约束新旧任务在频谱响应上的一致性，抑制对旧伪造类型的遗忘。',
      kinds: ['loss'],
      paper_id: '10.1/a',
      innovation_id: 'I001',
    })
    expect(outcome.merged).toBe(false)
    expect(outcome.module_id).toBe('MOD001')

    const module = kb.getModule('MOD001')
    expect(module.name).toBe('频域一致性约束')
    expect(module.kinds).toEqual(['loss'])
    expect(module.origin_papers).toEqual(['10.1/a'])
    expect(module.origin_innovations).toEqual(['I001'])
  })

  it('归一化名相同即合并（大小写/标点/空白差异不该拆成两条）', () => {
    kb.upsertModule({ name: 'Frequency Consistency Loss', statement: '第一条', paper_id: '10.1/a' })
    // 同名的另一种写法：大小写与标点不同
    const second = kb.upsertModule({ name: 'frequency  consistency-loss', statement: '第二条更长更完整', paper_id: '10.1/b', innovation_id: 'I009' })

    expect(second.merged, '归一化后同名必须合并——否则同一机制会被拆成多条，撞车会误判为全新').toBe(true)
    expect(second.merged_into).toBe('MOD001')
    expect(kb.moduleCount()).toBe(1)

    const merged = kb.getModule('MOD001')
    expect(merged.origin_papers.sort()).toEqual(['10.1/a', '10.1/b'])
    expect(merged.origin_innovations).toEqual(['I009'])
    expect(merged.statement, '保留归一化后更长的那条（更完整）').toBe('第二条更长更完整')
  })

  it('名字不同 → 新建，并**只返回候选**（判定权在 Analyst，本层不做语义判断）', () => {
    kb.upsertModule({ name: '频域一致性约束', statement: '约束频谱响应一致性', paper_id: '10.1/a' })
    const outcome = kb.upsertModule({ name: '频率一致性损失', statement: '在频率域上加一致性正则', paper_id: '10.1/b' })

    expect(outcome.merged, '名字不同不能自动合并——语义判断不属于确定性层').toBe(false)
    expect(kb.moduleCount()).toBe(2)
    // 候选由**原始名**检索得出（用归一化串查永远命中不到，这是修过的一个 bug）
    expect(outcome.candidates.map((candidate) => candidate.module_id)).toContain('MOD001')
  })

  it('merge：把两条并成一条，来源与派生链都改指保留的那条', () => {
    const a = kb.upsertModule({ name: '频率一致性损失', statement: '短', paper_id: '10.1/a', innovation_id: 'I001' })
    const b = kb.upsertModule({ name: '频域一致性约束', statement: '更长的一条陈述', paper_id: '10.1/b', innovation_id: 'I009' })

    const merged = kb.mergeModules(b.module_id, a.module_id)
    expect(merged.module_id).toBe('MOD001')
    expect(kb.moduleCount()).toBe(1)
    expect(merged.origin_papers.sort()).toEqual(['10.1/a', '10.1/b'])
    expect(merged.origin_innovations.sort()).toEqual(['I001', 'I009'])
    expect(merged.statement, '保留更长的那条').toBe('更长的一条陈述')
    // 反向索引已改指
    expect(kb.papersOfModule('MOD001').sort()).toEqual(['10.1/a', '10.1/b'])
    expect(kb.getModule('MOD002')).toBeUndefined()
  })

  it('检索：FTS trigram 路径与 LIKE 回退路径都能命中', () => {
    kb.upsertModule({ name: '频域一致性约束', statement: '约束频谱响应一致性', paper_id: '10.1/a' })
    kb.upsertModule({ name: '稀疏回放缓冲', statement: '按分布密度挑选稀疏回放特征', paper_id: '10.1/b' })

    expect(kb.searchModules({ query: '频域' }).map((m) => m.name), '2 字中文走 LIKE 回退').toContain('频域一致性约束')
    expect(kb.searchModules({ query: '一致性约束' }).length, '≥3 字走 FTS').toBeGreaterThan(0)
    expect(kb.searchModules({ query: '回放' }).map((m) => m.name)).toContain('稀疏回放缓冲')
    expect(kb.searchModules({ query: '完全不存在的东西' })).toEqual([])
  })

  it('按 kind 与来源论文过滤', () => {
    kb.upsertModule({ name: '一致性损失', statement: 'x', kinds: ['loss'], paper_id: '10.1/a' })
    kb.upsertModule({ name: '适配器模块', statement: 'y', kinds: ['module'], paper_id: '10.1/b' })

    expect(kb.searchModules({ kinds: ['loss'] }).map((m) => m.name)).toEqual(['一致性损失'])
    expect(kb.searchModules({ paperId: '10.1/b' }).map((m) => m.name)).toEqual(['适配器模块'])
  })

  it('模块 ↔ 论文 双向可查', () => {
    kb.upsertModule({ name: '模块甲', statement: 'x', paper_id: '10.1/a' })
    kb.upsertModule({ name: '模块乙', statement: 'y', paper_id: '10.1/a' })
    kb.upsertModule({ name: '模块丙', statement: 'z', paper_id: '10.1/b' })

    // 按 module_id 断言顺序（module_id 由 entry_id 序分配，确定性）；
    // 不要按名字排序断言——JS 默认 sort 按 UTF-16 码位，中文名会得到反直觉的顺序。
    expect(kb.modulesOfPaper('10.1/a').map((m) => m.module_id)).toEqual(['MOD001', 'MOD002'])
    expect(kb.papersOfModule('MOD003')).toEqual(['10.1/b'])
    expect(kb.modulesOfPaper('10.9/none')).toEqual([])
  })

  it('空模块名被拒（否则会产生一条无法检索的空模块）', () => {
    expect(() => kb.upsertModule({ name: '   ', statement: 'x' })).toThrow(/模块名不能为空/)
  })

  it('迁移 v7：modules 表、FTS 与来源表都在（幂等）', () => {
    const versions = MIGRATIONS.map((migration) => migration.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(versions).toContain(7)

    const tables = kb.database.raw
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((row) => row.name)
    expect(tables).toContain('modules')
    expect(tables).toContain('modules_fts')
    expect(tables).toContain('module_sources')
  })

  it('upsert 幂等：同一条数据写两次不会产生第二个模块', () => {
    kb.upsertModule({ name: '频域一致性约束', statement: 'x', paper_id: '10.1/a', innovation_id: 'I001' })
    kb.upsertModule({ name: '频域一致性约束', statement: 'x', paper_id: '10.1/a', innovation_id: 'I001' })
    expect(kb.moduleCount()).toBe(1)
    expect(kb.getModule('MOD001').origin_papers).toEqual(['10.1/a'])
  })
})
