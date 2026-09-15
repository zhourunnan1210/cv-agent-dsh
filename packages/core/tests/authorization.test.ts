import { describe, expect, it } from 'vitest'

import {
  isNeedsAuthorization,
  type Authorization,
  type NeedsAuthorization,
} from '../src/scoring/idea.js'

/**
 * 勘误 §4.6（E15）契约测试。
 *
 * 主 Agent 收到子代理结果后必须先过 `isNeedsAuthorization`，才能区分
 * 「实验失败」（换方案）与「缺授权」（问用户）。这两条处置路径不同，
 * 误判会把需要授权的动作当成技术故障处理。
 */
describe('isNeedsAuthorization（勘误 §4.6 第 ④ 步的判定入口）', () => {
  const valid: NeedsAuthorization = {
    status: 'needs_authorization',
    action: 'launch_gpu_instance',
    reason: '跨数据集评估需要在 4090 上跑 6 小时，当前无授权',
    estimated_cost: { gpu_hours: 6 },
  }

  it('识别合法的补授权请求', () => {
    expect(isNeedsAuthorization(valid)).toBe(true)
  })

  it('识别不带成本预估的补授权请求', () => {
    expect(isNeedsAuthorization({ status: 'needs_authorization', action: 'call_billed_api', reason: '需要调用计费检索' })).toBe(true)
  })

  it('不把普通实验结果误判为补授权请求', () => {
    expect(isNeedsAuthorization({ status: 'completed', metrics: { AUC: 0.98 } })).toBe(false)
  })

  it('不把技术故障误判为补授权请求', () => {
    // 关键区分：失败结果不该被当成缺授权，否则会去问用户而不是换方案
    expect(isNeedsAuthorization({ status: 'failed', error: 'CUDA OOM' })).toBe(false)
  })

  it('拒绝缺字段的畸形载荷', () => {
    expect(isNeedsAuthorization({ status: 'needs_authorization' })).toBe(false)
    expect(isNeedsAuthorization({ status: 'needs_authorization', action: 'launch_gpu_instance' })).toBe(false)
    expect(isNeedsAuthorization({ action: 'launch_gpu_instance', reason: 'x' })).toBe(false)
  })

  it('拒绝非对象输入', () => {
    for (const value of [null, undefined, 'needs_authorization', 42, true, []]) {
      expect(isNeedsAuthorization(value)).toBe(false)
    }
  })

  it('空数组是对象但没有 status，应被拒绝', () => {
    expect(isNeedsAuthorization([])).toBe(false)
  })
})

describe('Authorization（勘误 §4.6 第 ① 步的产物）', () => {
  it('记录授权范围、授权人与预算上限', () => {
    const authorization: Authorization = {
      granted: ['launch_gpu_instance', 'call_billed_api'],
      granted_by: 'user-session-42',
      granted_at: '2026-09-15T10:00:00Z',
      budget: { gpu_hours: 72, ai4scholar_credits: 500 },
    }
    // 四类受限动作可组合；预算与 §20 的 budget.yml 字段对应
    expect(authorization.granted).toContain('launch_gpu_instance')
    expect(authorization.budget?.gpu_hours).toBe(72)
  })

  it('授权可为空集合（表示本次委派无任何受限动作）', () => {
    const authorization: Authorization = {
      granted: [],
      granted_by: 'user-session-42',
      granted_at: '2026-09-15T10:00:00Z',
    }
    expect(authorization.granted).toHaveLength(0)
  })
})
