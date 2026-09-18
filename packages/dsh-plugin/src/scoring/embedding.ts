/**
 * 本地 embedding（整合设计 v1.0 §9 第 4b 步）。
 *
 * ## 它解决什么
 *
 * core 的 `lexicalSimilarity` 是字符 trigram 的 Jaccard。实测（2026-09-18）：
 *
 * | 文本对 | trigram | 本模块（余弦） |
 * | --- | --- | --- |
 * | 跨生成器泛化 \| 跨数据集泛化 | 0.000 | 0.663 |
 * | 跨生成器泛化 \| cross-generator generalization | 0.000 | 0.746 |
 * | 小样本下该损失不收敛 \| 该损失在小样本条件下无法收敛 | 0.111 | 0.938 |
 * | 跨生成器泛化 \| 量子纠缠…（无关对照） | 0.000 | 0.195 |
 *
 * 字面度量**分不开"换词"和"无关"**（都给 0），而撞车检测最要抓的恰恰是
 * "模块名不同、机制相同"。这就是上表的 `0.000 vs 0.663`。
 *
 * ## 边界（必须守住，§5.4）
 *
 * 本模块产出的相似度**只用于排序**，不参与判定与打分：
 * 三位专家看的是原文与出处，`renderCollisionContext` 不输出任何相似度数字。
 * 所以量化损失（q8）在这里是可接受的——它的作用是把"该看的论文排到前面"。
 *
 * ## 三条工程纪律
 *
 * 1. **绝不联网**：只查本地缓存目录，缺文件就返回 `undefined` 让上层退回字面排序。
 *    自动下载在实测网络下不可行（HF 直连超时），静默卡住比降级更糟。
 * 2. **失败不抛**：包没装、模型没下、ONNX 加载失败——一律返回 `undefined`。
 *    embedding 是增强项，不是硬依赖。
 * 3. **缓存按仓库 ID 分层**：`<cacheDir>/<org>/<name>/`，文件名由 dtype 推导。
 *    手工放文件时最常错的就是这两处（见 §9.2）。
 *
 * @module cv-agent-dsh/scoring-embedding
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 支持的精度。`q8` 走量化文件（112.8MB），`fp32` 走全精度（448.5MB）。 */
export type EmbeddingDtype = 'q8' | 'fp32'

/**
 * dtype → ONNX 文件名。
 *
 * 这是 transformers.js 的推导规则（q8 → `_quantized`）。**手工放文件时必须按这张表命名**，
 * 名字写错会被当成缓存未命中而转去联网。
 */
export const DTYPE_FILENAMES: Record<EmbeddingDtype, string> = {
  q8: 'model_quantized.onnx',
  fp32: 'model.onnx',
}

/** 默认模型（多语，能同时处理中文与英文的对照）。 */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

/** 除 ONNX 外，加载器还会读这几个文件。 */
const SIDECAR_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const

/** 归一化的句向量后端。 */
export interface EmbeddingBackend {
  /** 模型 ID，写进报告便于审计。 */
  readonly model: string
  readonly dtype: EmbeddingDtype
  /** 向量维度（首次 `embed` 后才有值；探测阶段为 0）。 */
  readonly dimensions: number
  /** 批量取归一化向量（余弦 = 点积）。 */
  embed(texts: readonly string[]): Promise<number[][]>
}

/** 缓存探测结果。 */
export interface CacheProbe {
  readonly ready: boolean
  /** 缓存目录绝对路径。 */
  readonly dir: string
  /** 缺失的文件（相对缓存目录）；`ready` 时为空。 */
  readonly missing: readonly string[]
}

/** 缓存目录布局：`<cacheDir>/<org>/<name>`（与 transformers.js 的 `env.cacheDir` 约定一致）。 */
export function modelCacheDir(cacheDir: string, model: string): string {
  return join(cacheDir, ...model.split('/'))
}

/**
 * 只查磁盘、**不联网**：模型是否已完整缓存。
 *
 * @param cacheDir - 缓存根目录（如 `data/models`）。
 * @param model - 模型 ID（如 `Xenova/…`）。
 * @param dtype - 精度，决定 ONNX 文件名。
 * @returns 探测结果；`missing` 列出缺哪些文件，便于直接照着手工补。
 */
export async function probeModelCache(
  cacheDir: string,
  model: string = DEFAULT_EMBEDDING_MODEL,
  dtype: EmbeddingDtype = 'q8',
): Promise<CacheProbe> {
  const dir = modelCacheDir(cacheDir, model)
  const needed = [...SIDECAR_FILES, join('onnx', DTYPE_FILENAMES[dtype])]
  const missing: string[] = []
  for (const relative of needed) {
    const ok = await stat(join(dir, relative)).then((info) => info.isFile() && info.size > 0).catch(() => false)
    if (!ok) missing.push(relative)
  }
  return { ready: missing.length === 0, dir, missing }
}

