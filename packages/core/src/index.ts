/**
 * @cv-research/core —— 平台无关核心逻辑。
 *
 * 本包**不得** import 任何 dsh / Cordis 模块（v1.2 §3.3 跨平台原则）。
 * dsh 适配集中在 `packages/dsh-plugin`；未来移植 Claude Code / Codex 时，
 * 新增对应适配包，本包零改动。
 *
 * @module @cv-research/core
 */

export * from './schema/kb.js'
export * from './schema/paper.js'
export * from './scoring/idea.js'
export * from './state/machine.js'
export * from './domain/pack.js'
