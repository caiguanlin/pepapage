"""KittenTTS 本地模型检查：读 config.json、列 voices.npz 声线、打印 ONNX 输入输出，
再用 Bella 和 Jasper 合成同一句英文，核对 WAV 头并比较两份文件的哈希。
运行：cd pepapage-worker && .\\.venv\\Scripts\\python.exe tools/kitten_check.py ["英文句子"]
输出：tmp/kitten-check/Bella.wav、tmp/kitten-check/Jasper.wav
"""
from __future__ import annotations

import hashlib
import json
import sys
import wave
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER))

from worker import tts  # noqa: E402

OUT = WORKER / "tmp" / "kitten-check"


def main() -> int:
    d = tts.model_dir()
    print("模型目录:", d)
    missing = False
    for f in tts.MODEL_FILES:
        p = d / f
        print(f"  {f}: {p.stat().st_size if p.is_file() else '缺失'}")
        missing = missing or not p.is_file()
    if missing:
        print(f"TTS 模型未下载：请把 kitten-cache-micro 放到 KITTEN_MODEL_DIR（当前：{d}）")
        return 1

    cfg = json.loads((d / "config.json").read_text(encoding="utf-8"))
    print("config:", {k: cfg.get(k) for k in ("name", "version", "type", "model_file", "voices")})
    print("voice_aliases:", cfg.get("voice_aliases"))

    import numpy as np
    import onnxruntime as ort

    with np.load(d / cfg.get("voices", "voices.npz")) as v:
        print("voices.npz:", {k: v[k].shape for k in v.files})
    sess = ort.InferenceSession(str(d / cfg["model_file"]), providers=["CPUExecutionProvider"])
    print("onnx 输入:", [(i.name, i.shape, i.type) for i in sess.get_inputs()])
    print("onnx 输出:", [(o.name, o.shape, o.type) for o in sess.get_outputs()])

    text = " ".join(sys.argv[1:]) or "I see a green square."
    print("合成文本:", text)
    hashes: dict[str, str] = {}
    sizes: dict[str, int] = {}
    for name in ("Bella", "Jasper"):
        p = tts.synthesize(text, OUT / f"{name}.wav", name, 1.0)
        with wave.open(str(p), "rb") as w:
            rate, ch, width, frames = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        hashes[name] = hashlib.sha256(p.read_bytes()).hexdigest()
        sizes[name] = p.stat().st_size
        print(f"  {name}: {p} {p.stat().st_size}B {rate}Hz {ch}ch {width * 8}bit "
              f"{frames / rate:.2f}s sha256={hashes[name]}")
        if (rate, ch, width) != (tts.SAMPLE_RATE, 1, 2):
            print("  WAV 格式不符合 24000Hz / 单声道 / 16 位")
            return 1
    same = hashes["Bella"] == hashes["Jasper"]
    print("Bella 与 Jasper 哈希不同:", not same)
    # 注意：模型输出带随机性，同一声线重复合成哈希也会不同；时长（文件大小）对同一声线是稳定的
    print("Bella 与 Jasper 时长不同:", sizes["Bella"] != sizes["Jasper"])
    return 1 if same else 0


if __name__ == "__main__":
    raise SystemExit(main())
