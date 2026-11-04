"""Redis 连接串组装：REDIS_URL 优先；独立 REDIS_HOST/PORT/PASSWORD/DB 拼接（密码 URL 编码）。"""
from __future__ import annotations

import pytest

from worker import main


def test_explicit_url_wins(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://:secret@cache:6379/3")
    monkeypatch.setenv("REDIS_HOST", "should-be-ignored")
    assert main.redis_url() == "redis://:secret@cache:6379/3"


def test_independent_vars_with_password(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_HOST", "redis")
    monkeypatch.setenv("REDIS_PORT", "6380")
    # 密码含 URL 特殊字符：@ 空格 /
    monkeypatch.setenv("REDIS_PASSWORD", "p@ss word/1")
    monkeypatch.setenv("REDIS_DB", "2")
    assert main.redis_url() == "redis://:p%40ss%20word%2F1@redis:6380/2"


def test_independent_vars_defaults(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_PORT", raising=False)
    monkeypatch.delenv("REDIS_DB", raising=False)
    monkeypatch.setenv("REDIS_HOST", "redis")
    monkeypatch.delenv("REDIS_PASSWORD", raising=False)
    assert main.redis_url() == "redis://redis:6379/0"


def test_missing_config_keeps_local_dev_default(monkeypatch):
    # 保留原开发默认：REDIS_URL 与 REDIS_HOST 都未设置时回退 localhost（容器入口另有必填预检）
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("REDIS_HOST", raising=False)
    assert main.redis_url() == "redis://localhost:6379/0"


def test_blank_values_treated_as_unset(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "   ")
    monkeypatch.setenv("REDIS_HOST", "  ")
    assert main.redis_url() == "redis://localhost:6379/0"
