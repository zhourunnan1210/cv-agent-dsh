/**
 * MinerU 官方 API 适配器（精准解析 API，docs/mineru-api.md 的落地）。
 *
 * 链路（§8.1 上传优先——境外 URL 会超时）：
 *   POST {base}/file-urls/batch        → 拿 batch_id 与每个文件的签名上传链接（24h）
 *   PUT  本地文件字节（无需 Content-Type）
 *   GET  {base}/extract-results/batch/{batch_id}  → 轮询至 done/failed
 *   GET  full_zip_url → 下载 zip → fflate 解压到目标目录
 *
 * 判据（§3）：HTTP 200 且 body.code === 0 才算成功；code != 0 时 HTTP 仍是 200。
 *
 * 凭证：`resolveToken` 每次调用现取（§23 密钥卫生：不缓存、不落日志）；
 * 调用方（Cordis 行）传 `ctx.credentials.resolve('MINERU_TOKEN')` 的包装。
 * fetch 可注入（测试用 mock；生产用 global fetch）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { unzipSync } from 'fflate'

/** 提交本地文件的请求体（`files` 字段名由实测确认，docs/mineru-api.md §2.1）。 */
export interface MineruLocalFile {
  readonly name: string
  readonly path: string
  /** 可选数据标识（查询时回传，便于对账）。 */
  readonly data_id?: string
}

export interface MineruClientOptions {
  readonly baseUrl: string
  /** 每次操作现取的 token；返回 undefined 表示未配置（调用即失败，别用空串冒充）。 */
  readonly resolveToken: () => Promise<string | undefined>
  /** 测试注入；缺省 global fetch。 */
  readonly fetchImpl?: typeof fetch
  readonly pollIntervalMs?: number
  readonly pollTimeoutMs?: number
}

/** 单个文件的解析结果。 */
export interface MineruFileResult {
  readonly fileName: string
  /**
   * 提交时带上的 `data_id`（业务侧标识）。**实测会原样回传**（2026-09-17），
   * 因此它比 file_name 更可靠：文件名可能被 sanitize/截断/重名，data_id 是我们自己给的。
   */
  readonly dataId?: string
  readonly state: 'pending' | 'running' | 'converting' | 'done' | 'failed'
  readonly errMsg?: string
  readonly fullZipUrl?: string
}

/** 批量轮询的最终结果。 */
export interface MineruBatchResult {
  readonly batchId: string
  readonly files: readonly MineruFileResult[]
  /** 解析成功的页数合计（额度记账用；解析中拿不到时按 0 计）。 */
  readonly pages: number
}

/** 业务层错误（code != 0 或网关信封）。 */
export class MineruApiError extends Error {
  readonly code: number | string | undefined

  constructor(message: string, code?: number | string) {
    super(message)
    this.name = 'MineruApiError'
    this.code = code
  }
}

interface ApiEnvelope {
  code?: number
  msg?: string
  data?: {
    batch_id?: string
    /** 实测形状（2026-09-16）：签名上传 URL 的字符串数组，与 files 顺序一致。 */
    file_urls?: string[]
    state?: string
    err_msg?: string
    full_zip_url?: string
    extract_progress?: { extracted_pages?: number; total_pages?: number }
    /** 实测形状（2026-09-16）：批量结果字段名是 extract_result，不是 results。 */
    extract_result?: Array<{
      file_name?: string
      /** 提交时的 data_id，实测回传（2026-09-17）。 */
      data_id?: string
      state?: string
      err_msg?: string
      full_zip_url?: string
      extract_progress?: { extracted_pages?: number }
    }>
  }
}

