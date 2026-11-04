#!/bin/sh
# yueya-worker 容器入口：启动前校验（Redis 配置、模型目录、CPU 线程），通过后 exec 真正进程。
# 只用 sh（slim 镜像无 bash）；不改任何开发逻辑，worker.main 仍由 CMD 启动。
# 无网冒烟绕过本入口：docker run --network none --entrypoint python <image> -m tools.container_smoke
set -eu

# CPU 线程：WORKER_CPU_THREADS（镜像默认 2，可用 -e 覆盖；显式设置 OMP_NUM_THREADS 时完全尊重用户值）
if [ -n "${WORKER_CPU_THREADS:-}" ] && [ -z "${OMP_NUM_THREADS:-}" ]; then
    export OMP_NUM_THREADS="$WORKER_CPU_THREADS"
    export OPENBLAS_NUM_THREADS="$WORKER_CPU_THREADS"
    export MKL_NUM_THREADS="$WORKER_CPU_THREADS"
    export NUMEXPR_NUM_THREADS="$WORKER_CPU_THREADS"
    echo "[entrypoint] CPU 线程=$WORKER_CPU_THREADS (OMP/MKL/OPENBLAS/NUMEXPR)"
fi

# Redis 配置提前失败，给出明确提示（worker.main 对 REDIS_URL 与 REDIS_HOST/PORT/PASSWORD/DB 都支持）
if [ -z "${REDIS_URL:-}" ] && [ -z "${REDIS_HOST:-}" ]; then
    echo "[entrypoint] 缺少 Redis 配置：请设置 REDIS_URL，或 REDIS_HOST（可含 REDIS_PORT/REDIS_PASSWORD/REDIS_DB）" >&2
    exit 1
fi

# 模型启动校验：quick=存在+大小（默认）；CHECK_MODELS=full 校验 sha256；CHECK_MODELS=skip 跳过
case "${CHECK_MODELS:-quick}" in
    skip) echo "[entrypoint] 跳过模型校验（CHECK_MODELS=skip）" ;;
    full) python -m tools.check_models --mode full --dest-root / ;;
    *)    python -m tools.check_models --mode quick --dest-root / ;;
esac

echo "[entrypoint] 校验通过，启动：$*"
exec "$@"
