# Sci-Hub 兜底临时启用记录（2026-09-17）

## 一、决议

- **谁批的**：用户，2026-09-17 晚，明确指示「开 Sci-Hub 试试，拿不到就算了」
- **用途**：补齐 4 篇订阅墙论文的 PDF
- **落点**：`.env.local`（已被 `.gitignore` 的 `.env.*` 规则排除，不入库）

```
PAPER_FETCH_ALLOW_SCIHUB=1
```

## 二、这件事与仓库默认值的关系（重要）

本仓库的**合规红线 #1**（`NOTICE.md`）写明：

> 仅自动下载开放获取（OA）PDF。非 OA 论文只落盘元数据与摘要，PDF 由用户自行获取后放入
> `pdfs/`。**Agent 不做绕过付费墙的抓取。**

为强制这条红线，`fetch.py` 里对上游做了**默认值反转**（`LOCAL MODIFICATION (cv-research-agent, 2026-09-16)`）：
上游是「除非 `PAPER_FETCH_NO_SCIHUB=1`，否则开启」，本仓库改为「除非 `PAPER_FETCH_ALLOW_SCIHUB=1`，否则关闭」。

**本次处置**：

- ✅ **只改环境变量，不动代码默认值** —— 代码里"忘记设环境变量不会静默恢复兜底"这个保护**依然有效**
- ✅ 该开关只对本机 `.env.local` 生效；换机器、换 shell 都不会被带上
- ✅ 属于**用户明确批准的临时例外**，不是政策变更（红线 #1 本身未修改）
- ⚠️ 若日后要长期保留，应同时更新 `NOTICE.md` 红线 #1 与
  `packages/dsh-plugin/skills/README.md` 的登记——**当前没有做，因为这是一次性例外**

## 三、实测结果：4 篇都没拿到

测试命令（Sci-Hub 兜底已开 + 绕开当时已停摆的代理）：

```powershell
$env:PAPER_FETCH_ALLOW_SCIHUB="1"
$env:NO_PROXY="...现有一串... + sci-hub.ru,sci-hub.st,sci-hub.su,sci-hub.box,sci-hub.red,sci-hub.al,sci-hub.mk,sci-hub.ee,sci-hub.pub"
python packages/dsh-plugin/skills/paper-fetch/scripts/fetch.py --batch <4 篇清单> --out data/papers/pdf --format json --timeout 30
```

| DOI | 标题 | 结果 | 各源情况 |
|---|---|---|---|
| `10.1145/3664647.3680895` | Dynamic Mixed-Prototype Model for Incremental Deepfake Detection | ❌ not_found | unpaywall / semantic_scholar / scihub 全空 |
| `10.1145/3702250.3702258` | Enhancing Generalization Ability in Deepfake Detection via Continual Learning | ❌ 403 | S2 给出出版商链接，下载被 **HTTP 403** 拒 |
| `10.1109/access.2024.3517170` | SARB-DF: A Continual Learning Aided Framework… | ❌ not_a_pdf | S2 链接返回的不是 PDF（落地页） |
| `10.1145/3805622.3810739` | Multimodal Deepfake Detection with Quantum State Inspired… | ❌ not_found | S2 读取超时，scihub 空 |

**Sci-Hub 侧的现象**：

- `scihub` 源**确实被调用**（`sources_tried` 里出现）
- 但探测阶段失败：`scihub_discover_failed — WinError 10060（连接超时）`
- **站点本身是活的**：绕开代理直连 `https://sci-hub.ru/` 返回 **HTTP 200**（真实页面）
  → 说明卡在镜像选择/超时，而非域名不可达
- `sci-hub.pub`（发现用的入口）探测不通；`sci-hub.st` 证书自签校验失败

**结论**：在本机当前网络条件下，Sci-Hub 兜底**没能取到任何一篇**。符合用户预案——「拿不到就算了」。

## 四、若日后想再试（前置条件）

1. **代理必须在线**（`127.0.0.1:10808`）：本次实测时它已停摆，导致 Unpaywall /
   Semantic Scholar 也全部连接失败——**测试环境本身是不完整的**
2. **Sci-Hub 域名必须绕过代理**：`NO_PROXY` 里加上 `sci-hub.*`，否则请求会打到死代理上
3. 或者走**机构模式**（`PAPER_FETCH_INSTITUTIONAL=1` + 校园网/VPN）——这是合规且更可靠的路径，
   这 4 篇里有 2 篇（ACM/IEEE）在机构订阅下大概率可以正常拿到
