/**
 * 三库基础 schema（平台无关）。
 *
 * 设计依据：v1.2 文档 §5.4 与 §17.1。
 *
 * 关键约定（对应 v1.2 §3.4 的 Domain Pack 机制）：
 * 三库条目 = **基础字段** + **领域扩展字段**。基础字段跨领域通用，写死在这里；
 * 领域扩展字段（如 Deepfake 的 `detection_target`、`paradigm`）一律走 `ext` 列，
 * 由 Domain Pack 的 `schema-ext.yml` 声明。因此本文件**不得**出现
 * `face_swap`、`FF++` 之类的领域字面量（v1.2 原则六）。
 */
/** 所有库名，供遍历与校验使用。 */
export const STORE_NAMES = ['problems', 'methods', 'innovations'];
//# sourceMappingURL=kb.js.map