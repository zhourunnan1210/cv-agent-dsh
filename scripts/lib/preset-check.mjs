/**
 * 预设组合的静态检查（可被 CLI 与测试共用）。
 *
 * 为什么必须有它（2026-09-17 的真实事故）：我把两个 isolate group 合并成一个时，
 * 忘了给发布 `ideaScore` 服务的行补 isolate 键。后果不是"少个功能"，而是
 * **整个 preset 挂载失败**——dsh 的 `mountPreset` 里有这段：
 *
 *     const leaked = leakedServices(agentCtx, fiber)
 *     if (leaked.length > 0) throw new Error('row(s) published process-global service(s) [...]')
 *
 * 于是宿主重启后 `cv-research` 直接不可用（会话里一个 cvagent 工具都没有），
 * 而报错只出现在宿主日志里。凡"一行坏掉就整份挂载失败"的机制，都必须有
 * **启动前的静态预检**——这份文件就是它。
 *
 * 检查项：
 * 1. 每行有 id 与 name；id 全局唯一；
 * 2. 行名可解析：`cordis:*`（内核构造）、`@deepseek-ai/*`（dsh 安装）、
 *    `cv-agent-dsh/*`（本包 exports 子路径——E21：exports 缺失同样会让挂载失败）；
 * 3. **发布服务的行必须落在声明了该服务 isolate 键的 group 内**（§4.4 / E10）；
 * 4. isolate 键与组内服务行互相呼应（拼错服务名也会被指出）。
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { basename, dirname, join } from 'node:path'

const DSH_ROOT = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'

/** 已知会发布 Cordis 服务的行：行名 → 服务名。新增服务行时必须在这里登记。 */
export const SERVICE_ROWS = {
  'cv-agent-dsh/state': 'projectState',
  'cv-agent-dsh/kb': 'kb',
  'cv-agent-dsh/idea-score': 'ideaScore',
}

const require = createRequire(DSH_ROOT + '/package.json')

/** 解析 YAML（用 dsh 自带的 yaml，避免为脚本新增依赖）。 */
async function parseYaml(text) {
  const yaml = await import(pathToFileURL(require.resolve('yaml')).href)
  // dsh 组合里有 `!!js` 自定义标签：js-yaml/yaml 不认识它，会告警并把值当字符串。
  // 这对本检查无影响（我们只看结构与行名，不求值）。
  const previousWarn = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('Unresolved tag')) return
    return previousWarn.call(process, warning, ...rest)
  }
  try {
    return yaml.parse(text, { merge: true })
  } finally {
    process.emitWarning = previousWarn
  }
}

/**
 * 检查一份预设组合。
 *
 * @param presetPath 预设文件路径。
 * @param options.packageJsonPath 本包 package.json（校验 exports 用），缺省自动探测。
 */
export async function checkPreset(presetPath, options = {}) {
  const root = await parseYaml(await readFile(presetPath, 'utf8'))
  const problems = []
  const notes = []

  // package.json 的定位：显式传入优先，其次**从 preset 位置往上找**（preset 就住在
  // `packages/dsh-plugin/presets/…` 里，所以 `../..` 就是那个包），最后才是相对 cwd 的
  // 常见路径。用 cwd 相对路径当默认值会在测试里炸（vitest 的 cwd 是包目录，不是仓库根）。
  const packageJsonPath = options.packageJsonPath
    ?? [
      join(dirname(presetPath), '..', '..', 'package.json'),
      'packages/dsh-plugin/package.json',
    ].find((candidate) => existsSync(candidate))
  if (packageJsonPath === undefined || !existsSync(packageJsonPath)) {
    throw new Error(`找不到本包 package.json（preset: ${presetPath}）——请用 options.packageJsonPath 显式指定`)
  }
  const ourExports = new Set(Object.keys(JSON.parse(await readFile(packageJsonPath, 'utf8')).exports ?? {}))

  let dshModules = new Set()
  try {
    dshModules = new Set(
      (await readdir(`${DSH_ROOT}/node_modules/@deepseek-ai`, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => `@deepseek-ai/${entry.name}`),
    )
  } catch {
    notes.push('无法枚举 dsh 安装的包，跳过 @deepseek-ai/* 的存在性检查')
  }
  const resolvesDshRow = (name) => dshModules.has(name.split('/').slice(0, 2).join('/'))

  const seenIds = new Set()
  let rowCount = 0
  const serviceRows = []

  function walk(rows, isolateKeys, insideGroup, path) {
    for (const row of rows ?? []) {
      rowCount += 1
      const where = `${path} > ${row?.id ?? '(无 id)'}`
      if (row?.id === undefined) problems.push(`${where}: 行缺少 id`)
      else if (seenIds.has(row.id)) problems.push(`${where}: 行 id 重复`)
      else seenIds.add(row.id)

      if (row?.name === undefined) {
        problems.push(`${where}: 行缺少 name`)
        continue
      }

      if (row.name !== 'cordis:group') {
        if (row.name.startsWith('cv-agent-dsh/')) {
          const sub = `./${row.name.slice('cv-agent-dsh/'.length)}`
          if (!ourExports.has(sub)) {
            problems.push(`${where}: 包 exports 里没有 ${sub}（E21：exports 缺失会让整份挂载失败）`)
          }
        } else if (row.name.startsWith('@deepseek-ai/')) {
          if (dshModules.size > 0 && !resolvesDshRow(row.name)) {
            problems.push(`${where}: dsh 安装里找不到 ${row.name}`)
          }
        } else if (!row.name.startsWith('link:')) {
          problems.push(`${where}: 无法识别的行名 ${row.name}`)
        }
      }

      const serviceName = SERVICE_ROWS[row.name]
      if (serviceName !== undefined) {
        serviceRows.push({ id: row.id, name: row.name, serviceName, where })
        if (!insideGroup) {
          problems.push(`${where}: 发布服务 ${serviceName} 的行不在 group 内（会落到进程全局 realm，挂载必失败）`)
        } else if (!isolateKeys.has(serviceName)) {
          problems.push(
            `${where}: 发布服务 ${serviceName}，但所在 group 的 isolate 没声明 ${serviceName}`
            + `（现有 keys=${[...isolateKeys].join(',') || '(空)'}）→ dsh 会以 `
            + `"published process-global service(s)" 拒绝整份挂载`,
          )
        }
      }

      if (Array.isArray(row.config)) {
        const merged = new Set([...isolateKeys, ...Object.keys(row.isolate ?? {})])
        walk(row.config, merged, true, where)
      }
    }
  }
  walk(root, new Set(), false, basename(presetPath))

  // 反向：isolate 声明了某服务，但组内没有对应的行（多半是服务行名拼错）
  function walkReverse(rows, path) {
    for (const row of rows ?? []) {
      if (!Array.isArray(row?.config)) continue
      for (const key of Object.keys(row.isolate ?? {})) {
        const expectedRowName = Object.entries(SERVICE_ROWS).find(([, service]) => service === key)?.[0]
        if (expectedRowName !== undefined && !row.config.some((child) => child?.name === expectedRowName)) {
          notes.push(`${path} > ${row.id}: isolate 声明了 ${key}，但组内没有发布它的行（${expectedRowName}）`)
        }
      }
      walkReverse(row.config, `${path} > ${row.id}`)
    }
  }
  walkReverse(root, basename(presetPath))

  return { rowCount, uniqueIds: seenIds.size, serviceRows, problems, notes }
}
