"""从 pepapage-server 的 application-local.yml 读取 OSS 配置，写入 pepapage-worker/.env（不打印密钥）。"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
YML = ROOT / "pepapage-server" / "src" / "main" / "resources" / "application-local.yml"
ENV = ROOT / "pepapage-worker" / ".env"
EXAMPLE = ROOT / "pepapage-worker" / ".env.example"


def read_oss() -> dict[str, str]:
    text = YML.read_text(encoding="utf-8")
    m = re.search(r"^\s*oss:\s*\n((?:[ \t]+.*\n?)+)", text, re.M)
    if not m:
        raise SystemExit("application-local.yml 中没有 oss 段")
    out: dict[str, str] = {}
    for line in m.group(1).splitlines():
        kv = re.match(r"\s*([a-z-]+):\s*(\S.*?)\s*$", line)
        if kv and not line.strip().startswith("#"):
            out[kv.group(1)] = kv.group(2).strip("'\"")
    return out


def main() -> None:
    oss = read_oss()
    mapping = {
        "OSS_ENDPOINT": oss.get("endpoint", ""),
        "OSS_BUCKET": oss.get("bucket", ""),
        "OSS_ACCESS_KEY_ID": oss.get("access-key-id", ""),
        "OSS_ACCESS_KEY_SECRET": oss.get("access-key-secret", ""),
    }
    base = ENV.read_text(encoding="utf-8") if ENV.exists() else EXAMPLE.read_text(encoding="utf-8")
    lines = base.splitlines()
    seen = set()
    for i, line in enumerate(lines):
        key = line.split("=", 1)[0].strip()
        if key in mapping:
            lines[i] = f"{key}={mapping[key]}"
            seen.add(key)
    for key, val in mapping.items():
        if key not in seen:
            lines.append(f"{key}={val}")
    ENV.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("写入", ENV, {k: ("<set>" if v else "<empty>") for k, v in mapping.items()})


if __name__ == "__main__":
    main()
