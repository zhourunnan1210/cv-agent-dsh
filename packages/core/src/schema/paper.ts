/**
 * papers 表的规范化记录与去重键（平台无关）。
 *
 * 依据：勘误 §7.5.2 冻结的 papers 表 + 补充的去重键优先级（第 4 点）。
 * 本文件只定义数据形状与纯函数；SQLite 落地在 `packages/dsh-plugin`。
 */

/** 检索来源通道（勘误 §7.5.2 第 3 点：检索层不写死通道）。 */
export type PaperSourceChannel = 'asta' | 'ai4scholar' | 'manual'

export type PaperPdfStatus = 'pending' | 'downloaded' | 'missing'
export type PaperParseChannel = 'mineru' | 'quick_read'
export type PaperExtractionQuality = 'full_text' | 'abstract_only'

/** papers 表一条规范化记录（内存形态；authors 入库时为 JSON 数组）。 */
export interface PaperRecord {
  /** DOI 或 arXiv ID（归一化小写）；本地论文允许 `local:<hash>`。 */
  readonly paper_id: string
  readonly title: string
  readonly authors: readonly string[]
  readonly year?: number
  readonly venue?: string
  readonly citation_count?: number
  readonly doi?: string
  readonly arxiv_id?: string
  readonly pmid?: string
  readonly url?: string
  readonly oa_pdf_url?: string
  readonly abstract?: string
  readonly source_channel: PaperSourceChannel
  readonly pdf_status: PaperPdfStatus
  readonly parse_channel?: PaperParseChannel
  readonly extraction_quality?: PaperExtractionQuality
  /** markdown/ 下相对路径。 */
  readonly md_path?: string
  /** 本地 PDF 文件路径（迁移 v2 追加；P2-5 落盘流水线用它喂 MinerU）。 */
  readonly pdf_path?: string
  readonly created_at: string
  readonly updated_at: string
}

/**
 * 归一化 DOI / arXiv ID（§7.5.2 去重键第 1 级）。
 *
 * - 小写；
 * - 去掉 `https://doi.org/`、`http://dx.doi.org/`、`doi:` 前缀；
 * - 去掉 `arxiv:` 前缀与 `https://arxiv.org/abs|pdf/` 前缀、`.pdf` 后缀。
 */
export function normalizePaperId(raw: string): string {
  let value = raw.trim().toLowerCase()
  value = value.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
  value = value.replace(/^doi:\s*/, '')
  value = value.replace(/^arxiv:\s*/i, '')
  value = value.replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '')
  value = value.replace(/\.pdf$/i, '')
  return value
}

