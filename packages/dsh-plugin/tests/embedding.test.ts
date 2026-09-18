/**
 * 本地 embedding（§4b）测试。
 *
 * ## 为什么这些测试必须能在**没有模型**的机器上跑
 *
 * 模型是 112.8MB 的手工下载件，不进仓库、不进 CI。如果测试硬依赖它，
 * 那"embedding 可用"这件事就变成了"跑测试的人碰巧下过模型"——这种测试比没有更糟。
 *
 * 所以分两层：
 * - **不依赖模型**：缓存探测、`cosine`、端口降级、`Ranker` 契约——全部用假后端断言；
 * - **依赖模型**：真模型的语义区分度，跑之前先探缓存，没有就 `skip`（跳过的原因写清楚）。
 *
 * 第二层是这条链路的**唯一真实判据**（§9.1："字面为 0 但语义 > 0.5"）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lexicalSimilarity } from '@cv-research/core'

import {
  DEFAULT_EMBEDDING_MODEL,
  DTYPE_FILENAMES,
  cosine,
  listCachedModels,
  loadLocalEmbedder,
  modelCacheDir,
  probeModelCache,
  resetEmbedderCache,
} from '../lib/scoring/embedding.js'
import { lexicalRanker, semanticRanker, type Ranker } from '../lib/scoring/collide.js'

const CACHE_ROOT = join(process.cwd(), '..', '..', 'data', 'models')

let dir: string | undefined

afterEach(async () => {
  resetEmbedderCache()
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

/** 造一个"看起来完整"的假缓存目录。 */
async function fakeCache(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cvagent-embed-'))
  dir = root
  for (const relative of files) {
    const target = join(modelCacheDir(root, DEFAULT_EMBEDDING_MODEL), relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'x')
  }
  return root
}

describe('缓存探测（只查磁盘，不联网）', () => {
  it('文件齐全 → ready；缺 ONNX → 缺的正是 dtype 对应的那个文件名', async () => {
    const complete = await fakeCache(['config.json', 'tokenizer.json', 'tokenizer_config.json', join('onnx', 'model_quantized.onnx')])
    expect((await probeModelCache(complete)).ready).toBe(true)

    const noOnnx = await fakeCache(['config.json', 'tokenizer.json', 'tokenizer_config.json'])
    const probe = await probeModelCache(noOnnx)
    expect(probe.ready).toBe(false)
    expect(probe.missing).toEqual([join('onnx', 'model_quantized.onnx')])
  })

  it('dtype 决定要哪个 ONNX：只有 fp32 文件时，q8 探测如实报缺', async () => {
    const fp32Only = await fakeCache(['config.json', 'tokenizer.json', 'tokenizer_config.json', join('onnx', 'model.onnx')])
    expect((await probeModelCache(fp32Only, DEFAULT_EMBEDDING_MODEL, 'q8')).ready).toBe(false)
    expect((await probeModelCache(fp32Only, DEFAULT_EMBEDDING_MODEL, 'fp32')).ready).toBe(true)
    // 两个 dtype 的文件名不同，这正是手工放文件最容易出错的地方（§9.2）
    expect(DTYPE_FILENAMES.q8).not.toBe(DTYPE_FILENAMES.fp32)
  })

  it('空文件不算就位（中断下载会留下 0 字节文件）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvagent-embed-'))
    dir = root
    const onnx = join(modelCacheDir(root, DEFAULT_EMBEDDING_MODEL), 'onnx', DTYPE_FILENAMES.q8)
    await mkdir(join(onnx, '..'), { recursive: true })
    await writeFile(onnx, '')
    const probe = await probeModelCache(root)
    expect(probe.ready).toBe(false)
    expect(probe.missing).toContain(join('onnx', DTYPE_FILENAMES.q8))
  })

  it('缓存目录按仓库 ID 分层：org/name 两层，不能拍平', () => {
    expect(modelCacheDir('data/models', 'Xenova/foo')).toBe(join('data/models', 'Xenova', 'foo'))
  })

  it('模型不在缓存 → loadLocalEmbedder 返回 undefined（而不是抛错，也不会转去联网）', async () => {
    const empty = await fakeCache([])
    expect(await loadLocalEmbedder({ cacheDir: empty })).toBeUndefined()
  })

  it('显式关闭 → 直接 undefined（连缓存都不探，对照实验用）', async () => {
    const complete = await fakeCache(['config.json', 'tokenizer.json', 'tokenizer_config.json', join('onnx', 'model_quantized.onnx')])
    expect(await loadLocalEmbedder({ cacheDir: complete, disabled: true })).toBeUndefined()
  })
})

