"""本地 MinerU 受阻复盘 + 两条路线的实测对比。

用途：把"本地 MinerU 能不能用"的结论固化成可复现的数据，而不是口述。
运行：<mineru 环境 python> scripts/_local-parse-compare.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent

# 同一篇论文（OVOR, ICLR 2024, 20 页）的三份解析产物
CANDIDATES = {
    "MinerU API（线上，已用额度 20 页）": WORKSPACE / "data/papers/markdown/10.48550/arxiv.2402.04129/full.md",
    "PyMuPDF4LLM（本地，CPU，40.6s）": WORKSPACE / "data/papers/_pymupdf4llm-test.md",
}


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
        "formulas_tex": len(re.findall(r"\$\$|\\\(|\\\[", text)),
        "images_ref": len(re.findall(r"!\[", text)),
        "max_line": max((len(x) for x in lines), default=0),
    }


print("=== 同一篇论文（OVOR / ICLR 2024 / 20 页）解析产物对比 ===\n")
print(f"{'来源':<42}{'字符':>8}{'行数':>7}{'标题':>6}{'表格行':>7}{'公式':>6}{'图片':>6}")
print("-" * 90)

results = {}
for label, path in CANDIDATES.items():
    s = stats(path)
    results[label] = s
    if not s["exists"]:
        print(f"{label:<42}  （文件不存在）")
        continue
    print(f"{label:<42}{s['chars']:>8}{s['lines']:>7}{s['headings']:>6}{s['tables_md']:>7}{s['formulas_tex']:>6}{s['images_ref']:>6}")

print("\n=== 判定口径 ===")
print("  标题/表格/公式/图片 是「结构化程度」的代理指标——论文精读靠的正是这些结构。")
print("  纯文本转 markdown 也能出标题，但表格与公式通常退化成散行文字，公式尤甚。")

out = WORKSPACE / "data/papers/_parse-compare.json"
out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\n已写入 {out}")
