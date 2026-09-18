/**
 * Idea 打分确定性层测试（P3-3，`core/src/scoring/score.ts`）。
 *
 * 这一层是「裁判能改结论、但不能凭空报数」的落点，因此测试重点：
 * - 相似度估计有界、可复现、对归一化不变；
 * - 检索基线分的定义（无证据 ≠ 新颖）；
 * - 边界带判定（外扩 Asta 的触发条件）；
 * - 裁判判定如何影响维度分（撞车封顶 20、表面相似剔除、可行性采用裁判值）；
 * - **报告可复算**：`recomputeTotal(report) === report.total`。
 */
import { describe, expect, it } from 'vitest'

import {
  applyJudgment,
  classifyBand,
  classifyRisk,
  deriveEvidence,
  lexicalSimilarity,
  recomputeTotal,
  termSet,
  totalScore,
  trigramSet,
} from '../src/scoring/score.js'
import type { ScoringConfig, ScoringDimensions } from '../src/scoring/idea.js'

const CONFIG: ScoringConfig = {
  dimensions: { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 },
  thresholds: {
    high_risk_similarity: 0.85,
    topk: 10,
    keyword_only: { related_similarity: 0.1, near_duplicate_similarity: 0.3, boundary_band: [0.1, 0.3] },
  },
  suggestion_bands: { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] },
}

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

describe('证据派生与检索基线分', () => {
  const problemHits = [
    { ref_id: 'P002', source: 'problems' as const, statement: '跨数据集泛化不足：未见生成方法下性能下降' },
    { ref_id: 'P006', source: 'problems' as const, statement: '实时与轻量化部署受限' },
  ]
  const methodHits = [
    { ref_id: 'M015', source: 'methods' as const, statement: 'CLIP-LN-tuning：冻结 CLIP 只微调 LayerNorm' },
  ]

  it('基线分 = 100×(1−max 相似度)；无共现证据时 combo 给保守值 70', () => {
    const derived = deriveEvidence({
      problem: '跨数据集泛化不足：未见生成方法下性能下降',
      method: 'CLIP 参数高效微调',
      problemHits,
      methodHits,
      retrievalMode: 'keyword_only',
    })
    // 问题侧有完全同文的命中 → 相似度 ~1 → 新颖度 ~0
    expect(derived.baselines.novelty_problem).toBeLessThanOrEqual(5)
    expect(derived.baselines.novelty_combo).toBe(70)
    expect(derived.baselines.feasibility).toBe(60)
    expect(derived.evidence).toHaveLength(3)
    expect(derived.evidence.every((item) => item.verdict === 'unjudged')).toBe(true)
  })

  it('基线分按"检索到的最高相似度"算——边界带判据已于 2026-09-18 删除', () => {
    // 曾经这里断言"相似度落在 [0.1,0.3) → needs_external=true"。那个判据被删了：
    // 同义改写的相似度只有 0.0039，落在 0.10 以下，**最该外扩的情况反而不触发**。
    // 外扩判断现在由读过全库的粗筛子代理做（dsh-plugin/src/scoring/screen.ts）。
    // 本函数现在只剩一件事：从命中算基线分。这个用例钉住的是那件事还成立。
    const same = deriveEvidence({
      problem: '跨数据集泛化与持续学习中的灾难性遗忘',
      method: 'x',
      problemHits: [{ ref_id: 'P003', source: 'problems', statement: '跨数据集泛化与持续学习中的灾难性遗忘' }],
      methodHits: [],
      retrievalMode: 'keyword_only',
    })
    expect(same.evidence[0].similarity).toBeCloseTo(1, 2)
    // 近乎同文 → 问题新颖度应该很低（相似度 1 → 100×(1−1) = 0）
    expect(same.baselines.novelty_problem).toBe(0)

    const borderline = deriveEvidence({
      problem: '持续学习中的灾难性遗忘问题',
      method: 'x',
      problemHits: [{ ref_id: 'P003', source: 'problems', statement: '增量深伪检测的灾难性遗忘与历史样本回放开销' }],
      methodHits: [],
      retrievalMode: 'keyword_only',
    })
    // 相关但措辞不同：相似度低 → 基线分高（这正是同义改写会被误判成"新颖"的地方，
    // 所以基线分**不参与最终打分**，只作为派生值留痕）
    expect(borderline.baselines.novelty_problem).toBeGreaterThan(same.baselines.novelty_problem)
  })

  it('如实钉住 keyword 模式的致命盲区：同义改写相似度为 0 → 裁判不可省', () => {
    // 这两句在语义上是同一件事（跨数据集泛化不足），但用词完全不同：
    // 字符 trigram 与词集都命中不了 → 相似度 0。检索侧永远召不回它，
    // 所以「语义撞车」只能由 LLM 裁判负责——这是 §11.2 分工表的实证依据。
    expect(lexicalSimilarity(
      '深伪检测的跨数据集泛化能力不足',
      '检测器在未见生成方法与分布偏移下性能下降',
    )).toBe(0)
    expect(lexicalSimilarity('轻量化部署与实时推理', '高精度检测器计算开销大难以在边缘落地')).toBe(0)
  })

  it('backend_score 优先于本层估计（embedding 到位后可直接注入余弦）', () => {
    const derived = deriveEvidence({
      problem: '任意问题',
      method: '任意方法',
      problemHits: [{ ref_id: 'P001', source: 'problems', statement: '完全无关的陈述', backend_score: 0.93 }],
      methodHits: [],
      retrievalMode: 'vector',
    })
    expect(derived.evidence[0].similarity).toBe(0.93)
    expect(derived.baselines.novelty_problem).toBe(7)
  })
})

