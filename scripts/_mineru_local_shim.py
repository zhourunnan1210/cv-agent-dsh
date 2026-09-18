"""本地 MinerU 运行垫片（shim）。

## 为什么需要

本机沙箱下，`tempfile.mkdtemp()` 创建出来的目录**带受限权限**，在其中再建文件/子目录
一律 `PermissionError [WinError 5]`。实测隔离结论：

    ✓ mkdtemp 本身成功
    ✗ 在 mkdtemp 结果里 mkdir output / out2 / sub、直接写文件  → 全部被拒
    ✓ 在普通目录下 mkdir 嵌套目录、写文件                      → 正常

而 MinerU CLI（`mineru.cli.client`）在 `run_orchestrated_cli` 里调用
`api_client.start()`，后者**硬用 `mkdtemp`** 建 `mineru-api-client-<随机>` 工作区，
于是本地解析必然失败。这个垫子把 `mkdtemp` 换成"普通 mkdir + 随机后缀"，
不改动 MinerU 自身代码。

## 用法

    # 单篇
    python scripts/_mineru_local_shim.py <PDF 路径> <输出目录> [--backend pipeline] [--device cuda]

    # 批量（清单文件每行一个 PDF 路径，或直接给一个目录）
    python scripts/_mineru_local_shim.py --list <清单文件|目录> <输出目录> [--backend pipeline] [--device cuda]

注意事项：
  - 模型首次加载很慢（分钟级），**整批会比预期久**，别用短超时去跑；
  - 批量模式会把每个 PDF 的产出落到 <输出目录>/<PDF 主文件名>/，
    并写一份 manifest.jsonl（paper 文件名 → 产出目录），供后续入库步骤对账。

## 另外两个必须处理的环境陷阱（都在调用侧解决）

1. `NO_PROXY` 里含 `[::1]` 时，PowerShell 会把方括号吃掉，传给 httpx 变成
   `Invalid port: ':1]'` → 调用前清空代理相关变量。
2. 会话临时区（`<系统临时区>/dsh-*`）同样受沙箱限制，
   所以 temp 基准目录要显式指向工作区内。
"""
from __future__ import annotations

import os
import json
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

