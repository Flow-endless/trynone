#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从视频中均匀抽取若干帧，用 BLIP 生成英文画面描述（便于 Java 侧交给 DeepSeek 翻成中文并推理）。
可选依赖：见项目根目录 requirements-video-understand.txt（torch + transformers + Pillow）。
未安装时输出 frames 为空并带 note，流水线仍可仅用 YOLO 事件 + 语音。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def _ffprobe_duration(video: Path) -> float:
    exe = shutil.which("ffmpeg")
    if not exe:
        return 0.0
    try:
        r = subprocess.run(
            [
                exe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if r.returncode == 0 and r.stdout.strip():
            return max(0.0, float(r.stdout.strip()))
    except Exception:
        pass
    return 0.0


def _extract_jpeg(video: Path, t_sec: float, out: Path) -> bool:
    exe = shutil.which("ffmpeg")
    if not exe:
        return False
    try:
        r = subprocess.run(
            [
                exe,
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                str(max(0.0, t_sec)),
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-q:v",
                "2",
                "-y",
                str(out),
            ],
            capture_output=True,
            timeout=120,
        )
        return r.returncode == 0 and out.exists() and out.stat().st_size > 100
    except Exception:
        return False


def _caption_with_blip(paths: list[tuple[float, Path]]) -> list[dict[str, Any]]:
    try:
        from PIL import Image
        from transformers import BlipForConditionalGeneration, BlipProcessor
    except ImportError as e:
        raise RuntimeError(
            "未安装 BLIP 依赖。请在项目根执行："
            ".venv\\Scripts\\python.exe -m pip install -r requirements-video-understand.txt"
        ) from e

    device = "cpu"
    mid = "Salesforce/blip-image-captioning-base"
    processor = BlipProcessor.from_pretrained(mid)
    model = BlipForConditionalGeneration.from_pretrained(mid).to(device)
    model.eval()

    out: list[dict[str, Any]] = []
    for t_sec, p in paths:
        try:
            image = Image.open(p).convert("RGB")
            inputs = processor(images=image, return_tensors="pt").to(device)
            generated = model.generate(**inputs, max_length=60)
            cap = processor.decode(generated[0], skip_special_tokens=True).strip()
            out.append({"time": round(float(t_sec), 2), "caption_en": cap})
        except Exception as ex:
            out.append({"time": round(float(t_sec), 2), "caption_en": f"(caption error: {ex})"})
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--max-frames", type=int, default=8)
    args = parser.parse_args()
    vp = Path(args.input)
    if not vp.exists():
        print(json.dumps({"error": f"not found: {vp}"}, ensure_ascii=False))
        sys.exit(2)

    max_f = max(2, min(16, int(args.max_frames)))
    dur = _ffprobe_duration(vp)
    if dur <= 0:
        dur = 60.0
    n = min(max_f, max(2, int(dur / 4) + 1))
    lo, hi = 0.5, max(0.6, dur - 0.25)
    if n <= 1:
        times = [lo]
    else:
        step = (hi - lo) / (n - 1) if hi > lo else 0.0
        times = [round(lo + i * step, 3) for i in range(n)]

    if not shutil.which("ffmpeg"):
        print(
            json.dumps(
                {
                    "engine": "none",
                    "frames": [],
                    "note": "未找到 ffmpeg（PATH），无法抽帧。请安装 ffmpeg 并配置 PATH。",
                },
                ensure_ascii=False,
            )
        )
        return

    frames_payload: list[dict[str, Any]] = []
    try:
        with tempfile.TemporaryDirectory(prefix="vcap-") as td:
            tdir = Path(td)
            pairs: list[tuple[float, Path]] = []
            for i, t in enumerate(times):
                jpg = tdir / f"f{i}.jpg"
                if _extract_jpeg(vp, t, jpg):
                    pairs.append((t, jpg))
            if not pairs:
                print(
                    json.dumps(
                        {
                            "engine": "none",
                            "frames": [],
                            "note": "ffmpeg 抽帧失败，请确认视频编码可读。",
                        },
                        ensure_ascii=False,
                    )
                )
                return
            frames_payload = _caption_with_blip(pairs)
        print(
            json.dumps(
                {"engine": "blip-base", "frames": frames_payload, "note": ""},
                ensure_ascii=False,
            )
        )
    except RuntimeError as e:
        print(
            json.dumps(
                {
                    "engine": "none",
                    "frames": [],
                    "note": str(e),
                },
                ensure_ascii=False,
            )
        )
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
        sys.exit(2)


if __name__ == "__main__":
    main()
