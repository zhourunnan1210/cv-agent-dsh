/**
 * 领域包族工具（P3-5）：`cvagent_domain_bootstrap` / `_freeze` / `_propose_revision` / `_bind`。
 *
 * 这四件工具把 Domain Pack 的**生命周期**从脚本搬进会话，并且把治理规则做进工具面：
 *
 * - `bootstrap`：从当前知识库派生草案落盘（可反复跑，草案不是权威）；
 * - `freeze`：**必须带评审人签名**（`reviewer` 参数）才冻结；已存在同版本则拒绝（改 pack 必须升版本）；
 * - `propose_revision`：基于已冻结版本 + 当前知识库派生**新版本**草案，并给出差异摘要——
 *   评审人看的是"改了什么"，而不是一份全新的 pack；
 * - `bind`：把项目绑定到某个已冻结版本（旧项目仍绑旧版本，这是版本化的意义）。
 *
 * 逻辑全在 `./pack-builder.js`（与 `scripts/bootstrap-pack.mjs` / `freeze-pack.mjs` 同源），
 * 本文件只负责工具契约与 I/O。
 *
 * @module cv-agent-dsh/domain-tools
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import type { FrozenDomainPack } from '@cv-research/core'

import { DOMAIN_TOOLS } from '../tools/names.js'
import type { KbService } from '../kb/service.js'
import { bumpVersion, derivePackDraft, diffPacks, freezeDraft, summarizeDraft, validatePackDraft } from './pack-builder.js'

export const name = 'cvagent-domain-tools'
export const inject = ['kb', 'tools']

/** 插件配置。 */
export interface Config {
  /** pack 落盘目录。 */
  packDir?: string
  /** 缺省 pack 标识。 */
  packId?: string
  /** 缺省版本。 */
  version?: string
  /** 项目标识（绑定用）。 */
  projectId?: string
  /** 领域命名空间（ext 的包键）。 */
  packNamespace?: string
}

