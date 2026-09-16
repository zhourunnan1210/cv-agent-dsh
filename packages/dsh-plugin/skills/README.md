# 插件自带的 skills（`packages/dsh-plugin/skills/`）

本目录存放**由 `cv-agent-dsh` 插件包自己拥有**的 skill。它同时被登记在
`package.json` 的 `files` 字段里，因此会随包分发——这是它与仓库根
[`.dsh/skills/`](../../../.dsh/skills/README.md)（第三方 skill 归档）的区别。

## 为什么单独放这里

dsh 的 skill 发现默认只扫描**会话工作区所属项目根**下的 `.dsh/skills`。科研项目的
工作区通常不在本仓库里，于是那个根不存在，skill 会**静默消失**——不报错，只是工具
不见了。所以本插件的 skill 走两条独立的根：

| 根 | 内容 | 由什么钉住 |
| --- | --- | --- |
| `.dsh/skills/` | 第三方 skill 归档（CCFA / nature / academic-research） | `CV_PROJECT_SKILLS_DIR`（`scripts/start-dsh-web.ps1` 设为绝对路径） |
| `packages/dsh-plugin/skills/`（本目录） | 插件自有的 skill | `CV_PLUGIN_SKILLS_DIR`（同上） |

两者都由 `cv-research` preset 的 `skill-filesystem` 行通过 `customSkillDirs` 挂载，
并带有 `|| '<相对路径>'` 兜底（那个兜底不是装饰：`!!js` 求值出 `undefined` 会让整行
校验失败并拖垮 preset 挂载，见勘误 E22）。

---

## paper-fetch

| 项 | 值 |
| --- | --- |
| 来源 | https://github.com/Agents365-ai/paper-fetch |
| 基准提交 | `8e329aaa381dd69821efa23943248c51f05f0597`（2026-09-16 归档） |
| 许可 | MIT（上游 `LICENSE` 原件保留在本目录内） |
| 用途 | DOI / 标题 → PDF，七源回退链；补上 Asta 没有的全文获取能力 |
| 归属变更 | 2026-09-16 由 `.dsh/skills/paper-fetch/` 迁入本插件包，使其随 `cv-agent-dsh` 分发 |

**本仓库对上游源码的修改（依 `NOTICE.md` 的 vendored 纪律登记）：**

| 文件 | 修改 | 原因 |
| --- | --- | --- |
| `scripts/fetch.py` | `_is_scihub_enabled()` 的默认值**反转**：上游语义是"除非 `PAPER_FETCH_NO_SCIHUB=1`，否则开启 Sci-Hub"；现改为"除非 `PAPER_FETCH_ALLOW_SCIHUB=1`，否则关闭"。上游的退出变量仍然优先，因此上游式配置不受影响。 | `NOTICE.md` 合规红线 #1 明令"Agent 不做绕过付费墙的抓取"，而非 OA 论文按红线只落元数据。上游默认开启 Sci-Hub 镜像兜底，意味着**忘记设环境变量就会静默恢复盗版兜底**——这类"看起来合规、实际不合规"的默认值不能留在执行路径上。 |
| `SKILL.md` | 第 7 条来源的说明改成"本仓库默认关闭" | 让模型读到的指令与脚本实际行为一致 |

除上述两处，其余文件为上游原文。**升级上游时必须重新施加这两处修改**，并在上表
更新基准提交。

### 与 MinerU 的衔接

`paper-fetch` 只负责**拿到文件**，不负责读懂。解析走 MinerU：

```
Asta / 人工给出 DOI → paper-fetch 落地 PDF → MinerU 解析（上传本地文件，别丢境外 URL）
```

MinerU 侧的端点、限流与"境外 URL 会超时"的细节见
[`docs/mineru-api.md`](../../../docs/mineru-api.md)。
