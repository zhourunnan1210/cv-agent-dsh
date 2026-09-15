# vendored 上游代码

本目录存放从上游直接复制入库、需要二次开发的第三方插件源码。

## dsh-ai4scholar

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/literaf/dsh-ai4scholar |
| 版本 | `0.3.7` |
| 许可 | MIT（上游 `LICENSE` 原件保留在 `dsh-ai4scholar/LICENSE`） |
| 复制基准提交 | `27a026f25d1bfd7c3e766e4c136916586cd2f7a5`（2026-09-11，`fix(pdf): support Electron utility processes`） |
| 复制方式 | `git clone --depth 1` 后**移除 `.git`**，按 v1.2 文档 §1.4 策略作为普通源码目录纳入本仓库 |

### 为什么移除 `.git`

v1.2 §1.4 明确的策略是「新建仓库，复制代码作为基础，**非 fork 后维护**」，理由是
本项目需要修改部分工具的返回结构以适配三库 schema。因此这里不保留上游 git 历史，
也不使用 submodule：本目录的代码由本仓库自行维护，上游变更按需人工挑选。

复制的基准提交号记录在上表，用于日后比对上游进展。

### ⚠️ 构建产物不在源码中

上游仓库的 `lib/` 被其 `.gitignore` 排除（`package.json` 的 `files` 只发布 `lib`），
因此**克隆后无法直接加载**。必须先在仓库根执行：

```bash
pnpm install
```

这会触发本包 `package.json` 的 `prepare` 脚本（`tsc` 编译 Node 半包 + `tsdown` 打包浏览器半包），
产出 `lib/index.js` 与 `lib/client.js`。也可在本目录显式执行 `pnpm run build`。

`lib/` 已被本仓库 gitignore（构建产物不入库）。验证构建结果：

```bash
node ../../tests/smoke-vendor-plugin.mjs    # 期望输出 toolCount=38
```

### 修改登记

对本目录上游源码的每一处修改都应登记在此，便于日后与上游比对：

| 日期 | 文件 | 修改内容 | 原因 |
| --- | --- | --- | --- |
| — | — | 尚无修改，当前为上游原文 | — |
