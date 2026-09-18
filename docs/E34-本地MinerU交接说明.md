# 本地 MinerU 交接说明（2026-09-18）

## 一、结论（先说重点）

**本地 MinerU 已经装好了，不是"装不上"——是本会话的沙箱不让它跑。**

沙箱当前工作模式（workspace-write）明文禁止程序打开**命名管道**，而 MinerU 内部用 Windows
命名管道做多进程通信，因此必然失败：

```
PermissionError: [WinError 5] 拒绝访问
  File "multiprocessing\connection.py", line 558, in Pipe
    h2 = _winapi.CreateFile(...)
```

GPU 全程 8 MiB / 0% 占用，确认它根本没进到计算阶段。

**所以：请你在自己的 pwsh 里跑一次**（不经沙箱），跑完把产出交给我，我接着做提取与入库。

> **⚠️ 诚实标注验证状态**：我为此写了垫片并**在会话内实测过**，但沙箱是**进程级**生效的——
> 换任何写法都照样触发管道拒绝（实测报错与不加垫片时一致）。因此**"在正常 shell 下能否跑通"
> 我无法自证**，只能由你验证。已确认被垫片治住的那部分是 `mkdtemp` 的目录权限问题
> （tempdir 已成功指向工作区、不再报目录错）；命名管道那道门属于沙箱边界，只能靠换环境绕过。

---

## 二、环境现状（无需任何安装动作）

| 项 | 状态 |
|---|---|
| conda 环境 | `mineru`（Python 3.10.20） |
| MinerU | 3.1.4 |
| PyTorch | 2.6.0**+cu126**，`torch.cuda.is_available() = True` |
| GPU | RTX 4060 Laptop，8 GB 显存，算力 8.9 |
| 模型权重 | 已缓存 4.5 GB：`PDF-Extract-Kit-1.0`（pipeline）+ `MinerU2.5-Pro-1.2B`（VLM） |
| 磁盘 | D 盘可用 356 GB |

---

## 三、你要跑的命令（三步）

### 第 1 步：先生成待解析清单

```powershell
cd D:\Code\VScodeRepo\dsh-plugin
node scripts/prepare-localmineru-list.mjs
```

产出 `data/papers/localmineru-list.txt`（PDF 路径清单）与 `localmineru-map.json`（paper_id 映射）。

### 第 2 步：本地批量解析（**耗时较长，别用短超时**）

```powershell
cd D:\Code\VScodeRepo\dsh-plugin
$env:PYTHONUTF8=1
$env:PYTHONIOENCODING="utf-8"
# 代理变量必须清掉：NO_PROXY 里的 [::1] 会被 PowerShell 吃成非法端口，导致 httpx 报错
Remove-Item Env:NO_PROXY,Env:no_proxy,Env:HTTP_PROXY,Env:HTTPS_PROXY -ErrorAction SilentlyContinue

& "D:\Anaconda\envs\mineru\python.exe" scripts\_mineru_local_shim.py `
    --list data/papers/localmineru-list.txt `
    data/papers/_localmineru-out `
    --backend pipeline --device cuda
```

- 产出落在 `data/papers/_localmineru-out/<PDF 主文件名>/`
- 同目录会写 `manifest.jsonl`（对账用：PDF → 产出目录 → 耗时 → 成功/失败）
- **单篇失败不中断整批**；跑完会打印「成功 X/总数 Y」与失败清单
- 预估：GPU 上 pipeline 模式约 3–8 秒/篇的推理，但模型加载 + 版式模型有固定开销
  （模型首次加载是分钟级），先拿 1–2 篇试手更稳

### 第 3 步：告诉我就行

跑完（或中途想确认）跟我说一声，我会：
1. 把产出按仓库既有目录约定（`scripts/lib/safe-dir-name.mjs`）规整到 `data/papers/markdown/`
2. 回写 `metadata.db` 的 `md_path` / `parse_channel='mineru-local'`
3. 逐篇做结构化提取 + 归纳进四库

---

## 四、为什么需要那个 `_mineru_local_shim.py`（不要绕过它）

直接跑 `mineru` CLI 在**本机所有环境下**都会先撞一个坑：

`tempfile.mkdtemp()` 建出的目录带受限权限，在里面**再建任何文件或子目录**都会被拒
（WinError 5）。实测隔离结论：

```
✓ mkdtemp 本身成功
✗ 在 mkdtemp 结果里 mkdir output / out2 / sub、直接写文件  → 全部被拒
✓ 在普通目录下 mkdir 嵌套目录、写文件                      → 正常
```

而 MinerU CLI 的 `api_client.start()` 硬用 `mkdtemp` 建 `mineru-api-client-<随机>` 工作区。
垫片在**不改动 MinerU 源码**的前提下，把 `mkdtemp` 换成"普通 mkdir + 随机后缀"。

垫片同时处理另外两件事：
- 清掉代理变量（含 `NO_PROXY` 里的 `[::1]`——PowerShell 会吃掉方括号，httpx 报 `Invalid port ':1]'`）
- 把 `tempfile.tempdir` 指到工作区内

---

## 五、本地 vs 线上（同一篇论文 OVOR / 20 页实测）

| 来源 | 字符 | 标题 | 表格行 | **公式** | **图片** | 成本 |
|---|---|---|---|---|---|---|
| MinerU API（线上） | 81197 | 23 | 0 | **14** | **7** | 20 页额度，秒级 |
| PyMuPDF4LLM（本地 CPU） | 70399 | 22 | **96** | **0** | **0** | 零额度，约 40s |
| 本地 MinerU | 待你跑完补测 | | | | | 零额度，不占网络 |

**注意 PyMuPDF4LLM 这条本地路**（`pip list` 里已有 `pymupdf4llm`）：快、免费、不出本机，
但**公式和图片全丢**——适合粗筛，不适合精读。它的表格行数反而更高，是因为公式退化成
了普通文本行，指标不能单看。

---

## 六、清理提醒

探测过程中产生的临时目录（`_probe`、`_mineru-tmp`、`_localmineru-smoke`）已清理。
`data/papers/_mineru-tmp/` 运行时会重新创建，属正常。
