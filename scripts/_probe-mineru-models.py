"""查清 MinerU 的本地模型目录约定：MINERU_MODEL_SOURCE=local 时去哪找模型。"""
import inspect
import os
from pathlib import Path

print("=== 环境变量 ===")
for key in ("MINERU_MODEL_SOURCE", "HF_HOME", "MODELSCOPE_CACHE"):
    print(f"  {key} = {os.environ.get(key)}")

print("\n=== mineru 的配置读取模块 ===")
try:
    from mineru.utils import config_reader

    for name in dir(config_reader):
        if name.startswith("get_"):
            fn = getattr(config_reader, name)
            if callable(fn):
                try:
                    print(f"  {name}() = {fn()}")
                except Exception as e:  # noqa: BLE001
                    print(f"  {name}() -> {type(e).__name__}: {e}")
except Exception as e:  # noqa: BLE001
    print(f"  导入失败：{type(e).__name__}: {e}")

print("\n=== auto_download_and_get_model_root_path 的实现 ===")
try:
    from mineru.utils.model_utils import auto_download_and_get_model_root_path

    print(inspect.getsource(auto_download_and_get_model_root_path))
except Exception as e:  # noqa: BLE001
    print(f"  取不到：{type(e).__name__}: {e}")

print("=== 候选本地路径是否存在 ===")
candidates = [
    Path.home() / ".cache" / "modelscope" / "hub" / "models" / "opendatalab",
    Path(os.environ.get("USERPROFILE", "")) / ".cache" / "modelscope" / "hub" / "models" / "opendatalab",
]
# MinerU 有时用 MINERU_MODEL_PATH 或 ~/.mineru
for extra in (Path.home() / ".mineru", Path.home() / ".cache" / "mineru"):
    candidates.append(extra)
for c in candidates:
    mark = "✓" if c.exists() else "✗"
    print(f"  {mark} {c}")
    if c.exists():
        for child in sorted(c.iterdir())[:8]:
            print(f"       └ {child.name}")
