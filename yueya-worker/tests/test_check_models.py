"""tools/check_models：严格/结构校验、环境变量路径覆盖、readme 跳过、full 哈希。"""
from __future__ import annotations

import json

import pytest

from tools import check_models


CONTENT = b"kitten-onnx-weights"  # 19 bytes
OTHER = b"a-different-model"  # 18 bytes -> 大小校验必失败


@pytest.fixture
def manifest(tmp_path):
    """单模型 manifest + 对应模型目录（严格路径 dest_root/models/m1）。"""
    import hashlib

    dest = tmp_path / "models" / "m1"
    dest.mkdir(parents=True)
    (dest / "f1.bin").write_bytes(CONTENT)
    (dest / "LICENSE.txt").write_bytes(b"license text")
    (dest / "README.md").write_bytes(b"upstream readme")
    manifest = {
        "version": 2,
        "base_url": "https://example.com",
        "models": [{
            "name": "m1",
            "repo_id": "org/m1",
            "revision": "a" * 40,
            "license": "MIT",
            "license_url": "https://example.com/org/m1",
            "dest": "models/m1",
            "env": "KITTEN_MODEL_DIR",
            "files": [
                {"name": "f1.bin", "sha256": hashlib.sha256(CONTENT).hexdigest(), "size": len(CONTENT), "role": "model"},
                {"name": "LICENSE.txt", "sha256": hashlib.sha256(b"license text").hexdigest(),
                 "size": 12, "role": "license", "url": "https://spdx.org/licenses/MIT.txt"},
                {"name": "README.md", "sha256": hashlib.sha256(b"upstream readme").hexdigest(),
                 "size": 15, "role": "readme"},
            ],
        }],
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def test_quick_strict_pass(monkeypatch, tmp_path, manifest):
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    errors, n = check_models.check_all(manifest, tmp_path, "quick")
    assert n == 1 and not errors


def test_quick_size_mismatch_fails(monkeypatch, tmp_path, manifest):
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    (tmp_path / "models" / "m1" / "f1.bin").write_bytes(OTHER)
    errors, _ = check_models.check_all(manifest, tmp_path, "quick")
    assert any("大小" in e for e in errors)


def test_full_detects_hash_mismatch(monkeypatch, tmp_path, manifest):
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    (tmp_path / "models" / "m1" / "f1.bin").write_bytes(b"x" * len(CONTENT))  # 同大小不同内容
    assert not check_models.check_all(manifest, tmp_path, "quick")[0]
    errors, _ = check_models.check_all(manifest, tmp_path, "full")
    assert any("sha256" in e for e in errors)


def test_env_override_to_custom_path_is_structural(monkeypatch, tmp_path, manifest):
    # 自定义路径：文件存在即可通过（固定哈希属于特定 revision，不适用）
    custom = tmp_path / "custom-model"
    custom.mkdir()
    (custom / "f1.bin").write_bytes(OTHER)
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(custom))
    errors, _ = check_models.check_all(manifest, tmp_path, "quick")
    assert not errors


def test_env_override_missing_file_fails(monkeypatch, tmp_path, manifest):
    custom = tmp_path / "custom-model"
    custom.mkdir()
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(custom))
    errors, _ = check_models.check_all(manifest, tmp_path, "quick")
    assert any("缺少文件" in e for e in errors)


def test_env_override_same_path_stays_strict(monkeypatch, tmp_path, manifest):
    # 环境变量与 manifest 路径一致时仍是严格校验（换大小应失败）
    monkeypatch.setenv("KITTEN_MODEL_DIR", str(tmp_path / "models" / "m1"))
    (tmp_path / "models" / "m1" / "f1.bin").write_bytes(OTHER)
    errors, _ = check_models.check_all(manifest, tmp_path, "quick")
    assert any("大小" in e for e in errors)


def test_readme_not_required(monkeypatch, tmp_path, manifest):
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    (tmp_path / "models" / "m1" / "README.md").unlink()
    errors, _ = check_models.check_all(manifest, tmp_path, "quick")
    assert not errors


def test_missing_dir_fails(monkeypatch, tmp_path, manifest):
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    import shutil
    shutil.rmtree(tmp_path / "models" / "m1")
    errors, _ = check_models.check_all(manifest, tmp_path, "quick")
    assert any("目录缺失" in e for e in errors)


def test_main_exit_codes(monkeypatch, tmp_path, manifest, capsys):
    monkeypatch.delenv("KITTEN_MODEL_DIR", raising=False)
    assert check_models.main(["--manifest", str(manifest), "--dest-root", str(tmp_path)]) == 0
    bad = tmp_path / "empty-root"
    bad.mkdir()
    assert check_models.main(["--manifest", str(manifest), "--dest-root", str(bad)]) == 1
