/**
 * 状态与门控族工具（v1.2 §15.1 的落地，名字来自 `tools/names.ts` 契约）。
 *
 * 本行是 `projectState` 服务的**消费者**，因此组合文件里必须与
 * `cv-agent-dsh/state` 同处一个 `isolate: { projectState: true }` 的 group。
 *
 * 五个工具全部走真实 `ToolRuntime` 注册与执行管线：
 * 参数校验、output schema 校验、失败结果的 `isError` 形状都由 dsh 保证，
 * 模型看到的是「哪个参数不合法」或「为什么没推进」，而不是堆栈。
 *
 * @module cv-agent-dsh/state-tools
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "cvagent-state-tools";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//# sourceMappingURL=tools.d.ts.map