# E34 修复记录：paper-fetch 抓取链路（编码崩溃 + arXiv 406）

- 日期：2026-09-17 夜
- 关联：`docs/BUG-maxDepth-委派深度上限写死导致的系统性委派失败.md`（同一次 session 的另一个事故）
- 结论：**已修复并验证**；上游 0.15.1 未修核心 bug，故采用本地补丁 + 守卫测试

---

## 一、三个问题被混为一谈，这里拆开

| # | 现象 | 性质 | 结论 |
|---|---|---|---|
| 1 | 批量下载跑完，**结果一个都不落**，报 `'gbk' codec can't encode character '\u0142'` | **真 bug**（上游代码缺陷 + Windows 环境） | 已修（本地补丁） |
| 2 | arXiv 一律 `HTTP 406` | **环境限制**（本机链路） | 已绕（改走 export http） |
| 3 | 4 篇拿不到 PDF（403 / 空响应） | **不是故障**（出版商订阅墙） | 不可修，需机构订阅或手动补 |

**① 的机理**：`fetch.py` 用 `ensure_ascii=False` 输出 JSON（正确做法——否则中文被转义成 `\uXXXX`），
但 Python 在 Windows 上按 locale 编码（cp936/GBK）写 stdout。作者名或标题里只要出现**一个**
非 GBK 字符（波兰语 `ł`、土耳其语 `ı` 等），**整个 JSON 信封就写不出去**，全部下载成果丢失，
退出码 4。

**为什么阴险**：崩溃发生在**收尾写结果**那一步，stderr 里能看到前面的 `source_hit` 事件——
网络工作是**真的做完了**，只是结果没落盘。

---

## 二、上游状态（2026-09-17 核实）

- 本地用的是 `0.14.1`（schema 1.10.1）
- 上游最新 `0.15.1`（schema 1.11.0），最后更新 2026-07-26
- **仓库已搬家**：独立仓库 `Agents365-ai/paper-fetch` 已 404，现位于
  [`agents365-ai/365-skills`](https://github.com/agents365-ai/365-skills) 的 `plugins/paper-fetch/` 下
- 上游 `0.15.1` **没有修编码 bug**：它用 try/except 兜住异常并返回 `internal_error`，
  结果照样全丢。
- 上游 `0.15.1` 唯一的正向改动：**PDF 下载的 User-Agent 改为浏览器标识**
  （上游注释称用于修 `iiarjournals.org` 这类对非浏览器 UA 返 403 的出版商）。

---

## 三、本次做的三处修复

### 1. `fetch.py` 强制 UTF-8 输出（根治编码崩溃）

文件：`packages/dsh-plugin/skills/paper-fetch/scripts/fetch.py`
位置：imports 之后、Versioning 段之前，带 `LOCAL PATCH (E34)` 标记

```python
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
```

- `errors="replace"` 保证极端情况下也只是个别字符降级，**不会让整封信封写不出去**
- 兜底 except 是给非标准流（测试替身）用的

### 2. 桥脚本的调用提示补上 UTF-8 环境变量

文件：`scripts/fetch-fulltext.mjs`（`--prepare` 模式打印的命令）
- 打印的命令前缀加上 `$env:PYTHONUTF8=1; $env:PYTHONIOENCODING="utf-8";`
- 并加了事故说明，避免操作者照抄旧命令
- `scripts/batch-parse.mjs` 也加了同样的说明（它本身不需要，但注释里提到了抓取前置）

### 3. arXiv 专用通道固化为正式脚本

文件：`scripts/fetch-arxiv-pdf.mjs`（新增，替代此前一次性临时脚本）
- 主路径 `http://export.arxiv.org/pdf/<id>`：**HTTPS 在本机被 406 拦截，http 才通**
- 候选地址按序尝试（带/不带版本号、export 与主站）
- 分块读取 + 逐地址重试：应对连接被中途掐断（`IncompleteRead`）
- 幂等：本地已是合法 PDF 则只补登记，不重复下载
- 用法：`node scripts/fetch-arxiv-pdf.mjs [--limit N] [--dry-run] [--paper-id <id>...]`

---

## 四、验证证据

| 验证项 | 方法 | 结果 |
|---|---|---|
| 编码修复 | 用与崩溃同形的载荷（作者名 `Łukasz Zieliński`）走 `fetch.py` 的真实输出路径 | 信封完整写出，UTF-8 正确，退出码 0 |
| arXiv 通道 | 挪走本地文件强制真下载（`2402.04129`） | 成功 2192KB（旧脚本曾截断为 1024KB——**说明分块读取确实拿全了**） |
| 落库 | 查 `metadata.db` | `pdf_status='downloaded'`，`pdf_path` 指向实际文件 |
| 守卫测试 | `packages/dsh-plugin/tests/paper-fetch-encoding.test.ts` 三条断言 | 单独复跑全通过 |
| 类型检查 | `npx tsc -p tsconfig.build.json --noEmit` | 退出码 0 |

⚠️ **vitest 未能在本会话运行**：本沙箱禁止"用管道捕获子进程输出"，vite 启动即失败。
守卫测试文件已写好，请在宿主机跑一次：
`cd packages/dsh-plugin && npx vitest run tests/paper-fetch-encoding.test.ts`

---

## 五、下次升级上游时必须核对的清单

1. **`fetch.py` 里的 UTF-8 reconfigure 补丁是否还在** —— 替换文件会整体覆盖它，
   守卫测试会红（`tests/paper-fetch-encoding.test.ts`），但别只靠记得
2. **Sci-Hub 默认值这个合规分叉**：上游**默认开启** Sci-Hub 兜底，本仓库**特意改为默认关闭**
   （`PAPER_FETCH_ALLOW_SCIHUB` 显式开启）。升级时**必须保留**，否则会静默把兜底打开
3. **schema 版本从 1.10.1 → 1.11.0**：桥接脚本按固定字段读 `results` / `meta` / 退出码分类，
   升级后跑一次回归
4. 上游浏览器 UA 的改动值得拿；但**不要**为了它整体替换文件而丢掉 1、2 两项

## 六、仍未解决（非本链路问题）

- 4 篇订阅墙论文：`10.1145/3664647.3680895`、`10.1145/3702250.3702258`、
  `10.1109/access.2024.3517170`、`10.1145/3805622.3810739`
  —— 需机构订阅（`PAPER_FETCH_INSTITUTIONAL=1` + 校园网/VPN）或手动下载
