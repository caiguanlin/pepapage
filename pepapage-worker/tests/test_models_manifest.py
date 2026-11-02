"""模型 manifest 校验：固定 revision、哈希格式、角色齐全、官方许可证源、与 worker 代码一致。"""
from __future__ import annotations

import json
import re
from pathlib import Path

from tools.fetch_models import default_manifest, load_manifest
from worker import tts

MANIFEST_PATH = default_manifest()
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
REV_RE = re.compile(r"^[0-9a-f]{40}$")


def test_manifest_loads():
    data = load_manifest(MANIFEST_PATH)
    assert data["version"] == 2
    assert data["base_url"].startswith("https://")


def test_each_model_is_fully_pinned():
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    by_name = {}
    for model in data["models"]:
        assert REV_RE.match(model["revision"]), f"{model['name']} revision 必须是 40 位 commit sha"
        assert model["license"] in ("Apache-2.0", "MIT")
        assert model["repo_id"] in model["license_url"]
        assert model["env"] in ("KITTEN_MODEL_DIR", "WHISPER_MODEL")
        assert model["dest"] == f"models/{model['name']}"
        names = [f["name"] for f in model["files"]]
        assert len(names) == len(set(names)), "文件名不得重复"
        roles = [f.get("role", "model") for f in model["files"]]
        assert roles.count("readme") == 1, "保留一份上游 README 作归属"
        assert roles.count("license") == 1, "必须有官方许可证全文"
        for f in model["files"]:
            assert SHA_RE.match(f["sha256"])
            assert isinstance(f["size"], int) and f["size"] > 0
        by_name[model["name"]] = model
    assert set(by_name) == {"kitten-tts-micro", "faster-whisper-base"}


def test_license_notice_from_official_source():
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    for model in data["models"]:
        notice = next(f for f in model["files"] if f.get("role") == "license")
        url = notice.get("url", "")
        if model["license"] == "Apache-2.0":
            assert "apache.org" in url, "Apache-2.0 全文须来自 apache.org"
        else:
            assert url.startswith("https://raw.githubusercontent.com/openai/whisper/"), "保留 Whisper 原始版权声明"
            assert REV_RE.fullmatch(url.split("/")[-2]), "许可证源固定 commit"
        assert notice["source"]


def test_kitten_files_match_worker_loader():
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    kitten = next(m for m in data["models"] if m["name"] == "kitten-tts-micro")
    model_files = {f["name"] for f in kitten["files"] if f.get("role", "model") == "model"}
    assert set(tts.MODEL_FILES) <= model_files, f"worker/tts.py 需要的 {tts.MODEL_FILES} 必须都在 manifest"
    assert kitten["env"] == "KITTEN_MODEL_DIR"


def test_whisper_files_match_faster_whisper_layout():
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    whisper = next(m for m in data["models"] if m["name"] == "faster-whisper-base")
    model_files = {f["name"] for f in whisper["files"] if f.get("role", "model") == "model"}
    assert {"model.bin", "config.json", "tokenizer.json", "vocabulary.txt"} <= model_files
    assert whisper["env"] == "WHISPER_MODEL"


def test_total_size_budget():
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    total = sum(f["size"] for m in data["models"] for f in m["files"])
    assert total < 300 * 1024 * 1024, f"镜像模型预算 300MB，当前 {total / 1024 / 1024:.1f}MB"
