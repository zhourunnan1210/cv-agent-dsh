/**
 * 文本相似度测试（`core/src/scoring/score.ts`）。
 *
 * ⚠️ 这份文件原来还测「证据派生 / 裁判判定应用 / 加权总分 / 档位 / 风险 / 报告复算」
 * ——那整套**单裁判链路**已于 2026-09-18 删除（打分改由三位专家推理给出，
 * 撞车召回改由子代理读全库）。现在剩下的 `lexicalSimilarity` 只服务 MCP 的
 * `kb_search` 浏览检索排序，**不参与撞车判断，也不参与打分**。
 *
 * 这些用例仍然有价值：它们钉住了"这个函数到底能分辨什么"——尤其最后一条：
 * 同义改写它给不出分（改写 0.12 vs 无关 0.09）。那个已知局限正是它被逐出撞车
 * 链路的原因，不是待修的 bug。
 */
import { describe, expect, it } from 'vitest'

import { lexicalSimilarity, termSet, trigramSet } from '../src/scoring/score.js'

describe('相似度估计（keyword_only 模式的标定来源）', () => {
  it('完全相同 → 1，毫不相关 → 接近 0', () => {
    expect(lexicalSimilarity('跨数据集泛化的深伪检测', '跨数据集泛化的深伪检测')).toBe(1)
    expect(lexicalSimilarity('跨数据集泛化的深伪检测', '音频水印嵌入与提取')).toBeLessThan(0.15)
  })

  it('取值恒在 [0,1] 且对称', () => {
    const samples = ['', 'a', 'CLIP adapter 微调', '频域伪影 + 小波变换', '12345']
    for (const a of samples) {
      for (const b of samples) {
        const value = lexicalSimilarity(a, b)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
        expect(value).toBeCloseTo(lexicalSimilarity(b, a), 10)
      }
    }
  })

  it('归一化不变：大小写/标点/空白不影响结果', () => {
    const base = 'Dynamic Contour Convolution for face forgery detection'
    expect(lexicalSimilarity(base, 'dynamic contour convolution for FACE forgery-detection')).toBeCloseTo(lexicalSimilarity(base, base), 5)
  })

  it('中文语序不同仍给出较高相似度（词层自适应退化，不把整句当一个 token）', () => {
    // 修前实测 0.343：词层把两句各当 1 个 token，Jaccard=0 拉低了 0.4 权重
    const reordered = lexicalSimilarity('跨数据集泛化与持续学习遗忘', '持续学习遗忘与跨数据集泛化')
    expect(reordered).toBeGreaterThan(0.5)
    // 同义但用词不同：字符 trigram 与词集都命中不了 → 低分（已知局限，如实钉住）
    const synonym = lexicalSimilarity('face forgery detection', 'face manipulation identification')
    expect(synonym).toBeLessThan(0.45)
  })

  it('与真实语料的标定一致（scripts/calibrate-similarity2.mjs 的口径）', () => {
    // 真值对：Analyst 条目 ↔ 其来源论文的创新点原文（改写关系）实测 p50≈0.12
    const paraphrase = lexicalSimilarity(
      '空间-频率混合感知模块（SFHA）：小波频域注意与坐标注意空间图经可学习权重融合为动态门控图',
      'We propose a Spatial-Frequency Hybrid Attention (SFHA) module that fuses wavelet-domain and coordinate attention maps with learnable weights into a dynamic gating map',
    )
    // 无关对（不同论文的创新点）实测 p99≈0.09
    const unrelated = lexicalSimilarity(
      '空间-频率混合感知模块（SFHA）：小波频域注意与坐标注意空间图经可学习权重融合为动态门控图',
      'An audio-visual synchronization pretraining objective with Gaussian targets for temporal deepfake localization',
    )
    expect(paraphrase).toBeGreaterThan(unrelated)
    // 标定门槛 0.10 能把这一对分开（这是 keyword_only 相关候选门成立的前提）
    expect(unrelated).toBeLessThan(0.1)
  })

  it('trigramSet / termSet 的边界行为', () => {
    expect([...trigramSet('ab')]).toEqual(['ab'])
    expect(trigramSet('').size).toBe(0)
    expect(termSet('CLIP-based Adapter, v2').has('clip')).toBe(true)
    expect(termSet('a b').size).toBe(0) // 单字符词被过滤
  })
})