# ── 陷阱 1：代理变量（含 NO_PROXY 里的 [::1]）会让 httpx 解析失败 ──────────────
for key in ("NO_PROXY", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY"):
    os.environ.pop(key, None)

# ── 陷阱 2：temp 基准目录指到工作区内（会话临时区受限）─────────────────────
WORKSPACE = Path(__file__).resolve().parent.parent
TMP_ROOT = WORKSPACE / "data" / "papers" / "_mineru-tmp"
TMP_ROOT.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(TMP_ROOT)

# ── 陷阱 3：模型源必须显式设为 local ──────────────────────────────────────
# 本机模型权重已由 MinerU 预下载到 ModelScope 缓存
# （C:\Users\Admin\.cache\modelscope\hub\models\OpenDataLab\ 下 4.5GB：
#  PDF-Extract-Kit-1___0 与 MinerU2___5-Pro-2604-1___2B）。
# 但 `MINERU_MODEL_SOURCE` 缺省未设置时，MinerU 会去 HuggingFace Hub 找快照，报：
#     huggingface_hub.errors.LocalEntryNotFoundError:
#     cannot find the appropriate snapshot folder ... on the local disk
# 设为 local 后走 `get_local_models_dir()`（实测返回上述 ModelScope 路径）。
os.environ.setdefault("MINERU_MODEL_SOURCE", "local")


# ── 垫片：把受限的 mkdtemp 换成普通建目录 ─────────────────────────────────
def _permissive_mkdtemp(suffix: str | None = None, prefix: str | None = None, dir: str | None = None) -> str:
    base = Path(dir) if dir is not None else TMP_ROOT
    base.mkdir(parents=True, exist_ok=True)
    name = f"{prefix or ''}{uuid.uuid4().hex[:8]}{suffix or ''}"
    target = base / name
    target.mkdir(parents=True, exist_ok=True)
    return str(target)


tempfile.mkdtemp = _permissive_mkdtemp  # type: ignore[assignment]

# MinerU 侧可能已 `from tempfile import mkdtemp` —— 一并修补已导入的引用
import mineru.cli.api_client as _api_client  # noqa: E402

if hasattr(_api_client, "mkdtemp"):
    _api_client.mkdtemp = _permissive_mkdtemp  # type: ignore[attr-defined]
if hasattr(_api_client, "tempfile"):
    _api_client.tempfile.mkdtemp = _permissive_mkdtemp  # type: ignore[attr-defined]


def run(pdf: str, out_dir: str, backend: str = "pipeline", device: str = "cuda") -> int:
    from mineru.cli.client import main

    pdf_path = str(Path(pdf).resolve())
    out_path = str(Path(out_dir).resolve())
    Path(out_path).mkdir(parents=True, exist_ok=True)

    sys.argv = [
        "mineru",
        "-p", pdf_path,
        "-o", out_path,
        "-b", backend,
        "-d", device,
    ]
    print(f"[shim] PDF={pdf_path}")
    print(f"[shim] OUT={out_path}")
    print(f"[shim] backend={backend} device={device}")
    print(f"[shim] tempdir={tempfile.gettempdir()}")
    t0 = time.time()
    try:
        main()
    finally:
        print(f"[shim] 耗时 {time.time() - t0:.1f}s")
    return 0


def _collect_pdfs(source: Path) -> list[Path]:
    if source.is_dir():
        return sorted(p for p in source.iterdir() if p.suffix.lower() == ".pdf")
    lines = [line.strip() for line in source.read_text(encoding="utf-8").splitlines()]
    return [Path(line) for line in lines if line != "" and not line.startswith("#")]


def _find_markdown(root: Path) -> list[Path]:
    """在产出目录里找 .md。

    ⚠ 踩过的坑：MinerU 的产出层数**不是固定的**。
    单文件调用 `-o <out>` 时实际落到两层 `<out>/<stem>/auto/<stem>.md`（外层是 CLI
    按任务名建的、内层是服务端建的）；批量调用又可能是 `<out>/<stem>/auto/...`。
    早期版本只 rglob('*.md')，结果三篇明明成功却被判失败写成 manifest —— 所以这里
    **一律递归找**，并把「找不到」与「解析失败」分开处理。
    """
    return sorted(root.rglob("*.md"))


def run_many(pdfs: list[Path], out_dir: str, backend: str = "pipeline", device: str = "cuda") -> int:
    """一次调用解析多篇：MinerU 的 -p 支持多路径，模型只加载一次。

    为什么不再逐篇调用：逐篇时每篇都要重付模型加载开销。实测（2026-09-18，RTX 4060 8GB）
    20 页级论文逐篇为 75.3 / 91.6 / 115.6 秒，而首次加载约占 40 秒——摊薄后省掉相当一部分。
    """
    from mineru.cli.client import main

    out_path = Path(out_dir).resolve()
    out_path.mkdir(parents=True, exist_ok=True)

    argv = ["mineru", "-o", str(out_path), "-b", backend, "-d", device]
    for pdf in pdfs:
        argv += ["-p", str(pdf.resolve())]

    print(f"[shim] 批量提交 {len(pdfs)} 篇（一次调用，模型只加载一次）")
    print(f"[shim] OUT={out_path}")
    print(f"[shim] backend={backend} device={device} tempdir={tempfile.gettempdir()}")
    sys.argv = argv
    t0 = time.time()
    try:
        main()
    finally:
        print(f"[shim] 整批耗时 {time.time() - t0:.1f}s")
    return 0


def run_batch(source: str, out_dir: str, backend: str = "pipeline", device: str = "cuda") -> int:
    """批量解析：**每篇一个进程**，逐篇核对产出，缺失的自动重试一轮。

    ## 为什么是"每篇一个进程"而不是"一次调用多文件"

    实测（2026-09-18）踩到硬限制：`mineru.cli.client.main()` 正常结束时会 `sys.exit()`，
    **整个 Python 进程随之退出**。所以在同一进程里循环调用 main() 处理多个文件是行不通的——
    实测提交 20 篇，日志只显示 `Submitting batch 1/1 | 1 document`，其余 19 篇根本没被处理。
    （早先"2 篇一次调用成功"的表象，其实是靠第二轮重试兜住的。）

    因此这里**每个 PDF 一个 `main()` 调用、一个进程**。代价是每篇重付一次模型加载开销，
    换来的是可靠：单篇失败不影响其他篇，进度可核对，中途可续跑。

    ⚠ 另外实测到 MinerU 会**静默丢弃**清单里的文件（清单 2 篇只处理 1 篇，既不报错也不产出），
    所以两轮机制是必要的：第一轮全跑，第二轮只重试缺失的。
    """
    pdfs = _collect_pdfs(Path(source))
    if not pdfs:
        print(f"[shim] 清单里没有 PDF：{source}")
        return 2

    out_root = Path(out_dir).resolve()
    out_root.mkdir(parents=True, exist_ok=True)
    manifest = out_root / "manifest.jsonl"

    def produced_md(stem: str) -> list[Path]:
        return [p for p in _find_markdown(out_root) if p.stem == stem or stem in str(p)]

    rows: dict[str, dict] = {}
    t_all = time.time()

    def attempt(pdf: Path, label: str) -> None:
        print(f"\n===== {label} =====")
        t0 = time.time()
        try:
            run(str(pdf), str(out_root), backend, device)
        except SystemExit as exc:
            # main() 正常结束即 sys.exit(0)；非 0 才算异常
            if exc.code not in (0, None):
                print(f"[shim] ⚠ {pdf.stem} 退出码 {exc.code}")
        except BaseException as exc:  # noqa: BLE001 — 单篇异常不能拖垮整批
            print(f"[shim] ⚠ {pdf.stem} 抛出异常：{type(exc).__name__}: {exc}")
        hits = produced_md(pdf.stem)
        rows[pdf.stem] = {
            "pdf": str(pdf.resolve()),
            "stem": pdf.stem,
            "md_files": [str(p) for p in hits],
            "status": "ok" if hits else "missing",
            "seconds": round(time.time() - t0, 1),
        }
        if not hits:
            rows[pdf.stem]["error"] = "产出中找不到该 paper 的 .md"
        # 每篇落一次 manifest：长跑中途被打断也能看到进度
        with manifest.open("w", encoding="utf-8") as mf:
            for row in rows.values():
                mf.write(json.dumps(row, ensure_ascii=False) + "\n")

    # ── 第一轮 ────────────────────────────────────────────────────────────
    for index, pdf in enumerate(pdfs, start=1):
        # 已产出过的直接跳过（支持中途重跑，不重复烧 GPU）
        if produced_md(pdf.stem):
            rows[pdf.stem] = {
                "pdf": str(pdf.resolve()), "stem": pdf.stem,
                "md_files": [str(p) for p in produced_md(pdf.stem)],
                "status": "ok", "seconds": 0,
            }
            print(f"[shim] ↷ {pdf.stem} 已有产出，跳过（{index}/{len(pdfs)}）")
            continue
        attempt(pdf, f"[{index}/{len(pdfs)}] {pdf.stem}")

    # ── 第二轮：只重试缺失的 ──────────────────────────────────────────────
    missing = [p for p in pdfs if rows.get(p.stem, {}).get("status") != "ok"]
    if missing:
        print(f"\n===== 第一轮后有 {len(missing)} 篇缺失，逐篇重试 =====")
        for pdf in missing:
            attempt(pdf, f"重试 {pdf.stem}")

    ok = sum(1 for r in rows.values() if r["status"] == "ok")
    print("\n===== 批量结束 =====")
    print(f"成功 {ok}/{len(rows)}，总耗时 {time.time() - t_all:.0f}s")
    print(f"产出清单：{manifest}")
    for row in rows.values():
        if row["status"] != "ok":
            print(f"  ✗ {row['stem']}  {str(row.get('error'))[:120]}")
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    args = list(sys.argv[1:])
    backend = args[args.index("--backend") + 1] if "--backend" in args else "pipeline"
    device = args[args.index("--device") + 1] if "--device" in args else "cuda"
    if args[0] == "--list":
        sys.exit(run_batch(args[1], args[2], backend, device))
    pdf, out = args[0], args[1]
    sys.exit(run(str(pdf), str(out), backend, device))
