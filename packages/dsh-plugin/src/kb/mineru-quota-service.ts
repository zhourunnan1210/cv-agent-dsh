/**
 * `mineruQuota` 服务（宿主平面行）。
 *
 * 服务平面（docs/mineru-api.md §8.3，与勘误 §4.4.1 一致）：
 * MinerU 的 2000 页/天额度是**跨项目共享**资源，账本必须放宿主组合——
 * 本行经 `cordis.patch.yml` 挂到宿主，preset 行不得复制。
 *
 * @module cv-agent-dsh/mineru-quota
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { MineruQuotaLedger } from './mineru-quota.js'
import type { QuotaStatus } from './mineru-quota.js'

export interface Config {
  /** 账本文件路径；缺省 `data/mineru-quota.json`。 */
  ledgerPath?: string
}

export const Config = Schema.object({
  ledgerPath: Schema.string().default('data/mineru-quota.json').description('MinerU 额度账本文件路径。'),
})

/** E19：Loader 对不带 config 的行传 undefined，默认值显式落定。 */
export function resolveQuotaConfig(config: Config | undefined): Required<Config> {
  return {
    ledgerPath: config?.ledgerPath ?? 'data/mineru-quota.json',
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mineruQuota: MineruQuotaService
  }
}

export const name = 'cvagent-mineru-quota'

export class MineruQuotaService extends Service {
  static inject = []

  private readonly ledger: MineruQuotaLedger
  private readonly ready: Promise<void>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'mineruQuota')
    const resolved = resolveQuotaConfig(config)
    this.ledger = new MineruQuotaLedger(resolved.ledgerPath)
    this.ready = this.ledger.load()
  }

  /** 记录本次解析消耗的页数并落盘；返回记账后的状态。 */
  async record(pages: number): Promise<QuotaStatus> {
    await this.ready
    return this.ledger.record(pages)
  }

  /** 当前状态（先等账本装载完成）。 */
  async status(): Promise<QuotaStatus> {
    await this.ready
    return this.ledger.status
  }
}

/** 默认导出：loader 按 `module.default` 取插件类（E18-②）。 */
export default MineruQuotaService