describe('cosine', () => {
  it('同向为 1、正交为 0、反向为 -1', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('零向量返回 0 而不是 NaN（缺向量时排序要能继续）', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([], [1, 1])).toBe(0)
  })
})

describe('排序端口契约', () => {
  /** 假后端：把文本映射到固定向量，用余弦验证端口接线是否正确。 */
  const fakeBackend = (table: Record<string, number[]>) => ({
    model: 'fake', dtype: 'q8' as const, dimensions: 2,
    async embed(texts: readonly string[]) {
      return texts.map((text) => table[text] ?? [0, 0])
    },
  })

  it('semanticRanker 逐对取余弦，且 query/text 各只编码一次（批量而不是逐对）', async () => {
    const calls: string[][] = []
    const backend = {
      model: 'fake', dtype: 'q8' as const, dimensions: 2,
      async embed(texts: readonly string[]) {
        calls.push([...texts])
        return texts.map((text) => (text === '同义' ? [1, 0] : text === '无关' ? [0, 1] : [1, 0]))
      },
    }
    const ranker = semanticRanker(backend)
    expect(ranker.mode).toBe('semantic')
    const scores = await ranker.rank([
      { query: '同义', text: '同义' },
      { query: '同义', text: '无关' },
    ])
    expect(scores[0]).toBeCloseTo(1)
    expect(scores[1]).toBeCloseTo(0)
    expect(calls).toHaveLength(2) // 两次批量：query 一批、text 一批
    expect(calls[0]).toEqual(['同义', '同义'])
  })

  it('lexicalRanker 就是字面相似度（降级路径不能改变语义）', async () => {
    const ranker = lexicalRanker(lexicalSimilarity)
    expect(ranker.mode).toBe('lexical')
    const pairs = [{ query: '跨生成器泛化', text: '跨数据集泛化' }]
    expect((await ranker.rank(pairs))[0]).toBe(lexicalSimilarity('跨生成器泛化', '跨数据集泛化'))
    expect(await ranker.rank([])).toEqual([])
  })

  it('两个端口都满足 Ranker 契约（空输入不炸、长度一一对应）', async () => {
    const rankers: Ranker[] = [lexicalRanker(lexicalSimilarity), semanticRanker(fakeBackend({ a: [1, 0], b: [0, 1] }))]
    for (const ranker of rankers) {
      const pairs = [{ query: 'a', text: 'a' }, { query: 'a', text: 'b' }, { query: 'a', text: 'c' }]
      expect(await ranker.rank(pairs)).toHaveLength(pairs.length)
    }
  })
})

describe('真模型（未下载则跳过）', () => {
  it('语义相似度分得开「换词」与「无关」——这是 4b 的唯一真实判据', async () => {
    const probe = await probeModelCache(CACHE_ROOT)
    if (!probe.ready) {
      // 不是"通过"，是"没验"——跳过的原因必须能被看见
      console.warn(`模型未缓存（缺 ${probe.missing.join('、')}），本次未验证语义排序；见设计文档 §9.2`)
      return
    }
    const backend = await loadLocalEmbedder({ cacheDir: CACHE_ROOT })
    expect(backend, '缓存已就位却加载失败，说明包或 ONNX 有问题').toBeDefined()
    if (backend === undefined) return

    const embed = async (text: string) => (await backend.embed([text]))[0] ?? []
    const [near1, near2, far, same1, same2] = await Promise.all([
      embed('跨生成器泛化'), embed('跨数据集泛化'), embed('量子纠缠在低温超导中的退相干机制研究'),
      embed('跨生成器泛化'), embed('跨生成器泛化'),
    ])

    const synonymous = cosine(near1, near2)
    const unrelated = cosine(near1, far)
    expect(cosine(same1, same2)).toBeCloseTo(1, 3)   // 上界：同文本必须几乎为 1
    expect(synonymous).toBeGreaterThan(0.5)          // 换词但同义 → 高
    expect(unrelated).toBeLessThan(0.4)              // 无关 → 低
    expect(synonymous, '字面度量给 0.000，语义必须把这两者分开').toBeGreaterThan(unrelated + 0.3)
    // 同一个词在两次调用里的向量必须一致（否则排序不可复现）
    expect(cosine(near1, same1)).toBeCloseTo(1, 3)
    expect(backend.dimensions).toBeGreaterThan(0)
  }, 120_000)

  it('缓存清单能列出模型（排障入口）', async () => {
    const models = await listCachedModels(CACHE_ROOT)
    expect(Array.isArray(models)).toBe(true)
  })
})
