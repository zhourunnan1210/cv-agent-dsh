/**
 * Domain Pack 契约（平台无关）。
 *
 * 设计依据：v1.2 文档 §3.4 与 §18。
 *
 * Domain Pack 的职责是把一切「随细分领域变化」的内容从代码里赶出去
 * （原则六）：扩展字段、术语词典、benchmark 清单、实验约束、打分权重。
 * 本文件只描述**包的形状**与**冻结/绑定规则**，不含任何具体领域内容。
 *
 * 治理规则（v1.2 §3.4.4，本层以类型强制）：
 * - 人工评审不可跳过，任何模式下都不豁免；
 * - 冻结后生成版本号，项目绑定到具体版本；
 * - 修改产生新版本，旧项目仍绑旧版本。
 */
/** Domain Pack 的标识与版本。 */
export interface PackRef {
    /** 如 `deepfake-detection`。 */
    readonly pack_id: string;
    /** 如 `0.1`。 */
    readonly version: string;
}
/** 序列化形态：`deepfake-detection@0.1`。 */
export type PackRefString = `${string}@${string}`;
/** 格式化 pack 引用。 */
export declare function formatPackRef(ref: PackRef): PackRefString;
/**
 * schema 扩展字段的声明。
 *
 * 基础表结构不变，扩展字段走 `ext` JSON 列（v1.2 §17.2：
 * 查询以向量检索 + 全条目读取为主，很少按扩展字段过滤，
 * JSON 列避免 EAV 的 join 复杂度）。
 */
export type ExtensionFieldType = 'text' | 'enum' | 'number' | 'boolean';
/** 一个扩展字段的声明。 */
export interface ExtensionFieldSpec {
    readonly type: ExtensionFieldType;
    /** `type: 'enum'` 时的取值集合。 */
    readonly values?: readonly string[];
    /**
     * 提取指引，注入 Reader 子 Agent 的 prompt（v1.2 §18.3 的
     * `extraction_hint`）。
     */
    readonly extraction_hint?: string;
}
/** 按库名组织的扩展字段声明。 */
export type SchemaExtension = Readonly<Record<string, Readonly<Record<string, ExtensionFieldSpec>>>>;
/** 术语词典条目（v1.2 §18.2）。 */
export interface LexiconTerm {
    /** 规范形式，如 `face_swap`。 */
    readonly canonical: string;
    /** 同义词与缩写，用于检索扩展与 embedding 前归一化。 */
    readonly aliases: readonly string[];
}
/** 领域术语词典。 */
export interface Lexicon {
    readonly terms: readonly LexiconTerm[];
    /**
     * 检索关键词扩展组（v1.2 §18.2 的 `query_expansion`）：
     * 每组内任一词可互换，用于 Scout 的查询改写。
     */
    readonly query_expansion: readonly (readonly string[])[];
}
/** benchmark 与指标清单（v1.2 §18.5）。 */
export interface BenchmarkSpec {
    readonly name: string;
    readonly versions?: readonly string[];
    /** 指标口径，如「frame-level & video-level AUC」（v1.2 §7.5 第 5 项要求口径一致）。 */
    readonly metric_protocol?: string;
}
/** benchmark 与指标清单集合。 */
export interface Benchmarks {
    readonly benchmarks: readonly BenchmarkSpec[];
    readonly metrics: readonly string[];
    /** 评估协议，如 in_domain / cross_dataset / cross_manipulation。 */
    readonly required_protocols: readonly {
        readonly name: string;
        readonly description: string;
    }[];
}
/**
 * 已冻结的 Domain Pack。
 *
 * `frozen_by` / `frozen_at` 是**强制性字段**：没有人工评审签名的 pack
 * 在类型上就无法构造，这是 v1.2 §3.4.4「人工评审不可跳过」的类型级落实。
 */
export interface FrozenDomainPack {
    readonly ref: PackRef;
    /** 评审人标识。 */
    readonly frozen_by: string;
    readonly frozen_at: string;
    /** 生成该 pack 所用的种子论文 ID。 */
    readonly seed_papers: readonly string[];
    readonly schema_ext: SchemaExtension;
    readonly lexicon: Lexicon;
    readonly benchmarks: Benchmarks;
    /** 打分维度与权重（v1.2 §18.4）。 */
    readonly scoring: import('../scoring/idea.js').ScoringConfig;
}
/**
 * pack 草案：尚未评审冻结。
 *
 * 与 `FrozenDomainPack` 的区别仅在缺少评审签名，使
 * 「生成」与「冻结」在类型上不可混淆（v1.2 §3.4.3 的 Step 5 是强制 gate）。
 */
export type DomainPackDraft = Omit<FrozenDomainPack, 'frozen_by' | 'frozen_at'>;
/**
 * 冻结一个 pack 草案。
 *
 * 这是 Step 5 人工评审通过后的唯一合法转换路径。
 *
 * @param draft - 评审通过的草案。
 * @param reviewer - 评审人标识（不可为空）。
 * @param now - ISO 时间戳，注入以便测试。
 * @throws 当 `reviewer` 为空时 —— 空签名等同于跳过评审。
 */
export declare function freezeDomainPack(draft: DomainPackDraft, reviewer: string, now: string): FrozenDomainPack;
//# sourceMappingURL=pack.d.ts.map