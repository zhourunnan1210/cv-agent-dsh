/**
 * 定位 dsh 安装位置（**不要在代码里写死 `C:/Users/...`**）。
 *
 * ## 为什么需要这个文件
 *
 * 这个仓库的插件跑在 dsh 宿主里，测试与体检脚本需要加载 dsh **自己那份**
 * `@deepseek-ai/dsh-tools` / `dsh-system-prompt` / `cordis`（和宿主进程用的是同一份，
 * 模块身份要对得上，否则 Cordis 的 Context/Service 会认不出彼此）。
 *
 * 原来这些路径被写死成 `C:/Users/Admin/AppData/Roaming/npm/node_modules/...`——
 * 那是**开发机**的全局安装位置。开源后别人 clone 下来必然跑不起来，
 * 而且这种写死会让人以为是"这个项目只能在某台机器上跑"。
 *
 * ## 解析顺序
 *
 * 1. `DSH_ROOT` 环境变量（显式指定，CI 与非常规安装用这个）
 * 2. 仓库本地的 `node_modules`（把 dsh 装成普通依赖时）
 * 3. 全局 npm root（`npm root -g`，或按平台惯例推导）
 *
 * 三条都不通就**明确报错**，并告诉使用者两条出路——而不是让后续代码
 * 抛一个看不懂的 `MODULE_NOT_FOUND`。
 *
 * @module cv-agent-dsh/dsh-root
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

/** dsh 的包名（查找时以它为准）。 */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** 解析结果缓存（同一进程里只算一次；`npm root -g` 要几百毫秒）。 */
let cached

/**
 * 按平台惯例猜全局 npm root（不 spawn 进程的兜底）。
 *
 * `npm root -g` 是最准的，但它要 spawn 一个 node 进程——在受限环境里可能被拦。
 * 这里给的是**惯例位置**，命中不了就返回 undefined，交给上层报错。
 *
 * @returns 全局 node_modules 路径；猜不出时 undefined。
 */
function guessGlobalRoot() {
  const fromEnv = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX
  if (fromEnv !== undefined && fromEnv !== '') return join(fromEnv, 'node_modules')

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData !== undefined && appData !== '') return join(appData, 'npm', 'node_modules')
    return undefined
  }
  // POSIX：官方安装器装到 /usr/local，包管理器装到 /usr
  return '/usr/local/lib/node_modules'
}

/**
 * 问 npm 要全局 root。
 *
 * @returns 全局 node_modules 路径；npm 不可用或超时时 undefined。
 */
function npmGlobalRoot() {
  for (const command of ['npm', 'npm.cmd']) {
    try {
      const output = execFileSync(command, ['root', '-g'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (output !== '' && existsSync(output)) return output
    } catch {
      // npm 不在 PATH、或沙箱拦了 spawn——都退回惯例位置
    }
  }
  return undefined
}

/** 判断某个目录下是否真有 dsh 这个包。 */
function looksLikeDshPackage(dir) {
  return dir !== undefined && existsSync(join(dir, 'package.json'))
}

/**
 * 从仓库本地 node_modules 里找 dsh。
 *
 * 试着从几个可能的起点解析：仓库根、`packages/dsh-plugin`。
 * 装成普通依赖时走这条。
 *
 * @returns dsh 包目录；本地没有时 undefined。
 */
function localDshPackage() {
  for (const specifier of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-tools/package.json']) {
    try {
      const require = createRequire(import.meta.url)
      const resolved = require.resolve(specifier)
      if (specifier.includes('/dsh/')) return dirname(resolved)
      // 解析到的是 dsh-tools：它的上一级是 @deepseek-ai，再上一级是 node_modules
      const nodeModules = dirname(dirname(resolved))
      const candidate = join(nodeModules, DSH_PACKAGE)
      if (looksLikeDshPackage(candidate)) return candidate
    } catch {
      // 本地没装，试下一个
    }
  }
  return undefined
}

/**
 * dsh 包目录（绝对路径）。
 *
 * @returns 形如 `<...>/node_modules/@deepseek-ai/dsh` 的路径。
 * @throws 三条路都不通时抛错，错误信息里给出两条可执行的出路。
 */
export function resolveDshPackage() {
  if (cached !== undefined) return cached

  const fromEnv = process.env.DSH_ROOT
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!looksLikeDshPackage(fromEnv)) {
      throw new Error(`DSH_ROOT 指向的目录里没有 package.json：${fromEnv}`)
    }
    cached = fromEnv
    return cached
  }

  const local = localDshPackage()
  if (local !== undefined) {
    cached = local
    return cached
  }

  const globalRoot = npmGlobalRoot() ?? guessGlobalRoot()
  const fromGlobal = globalRoot === undefined ? undefined : join(globalRoot, DSH_PACKAGE)
  if (looksLikeDshPackage(fromGlobal)) {
    cached = fromGlobal
    return cached
  }

  throw new Error(
    '找不到 dsh 安装位置。测试与体检脚本需要 dsh 自己那份 @deepseek-ai/* 依赖\n'
    + '（模块身份必须与宿主进程一致）。两条出路：\n'
    + '  1. 全局装一个：npm i -g @deepseek-ai/dsh\n'
    + '  2. 或显式告诉本仓库它在哪：DSH_ROOT=/path/to/node_modules/@deepseek-ai/dsh\n'
    + `已尝试：$DSH_ROOT(未设) → 仓库本地 node_modules → 全局 root(${globalRoot ?? '推导失败'})`,
  )
}

/**
 * dsh 的 `node_modules` 目录（带结尾分隔符）。
 *
 * 测试里用它当 `createRequire` 的基准去解析 `@deepseek-ai/dsh-tools` 等。
 *
 * @returns 形如 `<...>/@deepseek-ai/dsh/node_modules/` 的路径。
 */
export function resolveDshModules() {
  return join(resolveDshPackage(), 'node_modules') + (process.platform === 'win32' ? '\\' : '/')
}
