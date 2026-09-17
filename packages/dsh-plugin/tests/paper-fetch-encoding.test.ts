/**
 * paper-fetch 的 **UTF-8 输出守卫**（E34 的守卫测试）。
 *
 * ## 事故
 *
 * 批量下载 34 篇 PDF 时，脚本在网上把结果全取回来之后，**死在"写出 JSON 信封"这一步**：
 *
 *     {'ok': false, 'error': {'code': 'internal_error',
 *      'message': "'gbk' codec can't encode character '\\u0142' in position 10902:
 *                  illegal multibyte sequence"}}
 *
 * 一个结果都没落盘 —— 前面的网络工作全部白干（退出码 4）。
 *
 * ## 机理
 *
 * `fetch.py` 用 `ensure_ascii=False` 输出 JSON（**这是对的**：否则中文会被转义成
 * `\uXXXX`）。但 Python 在 Windows 上按 locale 编码（cp936/GBK）写 stdout，于是作者名/
 * 标题里只要出现**一个**非 GBK 字符（波兰语 `ł`、土耳其语 `ı` 等），整个信封就写不出去。
 *
 * ## 为什么必须由测试守
 *
 * 上游 0.15.1 **没有修**这个 bug（它只是 try/except 兜住、返回 internal_error，结果照样丢）。
 * 我们的补丁位于**第三方 vendored 文件**里，替换/升级上游时会**被整体覆盖**——没有守卫
 * 就会静默复发，而且复发时的表现是"看起来跑完了、其实什么都没拿到"，极难察觉。
 *
 * ## 两道检查
 *
 * 1. **补丁存在性**：`skills/paper-fetch/scripts/fetch.py` 必须在流被使用之前
 *    `reconfigure(encoding="utf-8")`。
 * 2. **调用点提示**：`scripts/fetch-fulltext.mjs` 打印给操作者的命令必须带 UTF-8
 *    环境变量（操作者照着打印的命令直接跑，漏了就等于没修）。
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const REPO_ROOT = join(PKG_ROOT, '..', '..')

const FETCH_PY = join(PKG_ROOT, 'skills', 'paper-fetch', 'scripts', 'fetch.py')
const BRIDGE = join(REPO_ROOT, 'scripts', 'fetch-fulltext.mjs')

describe('paper-fetch 输出编码（E34）', () => {
  it('vendored fetch.py 必须把 stdout/stderr 强制为 UTF-8', async () => {
    const source = await readFile(FETCH_PY, 'utf8')

    // 补丁形态：对 sys.stdout / sys.stderr 调 reconfigure(encoding="utf-8")
    expect(
      /reconfigure\(\s*encoding=["']utf-8["']/.test(source),
      'fetch.py 里找不到 stdout/stderr 的 UTF-8 reconfigure —— 上游替换文件时把补丁弄丢了，'
      + '后果是作者名含非 GBK 字符时整批下载结果全部丢失（E34）。',
    ).toBe(true)

    // 两个流都要覆盖：只修 stdout 的话，stderr 的 NDJSON 进度仍会炸
    const reconfigureCalls = source.match(/reconfigure\(\s*encoding=["']utf-8["']/g) ?? []
    expect(
      reconfigureCalls.length,
      'reconfigure 只覆盖了一个流（stdout/stderr 都要）',
    ).toBeGreaterThanOrEqual(1)

    // 必须是"任一失败都不致命"的写法：非标准流（测试替身）不应让脚本挂掉
    expect(
      /except\s*\(AttributeError,\s*ValueError\)/.test(source) || /except\s+AttributeError/.test(source),
      'reconfigure 缺少 AttributeError/ValueError 兜底：非标准流下会抛异常',
    ).toBe(true)
  })

  it('fetch-fulltext 桥打印的命令必须带 UTF-8 环境变量', async () => {
    const source = await readFile(BRIDGE, 'utf8')
    const hintBlock = source.match(/请执行[\s\S]{0,1200}?--ingest[^\n]*\n/)?.[0] ?? ''

    expect(hintBlock, '没找到 fetch-fulltext.mjs 里打印给操作者的命令块').not.toBe('')
    expect(
      hintBlock.includes('PYTHONUTF8=1'),
      '打印的命令缺 PYTHONUTF8=1 —— 操作者照抄就会重现 E34 的编码崩溃',
    ).toBe(true)
    expect(
      hintBlock.includes('PYTHONIOENCODING'),
      '打印的命令缺 PYTHONIOENCODING —— 与 PYTHONUTF8 一起给才稳（不同解释器/版本生效点不同）',
    ).toBe(true)
  })

  it('arXiv 专用通道存在且不再依赖被 406 拦截的 https://arxiv.org', async () => {
    const source = await readFile(join(REPO_ROOT, 'scripts', 'fetch-arxiv-pdf.mjs'), 'utf8')

    // 本机实测：https://arxiv.org/pdf/<id> 一律 406，http://export.arxiv.org 才通
    expect(
      source.includes('http://export.arxiv.org/pdf/'),
      'arXiv 通道脚本必须以 export.arxiv.org 的 http 通道为主路径（https 在本机被拦）',
    ).toBe(true)
  })
})
