/**
 * MinerU 适配器与额度账本的测试（HTTP 层 mock + 真实文件 I/O）。
 *
 * 不消耗真实解析额度：fetch 注入 mock。真实端点连通性由
 * tests/spike-mineru-api.mjs 覆盖（不创建任务的探测手法）。
 * 字段名（file_urls: string[] / extract_result）按 2026-09-16 实测形状。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

import { MineruClient } from '../lib/kb/mineru.js'
import { MineruQuotaLedger, MINERU_DAILY_PAGE_LIMIT } from '../lib/kb/mineru-quota.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 记录请求序列的 fetch mock 工厂。 */
function makeMockFetch(responses: Array<(req: { url: string; method: string; body: string | null }) => Response>) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const entry = { url: request.url, method: request.method, headers: request.headers, body: await request.text().catch(() => null) }
    calls.push(entry)
    const handler = responses.shift()
    if (handler === undefined) throw new Error('mock fetch：响应耗尽')
    return handler(entry)
  }
  return { impl: impl as typeof fetch, calls }
}

describe('MineruClient（mock HTTP）', () => {
  const token = 'test-token'
  const base = 'https://mineru.net/api/v4'

  function client(fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof MineruClient>[0]> = {}) {
    return new MineruClient({
      baseUrl: base,
      resolveToken: async () => token,
      fetchImpl,
      ...options,
    })
  }

  it('submitLocalFiles：POST 拿签名链接 → 逐文件 PUT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mineru-submit-'))
    try {
      const pdfPath = join(dir, 'a.pdf')
      await writeFile(pdfPath, 'PDF-BYTES')
      const { impl, calls } = makeMockFetch([
        () => jsonResponse({ code: 0, msg: 'ok', data: { batch_id: 'b1', file_urls: ['https://upload.example/a'] } }),
        (req) => {
          expect(req.method).toBe('PUT')
          return new Response(null, { status: 200 })
        },
      ])
      const batchId = await client(impl).submitLocalFiles([{ name: 'a.pdf', path: pdfPath }])
      expect(batchId).toBe('b1')
      expect(calls).toHaveLength(2)
      expect(calls[0]?.url).toBe(`${base}/file-urls/batch`)
      expect(calls[0]?.method).toBe('POST')
      expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${token}`)
      const posted = JSON.parse(calls[0]?.body ?? '{}') as { files: Array<{ name: string }> }
      expect(posted.files).toEqual([{ name: 'a.pdf' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('业务层 code != 0（HTTP 200）→ MineruApiError 带 code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mineru-err-'))
    try {
      const pdfPath = join(dir, 'a.pdf')
      await writeFile(pdfPath, 'x')
      const { impl } = makeMockFetch([
        () => jsonResponse({ code: -10002, msg: 'type mismatch for field "files"' }),
      ])
      await expect(client(impl).submitLocalFiles([{ name: 'a.pdf', path: pdfPath }])).rejects.toThrow(
        /type mismatch/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('token 未配置 → 明确报错，不发请求', async () => {
    const { impl, calls } = makeMockFetch([])
    const noToken = new MineruClient({
      baseUrl: base,
      resolveToken: async () => undefined,
      fetchImpl: impl,
    })
    await expect(noToken.submitLocalFiles([{ name: 'a.pdf', path: 'x' }])).rejects.toThrow(/MINERU_TOKEN 未配置/)
    expect(calls).toHaveLength(0)
  })

  it('pollBatch：running → done 两次响应收敛，返回终态与页数', async () => {
    const { impl } = makeMockFetch([
      () => jsonResponse({ code: 0, data: { extract_result: [{ file_name: 'a.pdf', state: 'running' }] } }),
      () => jsonResponse({
        code: 0,
        data: { extract_result: [{ file_name: 'a.pdf', state: 'done', full_zip_url: 'https://cdn.example/a.zip' }] },
      }),
    ])
    const result = await client(impl, { pollIntervalMs: 5 }).pollBatch('b1')
    expect(result.batchId).toBe('b1')
    expect(result.files[0]).toMatchObject({ fileName: 'a.pdf', state: 'done' })
    expect(result.pages).toBe(1) // 占位口径：每个 done 文件计 1 页（mineru.ts 注释）
  })

  it('pollBatch：failed 也是终态，透出 err_msg', async () => {
    const { impl } = makeMockFetch([
      () => jsonResponse({ code: 0, data: { extract_result: [{ file_name: 'a.pdf', state: 'failed', err_msg: '-60010 解析失败' }] } }),
    ])
    const result = await client(impl, { pollIntervalMs: 5 }).pollBatch('b1')
    expect(result.files[0]).toMatchObject({ state: 'failed', errMsg: '-60010 解析失败' })
  })

  it('pollBatch 超时 → 抛错', async () => {
    const { impl } = makeMockFetch([
      () => jsonResponse({ code: 0, data: { extract_result: [{ file_name: 'a.pdf', state: 'running' }] } }),
      () => jsonResponse({ code: 0, data: { extract_result: [{ file_name: 'a.pdf', state: 'running' }] } }),
      () => jsonResponse({ code: 0, data: { extract_result: [{ file_name: 'a.pdf', state: 'running' }] } }),
    ])
    await expect(client(impl, { pollIntervalMs: 5, pollTimeoutMs: 12 }).pollBatch('b1')).rejects.toThrow(/超时|超过/)
  })

  it('downloadExtract：解压落盘并防御路径穿越', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mineru-zip-'))
    try {
      const zip = zipSync({ 'full.md': strToU8('# Title'), '../evil.txt': strToU8('x') })
      const { impl } = makeMockFetch([
        () => new Response(zip.buffer, { status: 200 }),
      ])
      const written = await client(impl).downloadExtract('https://cdn.example/a.zip', dir)
      const files = await readdir(dir)
      expect(files).toContain('full.md')
      expect(files).toContain('evil.txt') // basename 截断，不进上级目录
      expect((await readFile(join(dir, 'full.md'), 'utf8'))).toBe('# Title')
      expect(written.length).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('MineruQuotaService（宿主行封装）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mineru-quota-svc-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('服务行挂载后可记账，状态跨实例持久化', async () => {
    const { default: MineruQuotaService } = await import('../lib/kb/mineru-quota-service.js')
    const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const requireDsh = createRequire(DSH + '@deepseek-ai/cordis/package.json')
    const cordis = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href)
    const app = new cordis.Context()
    let service
    await app.plugin({
      name: 'quota-host',
      async apply(ctx) {
        await ctx.plugin(MineruQuotaService, { ledgerPath: join(dir, 'quota.json') })
      },
    })
    await app.plugin({
      name: 'quota-probe',
      inject: ['mineruQuota'],
      apply(ctx) {
        service = ctx.mineruQuota
      },
    })
    const status = await service.record(123)
    expect(status.usedPages).toBe(123)
    // 第二次实例从同一文件读取
    const app2 = new cordis.Context()
    let service2
    await app2.plugin({
      name: 'quota-host-2',
      async apply(ctx) {
        await ctx.plugin(MineruQuotaService, { ledgerPath: join(dir, 'quota.json') })
      },
    })
    await app2.plugin({
      name: 'quota-probe-2',
      inject: ['mineruQuota'],
      apply(ctx) {
        service2 = ctx.mineruQuota
      },
    })
    expect((await service2.status()).usedPages).toBe(123)
  })
})

describe('MineruQuotaLedger（真实文件）', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mineru-quota-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('记录页数并持久化，跨实例重读一致', async () => {
    const path = join(dir, 'quota.json')
    const ledger = new MineruQuotaLedger(path)
    await ledger.load()
    await ledger.record(100)
    await ledger.record(50)
    expect(ledger.status.usedPages).toBe(150)

    const reloaded = new MineruQuotaLedger(path)
    await reloaded.load()
    expect(reloaded.status.usedPages).toBe(150)
  })

  it('80% 告警阈值与超限标记（只告警不拒绝）', async () => {
    const ledger = new MineruQuotaLedger(join(dir, 'q.json'))
    await ledger.load()
    await ledger.record(MINERU_DAILY_PAGE_LIMIT * 0.8) // 1600：到达告警阈值
    expect(ledger.status.warning).toBe(true)
    expect(ledger.status.overHighPriority).toBe(false)
    await ledger.record(MINERU_DAILY_PAGE_LIMIT * 0.2 + 1) // 共 2001：超过高优先级额度
    expect(ledger.status.overHighPriority).toBe(true)
  })

  it('跨天自动清零', async () => {
    const path = join(dir, 'q.json')
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
    const month = String(yesterday.getMonth() + 1).padStart(2, '0')
    const day = String(yesterday.getDate()).padStart(2, '0')
    const date = `${yesterday.getFullYear()}-${month}-${day}`
    await writeFile(path, JSON.stringify({ date, usedPages: 1999 }), 'utf8')
    const ledger = new MineruQuotaLedger(path)
    await ledger.load()
    expect(ledger.status.usedPages).toBe(0)
  })
})
