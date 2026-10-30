"""调用 Spring Boot 的 /internal 接口（X-Worker-Token 鉴权）。"""
from __future__ import annotations

from typing import Any

import requests


class ServerClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["X-Worker-Token"] = token

    # ---- 制作任务
    def task_detail(self, task_id: str) -> dict[str, Any]:
        res = self.session.get(f"{self.base_url}/internal/tasks/{task_id}", timeout=15)
        return self._unwrap(res)

    def report(self, task_id: str, **fields: Any) -> None:
        body = {k: v for k, v in fields.items() if v is not None}
        res = self.session.post(f"{self.base_url}/internal/tasks/{task_id}/progress", json=body, timeout=15)
        self._unwrap(res)

    # ---- 导出任务（只回调 exports，不回调 tasks progress，避免改项目状态）
    def export_detail(self, export_id: str) -> dict[str, Any]:
        res = self.session.get(f"{self.base_url}/internal/exports/{export_id}", timeout=15)
        return self._unwrap(res)

    def report_export(self, export_id: str, **fields: Any) -> None:
        body = {k: v for k, v in fields.items() if v is not None}
        res = self.session.post(f"{self.base_url}/internal/exports/{export_id}/progress", json=body, timeout=15)
        self._unwrap(res)

    @staticmethod
    def _unwrap(res: requests.Response) -> Any:
        try:
            data = res.json()
        except ValueError:
            res.raise_for_status()
            raise
        if res.status_code >= 400 or data.get("code") != 0:
            raise RuntimeError(f"server error {res.status_code}: {data.get('message')}")
        return data.get("data")
