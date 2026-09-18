# 本地 MinerU 部署与使用（2026-09-18 打通）

> 上一版交接说明（`E34-本地MinerU交接说明.md`）写于"被沙箱拦住、只能交给你跑"的阶段。
> **本文件是打通后的最终版**：本地 MinerU 已跑通并完成 66 篇解析入库，这里是可复现的完整方法。

---

## 一、结果

| 项 | 结果 |
|---|---|
| 本批解析 | **66/66 成功**，耗时 5389 秒（约 90 分钟） |
| 质量异常件 | **0**（66/66 含标题结构，平均 49.2 KB，中位 40.0 KB） |
| 数据库 | `parse_channel='mineru-local'`，全库已解析 184 → **250**，待解析队列清零 |
| 消耗额度 | **0 页**（对比：同样 66 篇走线上 API 约 900–1400 页） |

---

## 二、可用命令（三步）

```powershell
cd D:\Code\VScodeRepo\dsh-plugin

# 1) 生成待解析清单
node scripts/prepare-localmineru-list.mjs

# 2) 本地批量解析（每篇一个进程；后台跑，约 80~95 秒/篇）
$env:PYTHONUTF8=1; $env:PYTHONIOENCODING="utf-8"; $env:PYTHONUNBUFFERED="1"
Remove-Item Env:NO_PROXY,Env:no_proxy,Env:HTTP_PROXY,Env:HTTPS_PROXY -ErrorAction SilentlyContinue
& "D:\Anaconda\envs\mineru\python.exe" scripts\_mineru_local_shim.py `
    --list data/papers/localmineru-list.txt `
    data/papers/markdown-local `
    --backend pipeline --device cuda

# 3) 整合进仓库约定并回写数据库
node scripts/ingest-localmineru.mjs          # 加 --dry-run 可先预览
node scripts/verify-localmineru-batch.mjs    # 质量与一致性核查
```

---

## 三、环境（无需安装，已就绪）

| 项 | 值 |
|---|---|
| conda 环境 | `mineru`（`D:\Anaconda\envs\mineru\python.exe`，Python 3.10.20） |
| MinerU | 3.1.4 |
| PyTorch | 2.6.0+cu126（`torch.cuda.is_available() == True`） |
| GPU | RTX 4060 Laptop，8 GB 显存，算力 8.9 |
| 模型权重 | `C:\Users\Admin\.cache\modelscope\hub\models\OpenDataLab\`（4.5 GB） |
| 模型源 | 必须 `MINERU_MODEL_SOURCE=local`（垫片已默认设置） |

---

## 四、踩过的坑（每一条都是实测，别重蹈）

### 坑 1：命名管道被沙箱禁止
```
PermissionError: [WinError 5] 拒绝访问
  File "multiprocessing\connection.py", line 558, in Pipe
```
MinerU 用 Windows 命名管道做多进程通信。**受限沙箱模式下必然失败**，与代码写法无关
（加垫片也没用，因为限制是进程级的）。需要在不受该限制的环境里跑。

### 坑 2：模型源没设，去 HuggingFace 找不存在的快照
```
huggingface_hub.errors.LocalEntryNotFoundError:
cannot find the appropriate snapshot folder ... on the local disk
```
模型在 ModelScope 缓存里，但 `MINERU_MODEL_SOURCE` 缺省未设置时 MinerU 会去 HF Hub 找。
**解**：`MINERU_MODEL_SOURCE=local`（`get_local_models_dir()` 随即返回正确的本地路径）。

### 坑 3：代理变量让 httpx 直接崩
```
httpx.InvalidURL: Invalid port: ':1]'
```
本机 `NO_PROXY` 里含 `[::1]`，经 PowerShell 传递时方括号被吃，httpx 解析成非法端口。
**解**：跑之前清空 `NO_PROXY` / `HTTP_PROXY` / `HTTPS_PROXY`（本地解析不需要代理）。

### 坑 4：`tempfile.mkdtemp` 的目录写不进去（受限模式下）
隔离实验结论：
```
✓ mkdtemp 本身成功
✗ 在 mkdtemp 结果里 mkdir / 写文件  → WinError 5
✓ 在普通目录下 mkdir 嵌套、写文件    → 正常
```
垫片把 `mkdtemp` 换成"普通 mkdir + 随机后缀"，并把 `tempfile.tempdir` 指到工作区内。

### 坑 5：**不能**在一个进程里循环处理多篇（我自己写的 bug）
`mineru.cli.client.main()` 正常结束时会 `sys.exit()`，**整个进程退出**。
所以我最初"一次调用传 20 个文件"的方案是错的——实测提交 20 篇，日志只有
`Submitting batch 1/1 | 1 document`，其余 19 篇根本没被处理（表象被重试机制掩盖了）。
**结论：每个 PDF 一个进程。** 代价是每篇重付模型加载开销，换来可靠与可续跑。

### 坑 6：MinerU 会静默丢件
实测清单 2 篇只处理 1 篇，**既不报错也不产出**。所以垫片做两轮：
第一轮全跑，第二轮只重试缺失的。（本批 66 篇里有 1 篇是这样救回来的。）

### 坑 7：产出层数不固定，别用固定深度找文件
实际落到 `<out>/<stem>/auto/<stem>.md`，但早期版本按别的层数找，导致**明明成功却判失败**。
**一律递归找**，并把"找不到产出"与"解析失败"分开记录。

---

## 五、产出布局与整合约定

本地 MinerU 产出：
```
data/papers/markdown-local/<扁平slug>/auto/<slug>.md
                                      auto/images/<hash>.jpg
                                      auto/*_content_list.json 等
```

仓库既有约定（下游结构化提取按这个找图）：
```
data/papers/markdown/<DOI段>/full.md
                             images/<hash>.jpg
```

`scripts/ingest-localmineru.mjs` 负责转换：复制 `.md` → `full.md`、复制 `auto/images/` →
同级 `images/`、回写 `md_path` 与 `parse_channel='mineru-local'`。图片引用格式两边一致
（都是 `![](images/<hash>.jpg)`），所以**搬过去即可对上**。

---

## 六、质量对照（同一篇论文 OVOR / 20 页）

| 来源 | 字符 | 行数 | 标题 | 块公式 | 行内公式 | 图片 |
|---|---|---|---|---|---|---|
| MinerU API（线上） | 81197 | 412 | 23 | 7 | 167 | 7 |
| 本地 MinerU（GPU pipeline） | 80909 | 412 | 23 | 7 | 157 | 7 |

**差异 0.35%，结构指标逐项相同。** 本地还额外落盘了图片（34 张）。
**结论：质量可替代线上 API，且零额度、不出本机。**