/** 余弦相似度（两个等长向量；任一为零向量时返回 0）。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** `loadLocalEmbedder` 的入参。 */
export interface EmbedderOptions {
  /** 缓存根目录。缺省 `data/models`（相对进程 cwd）。 */
  readonly cacheDir?: string
  readonly model?: string
  readonly dtype?: EmbeddingDtype
  /** 关掉 embedding（配置项；为 true 时直接返回 `undefined`，连缓存都不探）。 */
  readonly disabled?: boolean
}

/** 已加载的后端按 `cacheDir|model|dtype` 记忆（模型加载约 0.9s，不值得每次重来）。 */
const loaded = new Map<string, EmbeddingBackend | undefined>()

/**
 * 加载本地 embedding 后端；**任何失败都返回 `undefined`**（上层退回字面排序）。
 *
 * 返回 `undefined` 的三种情况，报告里要如实体现（`rank_mode: 'lexical'`）：
 * 1. 显式关闭（`disabled`）；
 * 2. 模型未缓存（`missing` 会告诉上层缺哪个文件）；
 * 3. `@huggingface/transformers` 未安装或 ONNX 加载失败（optionalDependency，允许缺席）。
 *
 * @param options - 缓存目录、模型、精度。
 * @returns 归一化向量后端；不可用时 `undefined`。
 */
export async function loadLocalEmbedder(options: EmbedderOptions = {}): Promise<EmbeddingBackend | undefined> {
  if (options.disabled === true) return undefined
  const cacheDir = options.cacheDir ?? join('data', 'models')
  const model = options.model ?? DEFAULT_EMBEDDING_MODEL
  const dtype = options.dtype ?? 'q8'
  const key = `${cacheDir}|${model}|${dtype}`
  if (loaded.has(key)) return loaded.get(key)

  const backend = await createBackend(cacheDir, model, dtype)
  loaded.set(key, backend)
  return backend
}

/** 清空加载记忆（测试用：避免用例之间互相污染）。 */
export function resetEmbedderCache(): void {
  loaded.clear()
}

async function createBackend(cacheDir: string, model: string, dtype: EmbeddingDtype): Promise<EmbeddingBackend | undefined> {
  const probe = await probeModelCache(cacheDir, model, dtype)
  // 缺文件就到此为止：让 transformers.js 去联网只会卡住（实测 HF 直连超时）
  if (!probe.ready) return undefined

  try {
    // 动态 import：包是 optionalDependency，缺席时不该让整个插件挂掉
    const transformers = await import('@huggingface/transformers')
    const { pipeline, env } = transformers
    // 双保险：即使文件探测有漏，也不允许它悄悄走网络
    env.cacheDir = cacheDir
    env.allowRemoteModels = false
    env.allowLocalModels = true

    const extract = await pipeline('feature-extraction', model, { dtype })
    let dimensions = 0

    return {
      model,
      dtype,
      get dimensions(): number {
        return dimensions
      },
      async embed(texts: readonly string[]): Promise<number[][]> {
        if (texts.length === 0) return []
        const output = await extract([...texts], { pooling: 'mean', normalize: true })
        // 批量输出是扁平 Float32Array：按 dimensions 切片还原成每条一个向量
        const flat = Array.from(output.data as Float32Array)
        const list = output.dims ?? []
        const width = list.length > 0 ? (list[list.length - 1] ?? 0) : 0
        if (width === 0) return []
        dimensions = width
        const vectors: number[][] = []
        for (let offset = 0; offset + width <= flat.length; offset += width) {
          vectors.push(flat.slice(offset, offset + width))
        }
        return vectors
      },
    }
  } catch {
    // 包未安装 / ONNX 加载失败 / 磁盘读取错误：一律降级，不把插件拖下水
    return undefined
  }
}

/** 列缓存目录下已有哪些模型（诊断用：`scripts/check-embedding.mjs` 与排障都靠它）。 */
export async function listCachedModels(cacheDir: string): Promise<string[]> {
  const orgs = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
  const models: string[] = []
  for (const org of orgs) {
    if (!org.isDirectory()) continue
    const names = await readdir(join(cacheDir, org.name), { withFileTypes: true }).catch(() => [])
    for (const name of names) if (name.isDirectory()) models.push(`${org.name}/${name.name}`)
  }
  return models
}

export default loadLocalEmbedder
