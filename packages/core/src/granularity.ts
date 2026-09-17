/**
 * 字段粒度契约：**Reader 提取与 Generator 生成共用同一份**（整合设计 v1.0 §4.2）。
 *
 * ## 为什么必须共用一份
 *
 * 撞车与打分的本质是「拿 idea 的某个字段」去比「论文库里的某个字段」。
 * 两边粒度不一致，比较就失真——而这不是假设，是实测过的：
 *
 * | 问题 | 实测 |
 * | --- | --- |
 * | 一端短、一端长 | `lexicalSimilarity` 按并集归一化，idea 写到 651 字时，即使把条目原文**一字不差**抄进去，相似度也只有 **0.1785** → `novelty` 给 82 分 |
 * | 生成端零约束 | `cvagent_idea_generate` 的 prompt 与 schema **对长度与实质一个字都没提**，模型天然产出短句，于是拿十几个字去比一百多字 |
 *
 * 所以字数要求不能只写在 prompt 里各自一份（那还是两份实现），
 * 必须**在 core 里定义一次**，两端渲染同一份。
 *
 * ## 与 E32/E33 的关系
 *
 * 同一条纪律：**同一个事实只能有一处权威**。E32 是"白名单与 prompt 各写一份"，
 * E33 是"契约镜像写错语义"，这里是"两端的粒度要求各写一份"。
 *
 * @module @cv-research/core/granularity
 */

/** 一条字段粒度要求。 */
export interface GranularitySpec {
  /** 最少字数（不含空白；中文按字符计）。 */
  readonly min: number
  /** 最多字数。 */
  readonly max: number
  /** 内容要求（渲染进 prompt 的那句话）。 */
  readonly requirement: string
}

/**
 * 粒度契约（**唯一权威**）。
 *
 * 键名与两端的字段名对齐：`problem_statement` / `method_summary` 是提取侧，
 * `problem` / `method` 是 idea 侧，`module_description` / `innovation` / `limitation` 两侧共用。
 */
export const GRANULARITY = {
  /** 问题陈述（两侧同粒度）。 */
  problem: { min: 150, max: 300, requirement: '现象 + 现有方法为何不够 + 核心挑战' },
  /** 方法叙述（整体）。 */
  method: { min: 500, max: 800, requirement: '整体方法叙述：各模块是什么、彼此什么关系' },
  /** 单个模块的描述（★ 对齐单元：撞车就比这个）。 */
  module_description: { min: 60, max: 400, requirement: '输入是什么 / 做了什么操作 / 起什么作用' },
  /** 一条创新点。 */
  innovation: { min: 60, max: 120, requirement: '必须能命名到「模块 / 损失 / 数据集 / 协议」' },
  /** 一条局限或风险。 */
  limitation: { min: 40, max: 100, requirement: '尽量带数字与成立条件' },
} as const satisfies Record<string, GranularitySpec>

export type GranularityField = keyof typeof GRANULARITY

/** 计长：去掉空白后计字符数（空白混入会让"看起来够长"骗过判据）。 */
export function countChars(text: string): number {
  return text.replace(/\s+/g, '').length
}

/** 一条粒度偏差。 */
export interface GranularityViolation {
  readonly field: string
  readonly chars: number
  readonly min: number
  readonly max: number
  readonly kind: 'too_short' | 'too_long'
}

/**
 * 检查一段文本是否符合粒度契约（纯函数，两端与测试共用）。
 *
 * @param field - 契约里的字段名。
 * @param text - 待检查的文本。
 * @param label - 报告里显示的名字（如「模块 M2 的描述」）；缺省用字段名。
 * @returns 偏差；合规时为空数组。
 */
export function checkGranularity(
  field: GranularityField,
  text: string,
  label: string = field,
): GranularityViolation[] {
  const spec = GRANULARITY[field]
  const chars = countChars(text)
  if (chars < spec.min) return [{ field: label, chars, min: spec.min, max: spec.max, kind: 'too_short' }]
  if (chars > spec.max) return [{ field: label, chars, min: spec.min, max: spec.max, kind: 'too_long' }]
  return []
}

/** 批量检查（返回全部偏差，便于一次报清"哪几个字段不合规"）。 */
export function checkGranularityBatch(
  entries: readonly { field: GranularityField; text: string; label?: string }[],
): GranularityViolation[] {
  return entries.flatMap((entry) => checkGranularity(entry.field, entry.text, entry.label ?? entry.field))
}

/** 把偏差渲染成给模型看的一行说明（两端共用同一措辞）。 */
export function describeViolation(violation: GranularityViolation): string {
  const direction = violation.kind === 'too_short' ? '过短' : '过长'
  return `${violation.field}：${violation.chars} 字（要求 ${violation.min}–${violation.max} 字，${direction}）`
}
/**
 * 把粒度契约渲染成 prompt 片段（Reader 与 Generator 引用同一份）。
 *
 * @param fields - 只渲染这些字段；缺省渲染全部。
 * @returns 多行文本，可直接拼进 prompt。
 */
export function renderGranularityPrompt(fields?: readonly GranularityField[]): string {
  const keys = fields ?? (Object.keys(GRANULARITY) as GranularityField[])
  return keys
    .map((key) => `- ${key}：${GRANULARITY[key].min}–${GRANULARITY[key].max} 字，${GRANULARITY[key].requirement}`)
    .join('\n')
}