/** 解析默认值（E19：不带 config 的行，默认值必须显式落定）。 */
export function resolveDomainToolsConfig(config: Config | undefined): Required<Config> {
  const packId = config?.packId ?? 'deepfake-detection'
  return {
    packDir: config?.packDir ?? 'data/packs',
    packId,
    version: config?.version ?? '0.1',
    projectId: config?.projectId ?? 'cv-research-default',
    // ext 的包键**缺省等于 pack_id**（勘误 §7.5.2 的命名空间约定）。写死成
    // 某个具体领域名会让"换 pack_id 就派生出空 schema_ext"这种故障悄无声息地发生。
    packNamespace: config?.packNamespace ?? packId,
  }
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context, config: Config = {}): void {
  const kb: KbService = ctx.kb
  const toolsRuntime = ctx.tools
  const options = resolveDomainToolsConfig(config)

  const draftPath = (packId: string, version: string): string => resolve(options.packDir, `${packId}-${version}.draft.json`)
  const frozenPath = (packId: string, version: string): string => resolve(options.packDir, `${packId}-${version}.json`)

  /**
   * 派生草案。
   *
   * ⚠️ `packId` / `version` 必须**跟着调用方的参数走**，不能读配置里的默认值——
   * 否则 `bootstrap --version 0.2` 会写出「文件叫 0.2、内容 ref 是 0.1」的草案，
   * 后续冻结会把它注册成 0.1 并覆盖旧登记（这条在测试里被抓到过）。
   */
  const derive = (packId: string, version: string, generatedBy: string) => derivePackDraft(
    { papers: kb.listPapersForPack(), extractions: kb.listExtractions(), entries: kb.listEntries() },
    { packId, version, generatedBy, packNamespace: options.packNamespace },
  )

  const readDraft = async (packId: string, version: string): Promise<Record<string, unknown>> => {
    const path = draftPath(packId, version)
    if (!existsSync(path)) {
      throw new Error(`找不到草案 ${path}：先跑 cvagent_domain_bootstrap 生成草案（评审的是草案，不是想象）`)
    }
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  }

  // ── bootstrap ────────────────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: DOMAIN_TOOLS.bootstrap,
    description:
      '从当前知识库派生 Domain Pack **草案**并落盘（不冻结）。'
      + '派生是确定性的：扩展字段来自四库条目真实用过的 ext 键、benchmarks/metrics 来自提取频次、'
      + '术语与改写组来自领域词典、权重来自 v1.2 §18.4 默认值。'
      + '可反复运行覆盖草案；草案**不是权威**，冻结后才产生版本。',
    parameters: {
      pack_id: { type: 'string', description: `pack 标识（默认 ${options.packId}）` },
      version: { type: 'string', description: `版本（默认 ${options.version}）` },
      notes: { type: 'string', description: '给评审人看的说明（会写进草案的 generated_by 备注）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draft_path: { type: 'string', required: true },
          summary_json: { type: 'string', required: true, description: '草案关键数字（各库字段、benchmark/术语数、权重与阈值）' },
          provenance_json: { type: 'string', required: true, description: '派生依据：纳入/排除的 benchmark、字段来源、高频 baseline' },
          contract_problems: { type: 'array', required: true, items: { type: 'string' }, description: '契约校验未通过项（草案阶段允许非空，但冻结会被拒）' },
          contract_notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const packId = args.pack_id === undefined ? options.packId : String(args.pack_id)
      const version = args.version === undefined ? options.version : String(args.version)
      const derived = derive(packId, version, 'cvagent_domain_bootstrap（从知识库实测派生）')
      if (args.notes !== undefined) {
        derived.draft.generated_by = `${String(derived.draft.generated_by)}；备注：${String(args.notes)}`
      }
      const path = draftPath(packId, version)
      await mkdir(options.packDir, { recursive: true })
      await writeFile(path, `${JSON.stringify(derived.draft, null, 2)}\n`)
      // 用落盘后的草案做校验：校验的必须是"评审人将要看的那份文件"
      const validation = validatePackDraft(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)
      return {
        draft_path: path,
        summary_json: JSON.stringify(summarizeDraft(derived.draft)),
        provenance_json: JSON.stringify(derived.provenance),
        contract_problems: [...validation.problems],
        contract_notes: [...validation.notes],
      }
    },
  }))

  // ── freeze ───────────────────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: DOMAIN_TOOLS.freeze,
    description:
      '冻结 Domain Pack（**人工评审门**）：必须提供评审人签名；契约校验不通过或同版本已冻结都会被拒。'
      + '冻结产物写 `<packDir>/<pack_id>-<version>.json`，并登记进 domain_packs 注册表。'
      + '改 pack 必须走 cvagent_domain_propose_revision 升版本——旧项目仍绑旧版本。',
    parameters: {
      reviewer: { type: 'string', required: true, description: '评审人签名（谁审的写谁；空签名等同跳过评审，Core 会直接拒绝）' },
      pack_id: { type: 'string', description: `pack 标识（默认 ${options.packId}）` },
      version: { type: 'string', description: `要冻结的版本（默认 ${options.version}，必须已有对应草案）` },
      bind: { type: 'boolean', description: '同时把当前项目绑定到该版本（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frozen_path: { type: 'string', required: true },
          frozen_by: { type: 'string', required: true },
          frozen_at: { type: 'string', required: true },
          content_hash: { type: 'string', required: true, description: '冻结内容哈希（前 16 位），供审计比对' },
          pack_ref: { type: 'string', required: true },
          bound_project: { type: 'string', description: '绑定的项目 ID；未绑定时为空串' },
          registered_packs: { type: 'number', required: true, description: '注册表中 pack 条目数' },
          contract_notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const packId = args.pack_id === undefined ? options.packId : String(args.pack_id)
      const version = args.version === undefined ? options.version : String(args.version)
      const reviewer = String(args.reviewer).trim()
      if (reviewer === '') throw new Error('reviewer 不可为空：空签名等同于跳过人工评审（v1.2 §3.4.4 不可豁免）')

      const target = frozenPath(packId, version)
      if (existsSync(target)) {
        throw new Error(
          `版本 ${version} 已冻结（${target} 已存在）。修改已冻结的 pack 必须升版本：`
          + '先 cvagent_domain_propose_revision 派生新版本草案，再冻结新版本。',
        )
      }
      const draft = await readDraft(packId, version)
      // freezeDraft 内部会再校验一次（校验不通过直接抛错），这里不重复实现规则
      const { frozen, contentHash } = freezeDraft(draft, reviewer, new Date().toISOString())
      const validation = validatePackDraft(draft)
      await mkdir(options.packDir, { recursive: true })
      await writeFile(target, `${JSON.stringify(frozen, null, 2)}\n`)
      kb.registerDomainPack(frozen, target)
      if (args.bind === true) kb.bindProjectPack(options.projectId, frozen.ref.pack_id, frozen.ref.version)
      return {
        frozen_path: target,
        frozen_by: frozen.frozen_by,
        frozen_at: frozen.frozen_at,
        content_hash: contentHash,
        pack_ref: `${frozen.ref.pack_id}@${frozen.ref.version}`,
        bound_project: args.bind === true ? options.projectId : '',
        registered_packs: kb.listDomainPacks().length,
        contract_notes: [...validation.notes],
      }
    },
  }))

  // ── propose_revision ─────────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: DOMAIN_TOOLS.proposeRevision,
    description:
      '基于某个**已冻结**版本 + 当前知识库，派生**新版本**草案并给出差异摘要。'
      + '这是修改 pack 的唯一合法入口：冻结产物不可覆盖，评审人看差异（改了什么）比看整份新 pack 有效得多。',
    parameters: {
      pack_id: { type: 'string', description: `pack 标识（默认 ${options.packId}）` },
      based_on_version: { type: 'string', description: `基于哪个已冻结版本（默认当前已登记的最新版本）` },
      notes: { type: 'string', description: '本次修订的动机说明（写进草案备注，呈递给评审人）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          base_version: { type: 'string', required: true },
          new_version: { type: 'string', required: true },
          draft_path: { type: 'string', required: true },
          changes: { type: 'array', required: true, items: { type: 'string' }, description: '与基准版本的差异（字段/权重/纳入排除/术语）' },
          change_count: { type: 'number', required: true },
          contract_problems: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const packId = args.pack_id === undefined ? options.packId : String(args.pack_id)
      const registered = kb.listDomainPacks().filter((pack) => pack.pack_id === packId)
      const requested = args.based_on_version === undefined ? undefined : String(args.based_on_version)
      const base = requested === undefined
        ? registered[registered.length - 1]
        : registered.find((pack) => pack.version === requested)
      if (base === undefined) {
        throw new Error(
          registered.length === 0
            ? `pack ${packId} 还没有任何已冻结版本：先 cvagent_domain_bootstrap + cvagent_domain_freeze`
            : `pack ${packId} 没有版本 ${requested}（已登记：${registered.map((pack) => pack.version).join(', ')}）`,
        )
      }
      const previous = JSON.parse(await readFile(base.pack_path, 'utf8')) as Record<string, unknown>
      const newVersion = bumpVersion(base.version)
      const derived = derive(packId, newVersion, `cvagent_domain_propose_revision（基于 ${packId}@${base.version}）`)
      if (args.notes !== undefined) {
        derived.draft.generated_by = `${String(derived.draft.generated_by)}；修订动机：${String(args.notes)}`
      }
      const changes = diffPacks(previous, derived.draft)
      const path = draftPath(packId, newVersion)
      await mkdir(options.packDir, { recursive: true })
      await writeFile(path, `${JSON.stringify(derived.draft, null, 2)}\n`)
      const validation = validatePackDraft(derived.draft)
      return {
        base_version: base.version,
        new_version: newVersion,
        draft_path: path,
        changes,
        change_count: changes.length,
        contract_problems: [...validation.problems],
      }
    },
  }))

  // ── bind ─────────────────────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: DOMAIN_TOOLS.bind,
    description:
      '把当前项目绑定到某个**已冻结**的 pack 版本。绑定是项目级决定（旧项目仍绑旧版本），'
      + '打分与检索口径都跟随绑定版本——所以换绑要先说清为什么。',
    parameters: {
      pack_id: { type: 'string', description: `pack 标识（默认 ${options.packId}）` },
      version: { type: 'string', description: `版本（默认当前已登记的最新版本）` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_id: { type: 'string', required: true },
          pack_ref: { type: 'string', required: true },
          frozen_by: { type: 'string', required: true, description: '该版本的评审人（绑定即接受这一版的口径）' },
          frozen_at: { type: 'string', required: true },
          previous_binding: { type: 'string', description: '换绑前的绑定（形如 pack@version）；首次绑定为空串' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const packId = args.pack_id === undefined ? options.packId : String(args.pack_id)
      const registered = kb.listDomainPacks().filter((pack) => pack.pack_id === packId)
      const requested = args.version === undefined ? undefined : String(args.version)
      const target = requested === undefined
        ? registered[registered.length - 1]
        : registered.find((pack) => pack.version === requested)
      if (target === undefined) {
        throw new Error(
          `找不到已冻结的 ${packId}${requested === undefined ? '' : `@${requested}`}：`
          + `已登记版本 [${registered.map((pack) => pack.version).join(', ') || '空'}]。绑定只接受已冻结版本。`,
        )
      }
      const previous = kb.getProjectPackBinding(options.projectId)
      kb.bindProjectPack(options.projectId, target.pack_id, target.version)
      return {
        project_id: options.projectId,
        pack_ref: `${target.pack_id}@${target.version}`,
        frozen_by: target.frozen_by,
        frozen_at: target.frozen_at,
        previous_binding: previous === undefined ? '' : `${previous.pack_id}@${previous.version}`,
      }
    },
  }))
}

/** 供测试导出：冻结产物类型别名（避免测试里重复 import core）。 */
export type { FrozenDomainPack }
