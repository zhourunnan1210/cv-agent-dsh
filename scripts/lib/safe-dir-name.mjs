/**
 * markdown 落盘目录名的**唯一实现**（batch-parse.mjs 与修复脚本共用）。
 *
 * 规则（E24 的完整版）：
 * - DOI 里的 `/` 保留（既有布局 `markdown/10.1007/xxx/full.md` 不动）；
 * - Windows 非法字符 `<>:"|?*` 与控制字符替换为 `_`（`local:` 前缀里的 `:` 是
 *   L1 实测的 ENOENT 元凶）；
 * - 每段截断 100 字符（避免 MAX_PATH），**并去掉段尾的空格与点**——
 *   实测：截断正好落在空格上会产生「尾随空格目录名」，Node 的 statSync 能读、
 *   PowerShell/资源管理器读不到（`Get-ChildItem -Recurse` 直接报路径不存在），
 *   属于「检查全绿、别处打不开」的隐藏故障。
 */

export function safeDirName(paperId) {
  return paperId
    .split('/')
    .map((segment) => segment
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .slice(0, 100)
      .replace(/[ .]+$/, ''))
    .join('/')
}

/** 旧规则（截断后未去尾随空格/点）——仅供修复脚本识别历史目录。 */
export function legacyDirName(paperId) {
  return paperId
    .split('/')
    .map((segment) => segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_').slice(0, 100))
    .join('/')
}
