#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音频转写桥接：faster-whisper（CPU int8），输出 JSON 到 stdout。
依赖：pip install faster-whisper opencc-python-reimplemented
首次运行会下载 tiny/base 等模型。
说明：Whisper 对中文常输出繁体，默认对 zh 结果做 OpenCC 繁转简（与界面「中文」一致）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional


def bcp47_to_whisper_lang(bcp: str) -> Optional[str]:
    """BCP-47 -> Whisper 语言码；None 表示自动检测。"""
    if not bcp or not str(bcp).strip():
        return None
    s = str(bcp).strip().replace("_", "-").lower()
    if s.startswith("zh"):
        return "zh"
    if s.startswith("en"):
        return "en"
    if s.startswith("ja"):
        return "ja"
    if s.startswith("ko"):
        return "ko"
    if s.startswith("fr"):
        return "fr"
    if s.startswith("de"):
        return "de"
    if s.startswith("es"):
        return "es"
    return None


def should_use_simplified_zh(bcp: str, detected: Optional[str]) -> bool:
    """是否对中文结果做繁转简（简体界面默认开启）。"""
    if os.environ.get("WHISPER_SIMPLIFIED_ZH", "1").strip().lower() in ("0", "false", "no", "off"):
        return False
    if bcp and str(bcp).strip().replace("_", "-").lower().startswith("zh"):
        return True
    if detected and str(detected).lower().startswith("zh"):
        return True
    return False


def to_simplified_chinese(text: str) -> tuple[str, bool, Optional[str]]:
    """繁体 -> 简体。返回 (文本, 是否成功调用 OpenCC, 失败原因供 stderr，仅非 ImportError 时有)。"""
    if not (text or "").strip():
        return text, False, None
    try:
        from opencc import OpenCC

        cc = OpenCC("t2s")
        return cc.convert(text), True, None
    except ImportError as e:
        return text, False, f"ImportError: {e}"
    except Exception as e:
        # 已安装但运行期失败（字典损坏等），保留繁体原文
        return text, False, f"{type(e).__name__}: {e}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="音频文件路径")
    parser.add_argument(
        "--lang",
        default="",
        help="BCP-47 语言，如 zh-CN；空则自动检测",
    )
    args = parser.parse_args()

    path = Path(args.input)
    if not path.exists():
        raise FileNotFoundError(f"input not found: {path}")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        err = {
            "error": "缺少 faster-whisper，请在 venv 中执行: pip install faster-whisper（见 requirements-audio.txt）"
        }
        sys.stderr.write(json.dumps(err, ensure_ascii=False))
        sys.exit(2)

    model_size = (os.environ.get("WHISPER_MODEL") or "tiny").strip() or "tiny"
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    ctype = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

    try:
        model = WhisperModel(model_size, device=device, compute_type=ctype)
    except Exception as hub_exc:
        hint = (
            "从 Hugging Face 加载模型失败（常见：网络超时）。"
            "可在 application.yml 的 multimodal.audio.hf-endpoint 设为 https://hf-mirror.com ，"
            "或在系统环境变量中设置 HF_ENDPOINT 后重试；也可在能访问外网的机器上先下载模型到本机缓存。"
        )
        err = {"error": f"{type(hub_exc).__name__}: {hub_exc}\n{hint}"}
        sys.stderr.write(json.dumps(err, ensure_ascii=False))
        sys.exit(2)

    lang = bcp47_to_whisper_lang(args.lang)
    # 引导模型倾向简体中文（不保证，主要靠下方 OpenCC）
    initial_prompt: Optional[str] = None
    if lang == "zh" or (args.lang and str(args.lang).strip().lower().startswith("zh")):
        initial_prompt = "以下是普通话简体中文口语内容。"

    transcribe_kw: dict[str, Any] = {
        "beam_size": 5,
        "vad_filter": True,
    }
    if initial_prompt:
        transcribe_kw["initial_prompt"] = initial_prompt

    segments_iter, info = model.transcribe(str(path), language=lang, **transcribe_kw)

    parts: list[str] = []
    for seg in segments_iter:
        t = (seg.text or "").strip()
        if t:
            parts.append(t)

    detected = getattr(info, "language", None)
    if lang == "zh" or (detected or "").startswith("zh"):
        text = "".join(parts)
    else:
        text = " ".join(parts)

    text = (text or "").strip()
    had_transcript = bool(text)

    simplified_applied = False
    opencc_ok = False
    opencc_detail: Optional[str] = None
    want_simplified = should_use_simplified_zh(args.lang or "", detected)
    if want_simplified and had_transcript:
        text, opencc_ok, opencc_detail = to_simplified_chinese(text)
        simplified_applied = opencc_ok
        if opencc_detail and os.environ.get("AUDIO_ASR_DEBUG", "").strip() in ("1", "true", "yes"):
            print(f"[audio_transcribe] python={sys.executable!s} opencc={opencc_detail}", file=sys.stderr)

    out: dict[str, Any] = {
        "text": text,
        "transcript": text,
        "engine": "faster-whisper",
        "whisperModel": model_size,
        "detectedLanguage": detected,
        "simplifiedZh": simplified_applied,
    }
    if not had_transcript:
        out["note"] = (
            "未识别到语音内容：可能是麦克风音量过低、录音过短、或浏览器录制的 webm 几乎无声。"
            "请延长录音并提高系统麦克风输入音量；若上传 mp3/wav 可正常转写，则说明问题在浏览器录音链路。"
        )
    elif want_simplified and not opencc_ok:
        if opencc_detail and opencc_detail.startswith("ImportError"):
            out["warning"] = (
                "转写已输出，但未能加载 OpenCC，无法自动繁转简。请在 **当前 application.yml 指向的同一 venv** 中执行："
                "pip install opencc-python-reimplemented"
            )
        else:
            out["warning"] = f"转写已输出，但 OpenCC 繁转简失败（仍保留识别原文）：{opencc_detail}"

    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        err = {"error": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(json.dumps(err, ensure_ascii=False))
        sys.exit(2)