/** 标题归一化（去重键第 3 级线索用：小写、去全部非字母数字）。 */
export function normalizeTitle(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 去重命中方式（§7.5.2 优先级 1 → 2 → 3）。 */
export type DedupeMatchKind = 'paper_id' | 'external_id' | 'title'

/** 一条候选记录与既有记录的去重判定结果。 */
export interface DedupeMatch {
  readonly kind: DedupeMatchKind
  readonly existing: PaperRecord
}

/**
 * 判定候选记录是否命中既有记录（纯函数，供入库服务与测试使用）。
 *
 * 优先级：paper_id → 任一外部 ID（doi/arxiv_id/pmid）→ 标题归一化线索。
 * 标题命中只是**人工复核级线索**（不自动合并），由调用方决定是否采纳。
 */
export function dedupeMatch(
  candidate: PaperRecord,
  existing: readonly PaperRecord[],
): DedupeMatch | undefined {
  const candidateId = normalizePaperId(candidate.paper_id)
  for (const record of existing) {
    if (normalizePaperId(record.paper_id) === candidateId) {
      return { kind: 'paper_id', existing: record }
    }
  }
  const externalKeys = ['doi', 'arxiv_id', 'pmid'] as const
  for (const record of existing) {
    for (const key of externalKeys) {
      const candidateValue = candidate[key]
      const recordValue = record[key]
      if (candidateValue !== undefined && recordValue !== undefined
        && normalizePaperId(candidateValue) === normalizePaperId(recordValue)) {
        return { kind: 'external_id', existing: record }
      }
    }
  }
  const candidateTitle = normalizeTitle(candidate.title)
  if (candidateTitle.length > 0) {
    for (const record of existing) {
      if (normalizeTitle(record.title) === candidateTitle) {
        return { kind: 'title', existing: record }
      }
    }
  }
  return undefined
}

/**
 * 合并两条记录（§7.5.2：保留较长 abstract、union authors、缺失字段回填）。
 * `base` 为库中既有记录，`incoming` 为新来记录；返回合并结果。
 *
 * 实现注意（EOPT 严格模式 + 语义）：
 * - 逐字段条件展开，不能整体 spread——可选字段会带上 `| undefined`，
 *   违反 `exactOptionalPropertyTypes`；
 * - **paper_id 保留 base 的**：合并发生在「已存在行」上，PK 不能漂移成
 *   incoming 的 ID（否则 UPDATE 会改错行）。
 */
export function mergePaperRecords(base: PaperRecord, incoming: PaperRecord): PaperRecord {
  const authors = [...base.authors]
  for (const author of incoming.authors) {
    if (!authors.includes(author)) authors.push(author)
  }
  const abstract = (base.abstract?.length ?? 0) >= (incoming.abstract?.length ?? 0)
    ? base.abstract
    : incoming.abstract

  return {
    paper_id: base.paper_id,
    title: incoming.title,
    authors,
    ...(incoming.year !== undefined ? { year: incoming.year } : base.year !== undefined ? { year: base.year } : {}),
    ...(incoming.venue !== undefined ? { venue: incoming.venue } : base.venue !== undefined ? { venue: base.venue } : {}),
    ...(incoming.citation_count !== undefined
      ? { citation_count: incoming.citation_count }
      : base.citation_count !== undefined ? { citation_count: base.citation_count } : {}),
    ...(incoming.doi !== undefined ? { doi: incoming.doi } : base.doi !== undefined ? { doi: base.doi } : {}),
    ...(incoming.arxiv_id !== undefined ? { arxiv_id: incoming.arxiv_id } : base.arxiv_id !== undefined ? { arxiv_id: base.arxiv_id } : {}),
    ...(incoming.pmid !== undefined ? { pmid: incoming.pmid } : base.pmid !== undefined ? { pmid: base.pmid } : {}),
    ...(incoming.url !== undefined ? { url: incoming.url } : base.url !== undefined ? { url: base.url } : {}),
    ...(incoming.oa_pdf_url !== undefined ? { oa_pdf_url: incoming.oa_pdf_url } : base.oa_pdf_url !== undefined ? { oa_pdf_url: base.oa_pdf_url } : {}),
    ...(abstract !== undefined ? { abstract } : {}),
    source_channel: incoming.source_channel,
    // 解析产物只升级不降级：已有 downloaded 不回退
    pdf_status: base.pdf_status === 'downloaded' ? 'downloaded' : incoming.pdf_status,
    ...(base.parse_channel !== undefined
      ? { parse_channel: base.parse_channel }
      : incoming.parse_channel !== undefined ? { parse_channel: incoming.parse_channel } : {}),
    ...(base.extraction_quality !== undefined
      ? { extraction_quality: base.extraction_quality }
      : incoming.extraction_quality !== undefined ? { extraction_quality: incoming.extraction_quality } : {}),
    ...(base.md_path !== undefined
      ? { md_path: base.md_path }
      : incoming.md_path !== undefined ? { md_path: incoming.md_path } : {}),
    ...(base.pdf_path !== undefined
      ? { pdf_path: base.pdf_path }
      : incoming.pdf_path !== undefined ? { pdf_path: incoming.pdf_path } : {}),
    created_at: base.created_at,
    updated_at: incoming.updated_at,
  }
}
