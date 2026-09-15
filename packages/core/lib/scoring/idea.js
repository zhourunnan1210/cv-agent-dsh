/**
 * Idea 决策层的类型契约（平台无关）。
 *
 * 设计依据：v1.2 文档 §6、§10、§18.4。
 *
 * 算法本身（向量检索 + 组合判定 + 四维加权）在 Phase 3 实现；
 * 本文件先冻结**输入输出契约**，因为它是工具面（§15.4）与材料包（§8.1）
 * 共同依赖的部分，改动代价最高。
 */
/**
 * 判断子代理返回的结构化结果是否为「需要授权」。
 *
 * 主 Agent 在收到子代理结果后应先过这个判断，再决定是继续还是走门控。
 */
export function isNeedsAuthorization(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return candidate.status === 'needs_authorization' && typeof candidate.action === 'string' && typeof candidate.reason === 'string';
}
//# sourceMappingURL=idea.js.map