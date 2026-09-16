/**
 * MinerU 额度账本（2000 页/天，docs/mineru-api.md §4）。
 *
 * 服务平面（docs/mineru-api.md §8.3，与勘误 §4.4.1 一致）：
 * **额度是跨项目共享的资源**，本账本必须放在**宿主平面**（与 GPU/预算账本同处），
 * 否则两个项目各自记账会绕过上限。本模块是账本实现；宿主行的接线在
 * `cordis.patch.yml`（Phase 2 后续轮次），此处先交付可测的实现。
 *
 * 语义（官方原文）：每天 2000 页**最高优先级**，超出部分优先级降低（不是拒绝），
 * 因此账本只记录与告警，不硬性拒绝。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 官方高优先级额度（docs/mineru-api.md §4）。 */
export const MINERU_DAILY_PAGE_LIMIT = 2000

/** 告警阈值：达到 80% 触发 §4.2 的 budget.warning 语义。 */
export const MINERU_WARN_RATIO = 0.8

export interface QuotaStatus {
  /** 账本日期（YYYY-MM-DD）。 */
  readonly date: string
  readonly usedPages: number
  readonly limit: number
  /** 是否已超过高优先级额度（仅告警，不拒绝）。 */
  readonly overHighPriority: boolean
  /** 是否达到告警阈值。 */
  readonly warning: boolean
}

interface QuotaFile {
  date: string
  usedPages: number
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 文件落盘的额度账本。 */
export class MineruQuotaLedger {
  private readonly filePath: string
  private state: QuotaFile

  constructor(filePath: string) {
    this.filePath = filePath
    this.state = { date: today(), usedPages: 0 }
  }

  /** 从磁盘装载（跨天自动清零）；文件不存在视为全新。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<QuotaFile>
      this.state = {
        date: typeof parsed.date === 'string' ? parsed.date : today(),
        usedPages: typeof parsed.usedPages === 'number' && parsed.usedPages >= 0 ? parsed.usedPages : 0,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { date: today(), usedPages: 0 }
        return
      }
      throw new Error(`MinerU 额度账本读取失败（${this.filePath}）：${(error as Error).message}`)
    }
    // 跨天：新的一天重新计
    if (this.state.date !== today()) {
      this.state = { date: today(), usedPages: 0 }
    }
  }

  /** 记录本次解析消耗的页数并落盘（原子写：tmp + rename）。 */
  async record(pages: number): Promise<QuotaStatus> {
    if (!Number.isInteger(pages) || pages < 0) {
      throw new Error(`MinerU 额度记账页数非法：${pages}`)
    }
    if (this.state.date !== today()) {
      this.state = { date: today(), usedPages: 0 }
    }
    this.state = { date: this.state.date, usedPages: this.state.usedPages + pages }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    await rename(tmp, this.filePath)
    return this.status
  }

  get status(): QuotaStatus {
    return {
      date: this.state.date,
      usedPages: this.state.usedPages,
      limit: MINERU_DAILY_PAGE_LIMIT,
      overHighPriority: this.state.usedPages > MINERU_DAILY_PAGE_LIMIT,
      warning: this.state.usedPages >= MINERU_DAILY_PAGE_LIMIT * MINERU_WARN_RATIO,
    }
  }
}