/** 从响应解析业务信封；非 200 或 code != 0 抛 MineruApiError。 */
async function readEnvelope(response: Response, trace: string): Promise<ApiEnvelope> {
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    throw new MineruApiError(`${trace}：响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    // 网关层信封（§3）：401 login required / {"success":false,"msgCode":"A0202",...}
    const record = body as Record<string, unknown>
    const msg = typeof record.msg === 'string'
      ? record.msg
      : typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
    throw new MineruApiError(`${trace}：${msg}`, response.status)
  }
  const envelope = body as ApiEnvelope
  if (envelope.code !== undefined && envelope.code !== 0) {
    throw new MineruApiError(`${trace}：${envelope.msg ?? '业务错误'}（code=${envelope.code}）`, envelope.code)
  }
  return envelope
}

export class MineruClient {
  private readonly options: Required<Pick<MineruClientOptions, 'baseUrl' | 'pollIntervalMs' | 'pollTimeoutMs'>>
  private readonly resolveToken: MineruClientOptions['resolveToken']
  private readonly fetchImpl: typeof fetch

  constructor(options: MineruClientOptions) {
    this.options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      pollIntervalMs: options.pollIntervalMs ?? 8000,
      pollTimeoutMs: options.pollTimeoutMs ?? 30 * 60 * 1000,
    }
    this.resolveToken = options.resolveToken
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
  }

  /** 提交本地文件：拿签名上传链接并逐个 PUT。 */
  async submitLocalFiles(files: readonly MineruLocalFile[]): Promise<string> {
    if (files.length === 0) throw new MineruApiError('submitLocalFiles：文件列表为空')
    const token = await this.requireToken()
    const response = await this.fetchImpl(`${this.options.baseUrl}/file-urls/batch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: files.map((file) => ({ name: file.name, ...(file.data_id === undefined ? {} : { data_id: file.data_id }) })),
      }),
    })
    const envelope = await readEnvelope(response, 'file-urls/batch')
    const batchId = envelope.data?.batch_id
    const uploads = envelope.data?.file_urls ?? []
    if (batchId === undefined || uploads.length !== files.length) {
      throw new MineruApiError(`file-urls/batch：响应缺 batch_id 或 file_urls 数量不符（${uploads.length}/${files.length}）`)
    }
    for (const [index, file] of files.entries()) {
      const uploadUrl = uploads[index]
      if (uploadUrl === undefined || uploadUrl === '') {
        throw new MineruApiError(`file-urls/batch：第 ${index + 1} 个文件缺少签名上传链接`)
      }
      const bytes = await readFile(file.path)
      const put = await this.fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(bytes.byteLength) },
        body: bytes,
      })
      if (!put.ok) {
        throw new MineruApiError(`上传 ${file.name} 失败：HTTP ${put.status}`)
      }
    }
    return batchId
  }

  /** 轮询批量结果至全部终态或超时。 */
  async pollBatch(batchId: string, signal?: AbortSignal): Promise<MineruBatchResult> {
    const token = await this.requireToken()
    const deadline = Date.now() + this.options.pollTimeoutMs
    for (;;) {
      if (signal?.aborted) throw new MineruApiError('pollBatch：已取消')
      if (Date.now() > deadline) throw new MineruApiError(`pollBatch：超过 ${this.options.pollTimeoutMs}ms 未完成`)
      const response = await this.fetchImpl(`${this.options.baseUrl}/extract-results/batch/${batchId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        ...(signal === undefined ? {} : { signal }),
      })
      const envelope = await readEnvelope(response, `extract-results/batch/${batchId}`)
      const results = envelope.data?.extract_result ?? []
      const files: MineruFileResult[] = results.map((result) => ({
        fileName: result.file_name ?? '(unknown)',
        ...(result.data_id === undefined ? {} : { dataId: result.data_id }),
        state: (result.state ?? 'pending') as MineruFileResult['state'],
        ...(result.err_msg === undefined ? {} : { errMsg: result.err_msg }),
        ...(result.full_zip_url === undefined ? {} : { fullZipUrl: result.full_zip_url }),
      }))
      const allTerminal = files.length > 0 && files.every((file) => file.state === 'done' || file.state === 'failed')
      if (allTerminal) {
        return {
          batchId,
          files,
          pages: files.reduce((sum, file) => sum + (file.state === 'done' ? 1 : 0), 0),
        }
      }
      await sleep(this.options.pollIntervalMs)
    }
  }

  /** 下载 full_zip_url 并解压到目标目录；返回落盘文件路径列表。 */
  async downloadExtract(zipUrl: string, destDir: string): Promise<string[]> {
    const response = await this.fetchImpl(zipUrl)
    if (!response.ok) throw new MineruApiError(`下载解析结果失败：HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const entries = unzipSync(bytes)
    await mkdir(destDir, { recursive: true })
    const written: string[] = []
    for (const [name, data] of Object.entries(entries)) {
      // 防御：不写出路径穿越条目
      const target = join(destDir, basename(name))
      await writeFile(target, data)
      written.push(target)
    }
    return written
  }

  private async requireToken(): Promise<string> {
    const token = await this.resolveToken()
    if (token === undefined || token === '') {
      throw new MineruApiError('MINERU_TOKEN 未配置（credentials.resolve 返回空）')
    }
    return token
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
