/**
 * PowerShell 脚本编码护栏（L1 教训的防回归）。
 *
 * ## 为什么需要这条测试
 *
 * 2026-09-17 实测：`scripts/start-dsh-web.ps1` **无法启动**，根因不是逻辑错误，
 * 而是**编码**——文件是 UTF-8 **无 BOM**，而部署环境的 shell 是
 * **Windows PowerShell 5.1**（`$PSVersionTable.PSVersion = 5.1.26100`）。
 *
 * PS 5.1 读取无 BOM 的 `.ps1` 时按 ANSI/GBK 解码：中文注释与提示串变乱码
 * （`代理端口` → `浠ｇ悊绔彛`），乱码字节会吃掉字符串引号，**解析期直接报错**——
 * 脚本一行都不会执行，而且报错信息指向乱码位置，极难定位。
 *
 * 因此规则很简单：**含非 ASCII 的 .ps1 必须带 UTF-8 BOM**。
 * 本测试把这条规则钉住，避免以后重写脚本时又丢掉 BOM。
 *
 * （顺带一条同源教训：`scripts/*.mjs` 是 Node 读的，Node 一律按 UTF-8 解码，
 * 所以它们**不需要**也不能靠 BOM 兜底——这类问题只影响 PowerShell。）
 */
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const SKIP_DIRS = new Set(['node_modules', '.pnpm', '.pnpm-home', '.pnpm-store', 'lib', 'dist', '.git', 'data'])

async function findPowerShellScripts(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.dsh') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await findPowerShellScripts(full, found)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ps1')) {
      found.push(full)
    }
  }
  return found
}

describe('PowerShell 脚本编码（PS 5.1 + 中文 = 必须带 UTF-8 BOM）', () => {
  it('所有 .ps1：含非 ASCII 就必须有 BOM，否则 PS 5.1 解析失败', async () => {
    const scripts = await findPowerShellScripts(REPO_ROOT)
    expect(scripts.length).toBeGreaterThan(0) // 至少要有启动脚本，否则说明目录扫描坏了

    const offenders = []
    for (const path of scripts) {
      const bytes = await readFile(path)
      const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      const text = bytes.toString('utf8')
      const hasNonAscii = /[^\x00-\x7F]/.test(text)
      if (hasNonAscii && !hasBom) {
        offenders.push(`${relative(REPO_ROOT, path)}（含中文但缺 BOM）`)
      }
    }
    expect(offenders, `以下脚本在 Windows PowerShell 5.1 下会解析失败：\n${offenders.join('\n')}`).toEqual([])
  })

  it('启动脚本存在且覆盖了必需的前置注入（代理 / 密钥 / skill 根）', async () => {
    const path = join(REPO_ROOT, 'scripts', 'start-dsh-web.ps1')
    const text = await readFile(path, 'utf8')
    // 这几项漏掉任何一个，宿主都不会报错，只会"工具静默消失"——所以逐项钉住
    for (const required of [
      'NODE_USE_ENV_PROXY',
      'NO_PROXY',
      'aliyuncs.com', // MinerU 上传域（E26）
      'openxlab.org.cn', // MinerU 产物 zip 域（E26）
      'CV_PROJECT_SKILLS_DIR',
      'CV_PLUGIN_SKILLS_DIR',
      'ASTA_API_KEY',
    ]) {
      expect(text, `启动脚本缺少 ${required}`).toContain(required)
    }
  })
})
