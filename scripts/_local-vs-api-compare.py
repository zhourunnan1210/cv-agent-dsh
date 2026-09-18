"""三份解析产物对照：MinerU API / 本地 MinerU / PyMuPDF4LLM（同一篇论文 OVOR, 20 页）。

关注点不是字符数，而是**结构化程度**——论文精读靠的是表格、公式、图片这些结构。
"""
from __future__ import annotations

import re
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent

CANDIDATES = [
    ("MinerU API（线上）", WORKSPACE / "data/papers/markdown/10.48550/arxiv.2402.04129/full.md"),
    ("本地 MinerU（GPU pipeline）", WORKSPACE / "data/papers/_localmineru-smoke/2402.04129/auto/2402.04129.md"),
]


def stats(path: Path) -> dict:
    if not path.exists():
        return {"exists": False}
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    return {
        "exists": True,
        "chars": len(text),
        "lines": len(lines),
        "headings": len(re.findall(r"^#{1,6}\s", text, re.M)),
        "tables_md": len(re.findall(r"^\|.*\|$", text, re.M)),
        "formulas_block": len(re.findall(r"\$\$.+?\$\$", text, re.S)),
        "formulas_inline": len(re.findall(r"(?<!\$)\$(?!\$)[^$\n]{2,}?\$(?!\$)", text)),
        "images_ref": len(re.findall(r"!\[", text)),
        "html_tables": len(re.findall(r"<table", text, re.I)),
    }


print("=== 同一篇论文（OVOR / ICLR 2024 / 20 页）解析产物对照 ===\n")
header = f"{'来源':<28}{'字符':>7}{'行数':>7}{'标题':>6}{'表格':>6}{'块公式':>7}{'行内公式':>9}{'图片':>6}{'HTML表':>7}"
print(header)
print("-" * len(header))

for label, path in CANDIDATES:
    s = stats(path)
    if not s["exists"]:
        print(f"{label:<28}  （文件不存在：{path}）")
        continue
    print(
        f"{label:<28}{s['chars']:>7}{s['lines']:>7}{s['headings']:>6}{s['tables_md']:>6}"
        f"{s['formulas_block']:>7}{s['formulas_inline']:>9}{s['images_ref']:>6}{s['html_tables']:>7}"
    )

# 本地 MinerU 的图片是否真的落盘
imgdir = WORKSPACE / "data/papers/_localmineru-smoke/2402.04129/auto/images"
if imgdir.exists():
    imgs = list(imgdir.glob("*"))
    total_mb = sum(p.stat().st_size for p in imgs) / 1024**2
    print(f"\n本地 MinerU 图片落盘：{len(imgs)} 张，共 {total_mb:.1f} MB → {imgdir}")

print("\n=== 结论口径 ===")
print("  块公式（$$...$$）与图片引用（![]()）是精读的关键结构：")
print("  公式决定方法章节能不能读懂，图片决定图表能不能定位。")
