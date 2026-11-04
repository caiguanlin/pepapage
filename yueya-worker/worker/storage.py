"""项目文件存储：OSS（生产）与本地目录（测试）两种实现，接口一致。"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


class Storage:
    """以项目前缀为根的文件读写。name 为相对项目目录的文件名，如 book-ocr.json。"""

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix if prefix.endswith("/") else prefix + "/"

    def key(self, name: str) -> str:
        if name.startswith(self.prefix):
            return name
        return self.prefix + name.lstrip("/")

    # --- 子类实现 ---
    def read_bytes(self, name: str) -> bytes:
        raise NotImplementedError

    def write_bytes(self, name: str, data: bytes, content_type: str | None = None) -> str:
        raise NotImplementedError

    def exists(self, name: str) -> bool:
        raise NotImplementedError

    def download_to(self, name: str, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.read_bytes(name))
        return path

    def upload_from(self, name: str, path: Path, content_type: str | None = None) -> str:
        return self.write_bytes(name, Path(path).read_bytes(), content_type)

    # --- JSON helpers ---
    def read_json(self, name: str, default: Any = None) -> Any:
        if not self.exists(name):
            return default
        try:
            return json.loads(self.read_bytes(name).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return default

    def write_json(self, name: str, obj: Any) -> str:
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return self.write_bytes(name, data, "application/json")


class LocalStorage(Storage):
    def __init__(self, root: Path, prefix: str = "") -> None:
        super().__init__(prefix or "project/")
        self.root = Path(root)

    def _path(self, name: str) -> Path:
        return self.root / self.key(name)

    def read_bytes(self, name: str) -> bytes:
        p = self._path(name)
        if not p.exists():
            raise FileNotFoundError(f"文件不存在：{self.key(name)}")
        return p.read_bytes()

    def write_bytes(self, name: str, data: bytes, content_type: str | None = None) -> str:
        p = self._path(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return self.key(name)

    def exists(self, name: str) -> bool:
        return self._path(name).exists()


class OssStorage(Storage):
    def __init__(self, prefix: str, bucket: Any) -> None:
        super().__init__(prefix)
        self.bucket = bucket

    @classmethod
    def from_env(cls, prefix: str) -> "OssStorage":
        import oss2

        endpoint = os.getenv("OSS_ENDPOINT", "")
        bucket_name = os.getenv("OSS_BUCKET", "")
        ak = os.getenv("OSS_ACCESS_KEY_ID", "")
        sk = os.getenv("OSS_ACCESS_KEY_SECRET", "")
        if not (endpoint and bucket_name and ak and sk):
            raise RuntimeError("worker 未配置 OSS（OSS_ENDPOINT/OSS_BUCKET/OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET）")
        bucket = oss2.Bucket(oss2.Auth(ak, sk), endpoint, bucket_name)
        return cls(prefix, bucket)

    def read_bytes(self, name: str) -> bytes:
        import oss2

        try:
            return self.bucket.get_object(self.key(name)).read()
        except oss2.exceptions.NoSuchKey as e:
            raise FileNotFoundError(f"OSS 文件不存在：{self.key(name)}") from e

    def write_bytes(self, name: str, data: bytes, content_type: str | None = None) -> str:
        headers = {"Content-Type": content_type} if content_type else None
        self.bucket.put_object(self.key(name), data, headers=headers)
        return self.key(name)

    def download_to(self, name: str, path: Path) -> Path:
        import oss2

        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.bucket.get_object_to_file(self.key(name), str(path))
        except oss2.exceptions.NoSuchKey as e:
            raise FileNotFoundError(f"OSS 文件不存在：{self.key(name)}") from e
        return path

    def upload_from(self, name: str, path: Path, content_type: str | None = None) -> str:
        import oss2

        headers = {"Content-Type": content_type} if content_type else None
        oss2.resumable_upload(self.bucket, self.key(name), str(path), headers=headers)
        return self.key(name)

    def exists(self, name: str) -> bool:
        return bool(self.bucket.object_exists(self.key(name)))


def project_prefix(detail: dict[str, Any]) -> str:
    """优先使用任务详情的 ossPrefix；否则按契约拼 users/{userId}/book-projects/{projectId}/。"""
    prefix = detail.get("ossPrefix")
    if prefix:
        return prefix if prefix.endswith("/") else prefix + "/"
    project = detail.get("project") or {}
    user_id = detail.get("userId") or project.get("userId")
    project_id = project.get("id") or detail.get("projectId")
    if user_id is None or project_id is None:
        raise RuntimeError("任务详情缺少 ossPrefix，且无法从 userId/projectId 推导项目路径")
    return f"users/{user_id}/book-projects/{project_id}/"