describe('裁判判定 → 维度分（数值仍由 core 算）', () => {
  const derived = deriveEvidence({
    problem: '跨数据集泛化不足',
    method: 'CLIP 参数高效微调',
    problemHits: [{ ref_id: 'P002', source: 'problems', statement: '跨数据集泛化不足：未见生成方法下性能下降' }],
    methodHits: [{ ref_id: 'M015', source: 'methods', statement: 'CLIP-LN-tuning：冻结 CLIP 只微调 LayerNorm' }],
    comboHits: [{ ref_id: '10.1/a', source: 'papers', statement: 'CLIP 适配器用于深伪检测' }],
    retrievalMode: 'keyword_only',
  })

  it('判为撞车 → 该维度封顶 20 分（裁判不能把撞车抬回高分）', () => {
    const judged = applyJudgment(derived, {
      verdicts: [
        { ref_id: 'P002', verdict: 'collision', reason: '该问题已被 P002 明确列为待解问题' },
      ],
    })
    expect(judged.dimensions.novelty_problem).toBeLessThanOrEqual(20)
    expect(judged.trace.novelty_problem.adjusted_by_judge).toBe(true)
    const evidence = judged.evidence.find((item) => item.ref_id === 'P002')
    expect(evidence?.verdict).toBe('collision')
    expect(evidence?.reason).toMatch(/P002/)
  })

  it('判为表面相似 → 剔除该命中，维度按「无相似」给 85（谨慎给分，不给满分）', () => {
    const judged = applyJudgment(derived, {
      verdicts: [{ ref_id: 'M015', verdict: 'superficial', reason: '都用了 CLIP，但任务与机制不同' }],
    })
    expect(judged.dimensions.novelty_method).toBe(85)
    expect(judged.trace.novelty_method.retrieval_baseline).toBe(derived.baselines.novelty_method)
  })

  it('未判定的证据保持 unjudged，维度维持检索基线（不因"没判"而变分）', () => {
    const judged = applyJudgment(derived, { verdicts: [] })
    expect(judged.dimensions.novelty_problem).toBe(derived.baselines.novelty_problem)
    expect(judged.dimensions.novelty_method).toBe(derived.baselines.novelty_method)
    expect(judged.trace.novelty_problem.adjusted_by_judge).toBe(false)
  })

  it('可行性采用裁判值；非法值（越界）回落到基线', () => {
    const ok = applyJudgment(derived, { verdicts: [], feasibility: 42 })
    expect(ok.dimensions.feasibility).toBe(42)
    const bad = applyJudgment(derived, { verdicts: [], feasibility: 130 })
    expect(bad.dimensions.feasibility).toBe(derived.baselines.feasibility)
  })
})

