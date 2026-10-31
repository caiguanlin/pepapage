"""消费 Redis Stream 中的任务。

任务类型：book_full / book_realign / book_tts / book_export / library_asr。
运行：python -m worker.main
"""
from __future__ import annotations

import logging
import os
import signal
import time

import redis
from dotenv import load_dotenv

from .library import run_library_asr
from .pipeline import run_book_export, run_book_full, run_book_realign, run_book_tts
from .server_client import ServerClient

log = logging.getLogger("worker")

BLOCK_MS = 5000
# redis-py 8 默认 socket 读超时 5 秒，与阻塞读等长，远程 Redis 加上网络延迟就会超时；读超时必须大于阻塞时长
SOCKET_TIMEOUT = 30


def main() -> None:
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    stream = os.getenv("TASK_STREAM", "pepapage:tasks")
    group = os.getenv("CONSUMER_GROUP", "book-workers")
    consumer = os.getenv("CONSUMER_NAME", "worker-1")
    r = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"), decode_responses=True,
                             socket_timeout=SOCKET_TIMEOUT)
    server = ServerClient(os.getenv("SERVER_BASE_URL", "http://localhost:8080"), os.getenv("WORKER_TOKEN", ""))

    try:
        r.xgroup_create(stream, group, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise

    stopping = False

    def stop(*_: object) -> None:
        nonlocal stopping
        stopping = True
        log.info("收到退出信号，处理完当前任务后退出")

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    log.info("worker %s 监听 %s（组 %s）", consumer, stream, group)
    # 先处理本 consumer 之前未 ACK 的消息（崩溃恢复），再读新消息
    pending_first = True
    while not stopping:
        start_id = "0" if pending_first else ">"
        try:
            resp = r.xreadgroup(group, consumer, {stream: start_id}, count=1, block=BLOCK_MS)
        except (redis.ConnectionError, redis.TimeoutError):
            log.warning("Redis 连接失败或读取超时，5 秒后重试", exc_info=True)
            time.sleep(5)
            continue
        messages = resp[0][1] if resp else []
        if not messages:
            pending_first = False
            continue
        for msg_id, fields in messages:
            handle(server, fields)
            r.xack(stream, group, msg_id)


def handle(server: ServerClient, fields: dict[str, str]) -> None:
    task_id = fields.get("taskId")
    task_type = fields.get("taskType")
    log.info("开始任务 %s (%s)", task_id, task_type)
    if task_type == "book_export":
        export_id = fields.get("exportId")
        if not export_id:
            log.error("book_export 消息缺少 exportId：%s", fields)
            return
        # 导出只回调 /internal/exports/{id}/progress，异常在内部上报
        run_book_export(server, export_id, fields)
        return
    if task_type == "library_asr":
        # 音频库识别只回调 /internal/tasks/{id}/library-progress 更新清单项，异常在内部上报，绝不改项目状态
        run_library_asr(server, task_id, fields)
        return
    try:
        detail = server.task_detail(task_id)
        if task_type == "book_full":
            run_book_full(server, task_id, detail)
        elif task_type == "book_realign":
            run_book_realign(server, task_id, detail)
        elif task_type == "book_tts":
            run_book_tts(server, task_id, detail)
        else:
            server.report(task_id, projectStatus="failed", error=f"未知任务类型 {task_type}")
    except Exception:  # noqa: BLE001
        log.exception("任务 %s 异常", task_id)
        try:
            server.report(task_id, projectStatus="failed", error="worker 处理异常")
        except Exception:  # noqa: BLE001
            log.exception("上报失败状态也失败了")


if __name__ == "__main__":
    main()
