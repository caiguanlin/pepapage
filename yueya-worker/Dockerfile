# yueya-worker CPU 镜像（python:3.10-slim-bookworm，仅 linux amd64）。
# 阶段：models（固定 revision 下载+sha256 校验，独立模型层）→ runtime（依赖+代码+模型，非 root）
#       → test（root 装 pytest 跑全部单测，写成功标记）→ production（默认 target：runtime + 单测成功标记，
#       无 tests/无 pytest）。默认 docker build 即 production；想跳过单测只出运行镜像用 --target runtime。
# 模型清单：tools/models_manifest.json（kitten-tts-micro@1ccf72b2 + faster-whisper-base@ebe41f70，约 190MB）。
# 不复制本地 models/.venv/.env（见 .dockerignore）；不装 torch（kittenml --no-deps）。
#
# 构建：docker build -t yueya-worker:cpu .
# 无网冒烟：docker run --rm --network none --entrypoint python yueya-worker:cpu -m tools.container_smoke
# 运行（环境变量见 .env.example；Redis 可 REDIS_URL 或 REDIS_HOST/PORT/PASSWORD/DB）：
#   docker run --rm -e REDIS_URL=... -e SERVER_BASE_URL=... -e WORKER_TOKEN=... \
#     -e OSS_ENDPOINT=... -e OSS_BUCKET=... -e OSS_ACCESS_KEY_ID=... -e OSS_ACCESS_KEY_SECRET=... yueya-worker:cpu
# 可选：--build-arg MODEL_BASE_URL=https://hf-mirror.com、--build-arg PIP_INDEX_URL=<PyPI镜像>

FROM python:3.10-slim-bookworm AS models
WORKDIR /build
COPY tools/models_manifest.json tools/fetch_models.py ./
ARG MODEL_BASE_URL=https://huggingface.co
RUN python fetch_models.py --manifest models_manifest.json --dest-root / --base-url "${MODEL_BASE_URL}"

FROM python:3.10-slim-bookworm AS runtime
ARG PIP_INDEX_URL=https://pypi.org/simple
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    TMPDIR=/tmp \
    KITTEN_MODEL_DIR=/models/kitten-tts-micro \
    WHISPER_MODEL=/models/faster-whisper-base \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE=int8 \
    HF_HUB_OFFLINE=1 \
    HF_HOME=/tmp/hf \
    WORKER_CPU_THREADS=2
# cv2 需要 libgl1/libglib2.0-0，onnxruntime/ctranslate2 需要 libgomp1；
# espeak-ng 与 ffmpeg 由 wheel 自带（espeakng-loader / PyAV），不需要 apt 安装
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements-lock.txt \
 && pip install --no-cache-dir --no-deps "kittenml==0.9.7"
COPY worker/ ./worker/
COPY tools/__init__.py tools/fetch_models.py tools/check_models.py tools/container_smoke.py tools/models_manifest.json ./tools/
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN sed -i 's/\r$//' ./docker/entrypoint.sh && chmod 0755 ./docker/entrypoint.sh
COPY --from=models /models/ /models/
USER 10001:10001
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["python", "-m", "worker.main"]

# 单测阶段：root 装 pytest（不进 production），跑完全部单测并写成功标记；失败则后续 COPY 失败
FROM runtime AS test
USER root
RUN pip install --no-cache-dir pytest==9.2.0
COPY tests/ ./tests/
RUN python -m pytest -q tests && touch /tmp/tests-passed

# 默认产出：runtime 之上只叠加单测成功标记（证明该镜像依赖树通过了全部单测）
FROM runtime AS production
COPY --from=test /tmp/tests-passed /tmp/tests-passed
