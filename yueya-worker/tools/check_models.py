"""模型目录启动校验（对照 tools/models_manifest.json），仅用标准库。

运行：python -m tools.check_models [--mode quick|full] [--dest-root DIR] [--manifest PATH]
  quick：模型文件存在且大小一致（容器入口默认，秒级）。
  full ：再算每个文件 sha256（人工/CI 校验用）。

校验范围：role=model 与 role=license 的文件（role=readme 仅归属说明，不校验）。
目录解析：优先模型对应环境变量（manifest 的 env 字段，如 KITTEN_MODEL_DIR / WHISPER_MODEL）；
  环境变量等于 manifest 期望路径 → 严格校验（固定版本）；
  环境变量指向其他路径（自定义挂载/换模型版本）→ 只做结构校验（文件存在、非空），
  因为固定哈希属于特定 revision；要严格校验请提供对应 manifest 或 CHECK_MODELS=skip 后
  依赖实际加载检查。未设置环境变量时按 --dest-root 严格校验。
退出码：0 全部通过；1 有缺失/不一致（逐条打印）。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .fetch_models import default_manifest, load_manifest, sha256_of


def model_dir(model: dict, dest_root: Path) -> tuple[Path, str]:
    """返回 (目录, 校验级别 strict|structural)。环境变量路径与 manifest 期望一致时为 strict。"""
    expected = dest_root / model["dest"]
    env_path = (os.getenv(model.get("env", "")) or "").strip()
    if not env_path:
        return expected, "strict"
    actual = Path(env_path)
    try:
        same = actual.exists() and expected.exists() and actual.resolve() == expected.resolve()
    except OSError:  # pragma: no cover - resolve 失败按不同路径处理
        same = False
    return (actual, "strict") if same else (actual, "structural")


def verify_model(model: dict, dest_root: Path, mode: str) -> tuple[list[str], str]:
    """返回 (错误列表, 说明)。只校验 role=model 与 role=license 文件。"""
    directory, level = model_dir(model, dest_root)
    errors: list[str] = []
    if not directory.is_dir():
        return [f"{model['name']}: 目录缺失 {directory}"], level
    for f in model["files"]:
        role = f.get("role", "model")
        if role == "readme":
            continue
        if level == "structural":
            # 自定义路径（换模型版本/挂载）：只查模型文件存在且非空；许可证按分发方交付物处理，不卡启动
            if role != "model":
                continue
            p = directory / f["name"]
            if not p.is_file():
                errors.append(f"{model['name']}: 缺少文件 {p}")
            elif p.stat().st_size <= 0:
                errors.append(f"{model['name']}/{f['name']}: 文件为空")
            continue
        p = directory / f["name"]
        if not p.is_file():
            errors.append(f"{model['name']}: 缺少文件 {p}")
            continue
        actual = p.stat().st_size
        if actual != f["size"]:
            errors.append(f"{model['name']}/{f['name']}: 大小 {actual} != 期望 {f['size']}")
        if mode == "full":
            digest = sha256_of(p)
            if digest != f["sha256"].lower():
                errors.append(f"{model['name']}/{f['name']}: sha256 {digest} != 期望 {f['sha256']}")
    return errors, level


def check_all(manifest_path: Path, dest_root: Path, mode: str) -> tuple[list[str], int]:
    manifest = load_manifest(manifest_path)
    all_errors: list[str] = []
    total = 0
    for model in manifest["models"]:
        errors, level = verify_model(model, dest_root, mode)
        status = "OK" if not errors else "FAIL"
        pinned_mb = sum(f["size"] for f in model["files"] if f.get("role", "model") in ("model", "license")) / (1024 * 1024)
        print(f"[{status}] {model['name']}（{model['repo_id']}@{model['revision'][:12]}，锁定 {pinned_mb:.1f} MB，"
              f"{'严格校验' if level == 'strict' else '结构校验（自定义路径）'}，目录 {model_dir(model, dest_root)[0]}）")
        if level == "structural" and not errors:
            print(f"      自定义模型路径：不校验固定 revision 哈希；需要严格校验请提供对应 manifest，"
                  f"或 CHECK_MODELS=skip 改为依赖实际加载检查")
        all_errors.extend(errors)
        total += 1
    return all_errors, total


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="模型目录启动校验（quick=存在+大小，full=再加 sha256）")
    ap.add_argument("--mode", choices=("quick", "full"), default="quick")
    ap.add_argument("--dest-root", type=Path, default=Path("/"), help="manifest 中 dest 的解析根目录（镜像内默认 /）")
    ap.add_argument("--manifest", type=Path, default=None)
    args = ap.parse_args(argv)
    manifest_path = args.manifest or default_manifest()
    errors, _n = check_all(manifest_path, args.dest_root, args.mode)
    for e in errors:
        print(f"  {e}")
    print(f"check_models({args.mode})：{'通过' if not errors else f'{len(errors)} 项失败'}")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