describe('加权聚合、档位与风险级（确定性）', () => {
  const dimensions: ScoringDimensions = {
    novelty_problem: 90,
    novelty_method: 80,
    novelty_combo: 70,
    feasibility: 60,
  }

  it('总分 = 加权和 / 权重和，四舍五入到整数', () => {
    // (90×30 + 80×30 + 70×25 + 60×15) / 100 = 77.5 → 78
    expect(totalScore(dimensions, CONFIG)).toBe(78)
  })

  it('档位映射覆盖 0–100 且不重叠', () => {
    expect(classifyBand(100, CONFIG)).toBe('proceed')
    expect(classifyBand(75, CONFIG)).toBe('proceed')
    expect(classifyBand(74, CONFIG)).toBe('revise')
    expect(classifyBand(50, CONFIG)).toBe('revise')
    expect(classifyBand(49, CONFIG)).toBe('abandon')
    expect(classifyBand(0, CONFIG)).toBe('abandon')
  })

  it('风险级按模式取阈值：keyword 模式用 0.30（近似同文），vector 模式用 0.85', () => {
    const evidence = (similarity: number) => [
      { ref_id: 'a', source: 'problems' as const, statement_excerpt: '', similarity, external: false, verdict: 'unjudged' as const, reason: '' },
    ]
    // keyword 模式：0.35 已属"近似同文" → high；vector 模式同一数值远低于 0.85 → low
    expect(classifyRisk(evidence(0.35), CONFIG, 'keyword_only')).toBe('high')
    expect(classifyRisk(evidence(0.35), CONFIG, 'vector')).toBe('low')
    // keyword 模式下 0.2（相关但不同文）不足以判高风险
    expect(classifyRisk(evidence(0.2), CONFIG, 'keyword_only')).toBe('low')
  })

  it('裁判判定的撞车条数决定风险级；表面相似不计入', () => {
    const base = { source: 'problems' as const, statement_excerpt: '', similarity: 0.15, external: false, reason: '' }
    const one = classifyRisk([{ ...base, ref_id: 'a', verdict: 'collision' as const }], CONFIG, 'keyword_only')
    expect(one).toBe('medium')
    const two = classifyRisk([
      { ...base, ref_id: 'a', verdict: 'collision' as const },
      { ...base, ref_id: 'b', verdict: 'collision' as const },
    ], CONFIG, 'keyword_only')
    expect(two).toBe('high')
    const superficial = classifyRisk([{ ...base, ref_id: 'a', verdict: 'superficial' as const }], CONFIG, 'keyword_only')
    expect(superficial).toBe('low')
  })
})

describe('报告可复算（硬规则 ③ 的可执行判据）', () => {
  it('recomputeTotal(report) 与报告里的 total 一致，且不依赖任何外部输入', () => {
    const derived = deriveEvidence({
      problem: '跨数据集泛化不足',
      method: 'CLIP 参数高效微调',
      problemHits: [{ ref_id: 'P002', source: 'problems', statement: '跨数据集泛化不足：未见生成方法下性能下降' }],
      methodHits: [],
      retrievalMode: 'keyword_only',
    })
    const judged = applyJudgment(derived, {
      verdicts: [{ ref_id: 'P002', verdict: 'superficial', reason: '检索命中的是求解方向而非同一问题' }],
      feasibility: 70,
      rationale: '问题侧被判为表面相似，方法侧无命中，可行性尚可。',
    })
    const weights = CONFIG.dimensions
    const report = {
      idea_id: 'idea-1',
      total: totalScore(judged.dimensions, CONFIG),
      dimensions: judged.dimensions,
      weights_snapshot: weights,
      suggestion: classifyBand(totalScore(judged.dimensions, CONFIG), CONFIG),
      risk_level: classifyRisk(judged.evidence, CONFIG, 'keyword_only'),
    }
    expect(recomputeTotal(report)).toBe(report.total)
    expect(report.suggestion).toBe('proceed')
    expect(report.risk_level).toBe('low')
    // 换了权重快照就应算出不同结果——证明复算确实用了报告自带的权重，而不是硬编码
    const other = { ...report, weights_snapshot: { novelty_problem: 10, novelty_method: 10, novelty_combo: 10, feasibility: 70 } }
    expect(recomputeTotal(other)).not.toBe(report.total)
  })
})
