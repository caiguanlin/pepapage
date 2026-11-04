"""按 tools/models_manifest.json 下载离线模型（固定 revision + sha256/size 校验），仅用标准库。

用途：
  1. Dockerfile 模型阶段：COPY 本文件与 manifest 后执行，产物进入独立模型层。
  2. 人工准备模型目录（可先在有网机器执行，再整体拷贝到离线主机）。

运行：python tools/fetch_models.py [--dest-root DIR] [--only NAME] [--base-url URL] [--force]
行为：
  - 每个模型先下载到独立的新空临时目录（<dest>.tmp-<pid>），全部校验通过后原子改名到位；
    目标目录已存在且非空时报错，--force 才允许替换（先删后换）。
  - 只下载 manifest 列出的文件：role=model 运行必需、role=license 官方许可证全文、
    role=readme 上游自述（归属）。文件可带绝对 url（如上游许可证），否则
    从 <base_url>/<repo_id>/resolve/<revision>/<name> 下载。
  - 校验：逐文件 sha256 与 size；通过后写 <dest>/_provenance.json（repo/revision/许可证/哈希）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.request
from pathlib import Path

PROVENANCE = "_provenance.json"
CHUNK = 1024 * 1024


def default_manifest() -> Path:
    return Path(__file__).resolve().parent / "models_manifest.json"


def load_manifest(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("version") not in (1, 2) or not data.get("models"):
        raise SystemExit(f"manifest 结构无效：{path}")
    return data


def file_url(base_url: str, repo_id: str, revision: str, f: dict) -> str:
    url = f.get("url")
    if url:
        return url
    return f"{base_url.rstrip('/')}/{repo_id}/resolve/{revision}/{f['name']}"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def download_file(url: str, dest: Path, expected_sha: str, expected_size: int) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "yueya-worker-fetch/1.0"})
    h = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as out:
        while True:
            block = resp.read(CHUNK)
            if not block:
                break
            out.write(block)
            h.update(block)
            size += len(block)
            sys.stdout.write(f"\r    {dest.name}: {size / (1024 * 1024):7.1f} MB")
            sys.stdout.flush()
    sys.stdout.write("\n")
    if size != expected_size:
        raise RuntimeError(f"{dest.name} 大小不符：得到 {size}，期望 {expected_size}")
    if h.hexdigest() != expected_sha.lower():
        raise RuntimeError(f"{dest.name} sha256 不符：得到 {h.hexdigest()}，期望 {expected_sha}")


def fetch_model(model: dict, dest_root: Path, base_url: str, force: bool) -> Path:
    dest = dest_root / model["dest"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.tmp-{os.getpid()}")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()  # 每个模型一个全新空目录，校验通过才落位
    try:
        for f in model["files"]:
            size_mb = f["size"] / (1024 * 1024)
            print(f"  下载 {f['name']}（{size_mb:.1f} MB，role={f.get('role', 'model')}）")
            url = file_url(base_url, model["repo_id"], model["revision"], f)
            download_file(url, tmp / f["name"], f["sha256"], f["size"])
        provenance = {
            "tool": "yueya-worker tools/fetch_models.py",
            "manifest_version": 2,
            "base_url": base_url,
            "repo_id": model["repo_id"],
            "revision": model["revision"],
            "license": model["license"],
            "license_url": model.get("license_url"),
            "env": model["env"],
            "fetched_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "files": {f["name"]: {"sha256": f["sha256"], "size": f["size"], "role": f.get("role", "model")}
                      for f in model["files"]},
        }
        (tmp / PROVENANCE).write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if dest.exists():
            if not force:
                raise SystemExit(f"目标已存在且可能非空：{dest}（确认覆盖请加 --force）")
            print(f"  --force：替换已有目录 {dest}")
            shutil.rmtree(dest)
        os.replace(tmp, dest)  # 同盘改名，原子落位
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    print(f"  完成：{dest}")
    return dest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="按 manifest 下载固定 revision 的离线模型并校验 sha256")
    ap.add_argument("--manifest", type=Path, default=default_manifest())
    ap.add_argument("--dest-root", type=Path, default=Path("."), help="manifest 中 dest 的解析根目录")
    ap.add_argument("--only", help="只处理指定 name 的模型")
    ap.add_argument("--base-url", default=None, help="覆盖 manifest base_url（如镜像站 https://hf-mirror.com）")
    ap.add_argument("--force", action="store_true", help="目标目录已存在时删除后替换")
    args = ap.parse_args(argv)

    manifest = load_manifest(args.manifest)
    base_url = args.base_url or manifest["base_url"]
    models = manifest["models"]
    if args.only:
        models = [m for m in models if m["name"] == args.only]
        if not models:
            raise SystemExit(f"manifest 中没有模型：{args.only}")
    total = sum(f["size"] for m in models for f in m["files"])
    print(f"模型 {len(models)} 个，共 {total / (1024 * 1024):.1f} MB，来源 {base_url}")
    for model in models:
        print(f"[{model['name']}] {model['repo_id']}@{model['revision']}（{model['license']}）")
        fetch_model(model, args.dest_root, base_url, args.force)
    print("全部模型下载并校验通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
