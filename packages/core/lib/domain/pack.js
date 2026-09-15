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
/** 格式化 pack 引用。 */
export function formatPackRef(ref) {
    return `${ref.pack_id}@${ref.version}`;
}
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
export function freezeDomainPack(draft, reviewer, now) {
    if (reviewer.trim() === '') {
        throw new Error('freezeDomainPack: 评审人不可为空；Domain Pack 的人工评审在任何模式下都不可跳过（v1.2 §3.4.4）');
    }
    return { ...draft, frozen_by: reviewer, frozen_at: now };
}
//# sourceMappingURL=pack.js.map