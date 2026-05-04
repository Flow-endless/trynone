#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
视频分析桥接：基于 Ultralytics YOLO 对视频抽帧检测 + 简单场景切换估计。
任务：
  detect    -> duration, events, detections（与前端 video-analysis.js 约定字段）
  keyframes -> frames[{time, caption}]
  report    -> summary, bullets（由统计生成，非大模型）
  asr       -> 提取音轨 + faster-whisper 分段字幕（需 ffmpeg 与 faster-whisper）

依赖：与 requirements-vision.txt 一致；ASR 另需 faster-whisper（与 audio 共用 venv）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Optional

import numpy as np

os.environ.setdefault("HF_ENDPOINT", os.environ.get("HF_ENDPOINT", "https://hf-mirror.com"))

from yolo_weights import resolve_yolo_weights

# ---------- COCO 80 类中文（与 Ultralytics YOLOv8 默认类别一致）----------
_LABEL_ZH: dict[str, str] = {
    "person": "人物",
    "bicycle": "自行车",
    "car": "汽车",
    "motorcycle": "摩托车",
    "airplane": "飞机",
    "bus": "公交车",
    "train": "火车",
    "truck": "卡车",
    "boat": "船",
    "traffic light": "交通信号灯",
    "fire hydrant": "消防栓",
    "stop sign": "停车标志",
    "parking meter": "停车计时器",
    "bench": "长椅",
    "bird": "鸟",
    "cat": "猫",
    "dog": "狗",
    "horse": "马",
    "sheep": "羊",
    "cow": "牛",
    "elephant": "大象",
    "bear": "熊",
    "zebra": "斑马",
    "giraffe": "长颈鹿",
    "backpack": "背包",
    "umbrella": "伞",
    "handbag": "手提包",
    "tie": "领带",
    "suitcase": "手提箱",
    "frisbee": "飞盘",
    "skis": "滑雪板",
    "snowboard": "滑雪单板",
    "sports ball": "运动球",
    "kite": "风筝",
    "baseball bat": "棒球棒",
    "baseball glove": "棒球手套",
    "skateboard": "滑板",
    "surfboard": "冲浪板",
    "tennis racket": "网球拍",
    "bottle": "瓶子",
    "wine glass": "酒杯",
    "cup": "杯子",
    "fork": "叉子",
    "knife": "刀",
    "spoon": "勺子",
    "bowl": "碗",
    "banana": "香蕉",
    "apple": "苹果",
    "sandwich": "三明治",
    "orange": "橙子",
    "broccoli": "西兰花",
    "carrot": "胡萝卜",
    "hot dog": "热狗",
    "pizza": "披萨",
    "donut": "甜甜圈",
    "cake": "蛋糕",
    "chair": "椅子",
    "couch": "沙发",
    "potted plant": "盆栽",
    "bed": "床",
    "dining table": "餐桌",
    "toilet": "马桶",
    "tv": "电视",
    "laptop": "笔记本电脑",
    "mouse": "鼠标",
    "remote": "遥控器",
    "keyboard": "键盘",
    "cell phone": "手机",
    "microwave": "微波炉",
    "oven": "烤箱",
    "toaster": "烤面包机",
    "sink": "水槽",
    "refrigerator": "冰箱",
    "book": "书",
    "clock": "时钟",
    "vase": "花瓶",
    "scissors": "剪刀",
    "teddy bear": "泰迪熊",
    "hair drier": "吹风机",
    "toothbrush": "牙刷",
}


def _zh_label(name: str) -> str:
    return _LABEL_ZH.get(str(name).lower(), name)


def _norm_label(name: str) -> str:
    return str(name).strip().lower()


# 古装剧/老胶片等场景下，YOLO 易把纹理误检为现代电子设备；需跨多帧重复出现才采信
_EPHEMERAL_FALSE_POSITIVE_LABELS = frozenset(
    {
        "laptop",
        "tv",
        "cell phone",
        "keyboard",
        "mouse",
        "remote",
        "microwave",
        "oven",
        "toaster",
        "refrigerator",
    }
)


def _is_ephemeral_fp_label(label: str) -> bool:
    return _norm_label(label) in _EPHEMERAL_FALSE_POSITIVE_LABELS


def _box_to_pct(xyxy: list[float], w: float, h: float) -> list[float]:
    x1, y1, x2, y2 = xyxy
    bx = max(0.0, min(100.0, x1 / w * 100.0))
    by = max(0.0, min(100.0, y1 / h * 100.0))
    bw = max(0.1, min(100.0, (x2 - x1) / w * 100.0))
    bh = max(0.1, min(100.0, (y2 - y1) / h * 100.0))
    return [round(bx, 2), round(by, 2), round(bw, 2), round(bh, 2)]


def _hist_diff(gray_a: np.ndarray, gray_b: np.ndarray) -> float:
    h1 = np.histogram(gray_a.flatten(), bins=32, range=(0, 256))[0].astype(np.float64)
    h2 = np.histogram(gray_b.flatten(), bins=32, range=(0, 256))[0].astype(np.float64)
    h1 /= max(1e-6, h1.sum())
    h2 /= max(1e-6, h2.sum())
    return float(np.abs(h1 - h2).sum() * 0.5)


def _load_yolo(model_name: str):
    try:
        from ultralytics import YOLO
    except Exception as e:
        raise RuntimeError("缺少 ultralytics，请 pip install -r requirements-vision.txt") from e
    weights = resolve_yolo_weights(model_name)
    return YOLO(weights), weights


def _predict_frame(model, frame_bgr: np.ndarray, conf: float, imgsz: int):
    r = model.predict(
        source=frame_bgr,
        verbose=False,
        conf=conf,
        iou=0.45,
        imgsz=imgsz,
        max_det=50,
    )[0]
    names = getattr(r, "names", {}) or {}
    dets: list[dict[str, Any]] = []
    h = float(r.orig_shape[0]) if r.orig_shape else frame_bgr.shape[0]
    w = float(r.orig_shape[1]) if r.orig_shape else frame_bgr.shape[1]
    if r.boxes is not None and len(r.boxes) > 0:
        xyxy = r.boxes.xyxy.cpu().numpy()
        cls = r.boxes.cls.cpu().numpy()
        cf = r.boxes.conf.cpu().numpy()
        for i in range(len(xyxy)):
            x1, y1, x2, y2 = [float(v) for v in xyxy[i]]
            label = names.get(int(cls[i]), str(int(cls[i])))
            c = float(cf[i])
            dets.append(
                {
                    "label": str(label),
                    "confidence": round(c, 4),
                    "box": _box_to_pct([x1, y1, x2, y2], w, h),
                }
            )
    return dets, (h, w)


def analyze_video_yolo(
    video_path: Path,
    model_name: str,
    conf: float,
    imgsz: int,
) -> dict[str, Any]:
    try:
        import cv2
    except Exception as e:
        raise RuntimeError("缺少 opencv，请 pip install opencv-python-headless") from e

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")

    try:
        fps = float(cap.get(cv2.CAP_PROP_FPS)) or 25.0
        nframes = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        duration = nframes / fps if fps > 0 else 0.0
        if duration <= 0:
            cap.set(cv2.CAP_PROP_POS_AVCODEC, 0)
            duration = 30.0

        model, weights_used = _load_yolo(model_name)
        iz = max(320, min(1280, int(imgsz)))

        # 采样：约每秒 1 帧，总长最多 VIDEO_YOLO_MAX_SAMPLES（默认 80，略快于 120）
        target_stride_sec = 1.0
        _yms = os.environ.get("VIDEO_YOLO_MAX_SAMPLES", "80").strip()
        max_samples = max(40, min(120, int(_yms if _yms else "80")))
        stride_frames = max(1, int(fps * target_stride_sec))
        est_samples = max(1, nframes // stride_frames) if nframes > 0 else max_samples
        if est_samples > max_samples:
            stride_frames = int(nframes / max_samples) + 1

        samples: list[dict[str, Any]] = []
        prev_gray: Optional[np.ndarray] = None
        prev_labels: set[str] = set()
        prev_person = False
        frame_idx = 0
        class_hits: dict[str, int] = {}

        events: list[dict[str, Any]] = []
        keyframe_hints: list[dict[str, Any]] = []

        def push_event(
            etype: str,
            t: float,
            title: str,
            desc: str,
            *,
            yolo_label: str | None = None,
        ) -> None:
            ev: dict[str, Any] = {
                "type": etype,
                "time": round(t, 2),
                "title": title,
                "desc": desc,
            }
            if yolo_label:
                ev["yoloLabel"] = yolo_label
            events.append(ev)

        label_best_det: dict[str, dict[str, Any]] = {}

        while True:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ok, frame = cap.read()
            if not ok:
                break
            tsec = frame_idx / fps if fps > 0 else 0.0
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            dets, _shape = _predict_frame(model, frame, conf, iz)
            labels_now = {d["label"] for d in dets}
            for d in dets:
                lab = d["label"]
                class_hits[lab] = class_hits.get(lab, 0) + 1
                prev_bd = label_best_det.get(lab)
                if prev_bd is None or float(d.get("confidence") or 0) > float(prev_bd.get("confidence") or 0):
                    label_best_det[lab] = d

            if prev_gray is not None:
                diff = _hist_diff(prev_gray, gray)
                if diff > 0.38 and tsec > 0.5:
                    push_event("cut", tsec, "场景变化", f"画面内容发生明显变化（直方图差异 {diff:.2f}）")
                    keyframe_hints.append({"time": tsec, "caption": f"场景切换 · {tsec:.1f}s"})

            if frame_idx > 0:
                new_labs = labels_now - prev_labels
                for lab in sorted(new_labs):
                    push_event(
                        "person",
                        tsec,
                        f"检测到 {_zh_label(lab)}",
                        f"在 {tsec:.1f}s 附近出现类别 {lab}",
                        yolo_label=lab,
                    )

            has_person = "person" in labels_now
            if prev_person and not has_person and tsec > 1.0:
                push_event("disappear", tsec, "目标离开画面", f"人物/主要目标在 {tsec:.1f}s 附近消失")
            prev_person = has_person

            prev_gray = gray
            prev_labels = labels_now
            samples.append({"t": round(tsec, 2), "n": len(dets), "labels": list(labels_now)})
            frame_idx += stride_frames
            if tsec >= duration * 0.999 and duration > 0:
                break
            if nframes > 0 and frame_idx >= nframes:
                break

        sample_n = max(1, len(samples))
        min_ephemeral_hits = max(3, int(0.04 * sample_n))

        def ephemeral_ok(lab: str) -> bool:
            if not _is_ephemeral_fp_label(lab):
                return True
            return class_hits.get(lab, 0) >= min_ephemeral_hits

        events = [
            e
            for e in events
            if not (
                e.get("yoloLabel")
                and _is_ephemeral_fp_label(str(e["yoloLabel"]))
                and class_hits.get(str(e["yoloLabel"]), 0) < min_ephemeral_hits
            )
        ]

        labels_ranked = sorted(class_hits.keys(), key=lambda k: (-class_hits[k], str(k)))
        detections_out: list[dict[str, Any]] = []
        for lab in labels_ranked:
            if not ephemeral_ok(lab):
                continue
            bd = label_best_det.get(lab)
            if bd:
                detections_out.append(bd)
            if len(detections_out) >= 6:
                break

        if not detections_out:
            for lab in labels_ranked:
                if not ephemeral_ok(lab):
                    continue
                bd = label_best_det.get(lab)
                if bd:
                    detections_out.append(bd)
                if len(detections_out) >= 4:
                    break

        for i in range(1, len(samples)):
            da = samples[i - 1]["n"]
            db = samples[i]["n"]
            if abs(db - da) >= 2 and samples[i]["t"] > 0.2:
                tt = samples[i]["t"]
                keyframe_hints.append(
                    {
                        "time": tt,
                        "caption": f"目标数量变化 {da}→{db} · {tt:.1f}s",
                    }
                )

        kh_sorted = sorted({json.dumps(x, sort_keys=True): x for x in keyframe_hints}.values(), key=lambda x: x["time"])
        kh_sorted = kh_sorted[:12]
        if not kh_sorted and duration > 0:
            kh_sorted = [
                {"time": round(duration * 0.25, 2), "caption": "采样分析中段"},
                {"time": round(duration * 0.55, 2), "caption": "采样分析中后段"},
            ]

        events_sorted = sorted(events, key=lambda e: e["time"])[:24]

        stats = {
            "classHits": class_hits,
            "sampleCount": len(samples),
            "weightsPath": weights_used,
            "ephemeralMinHits": min_ephemeral_hits,
            "ephemeralLabels": sorted(_EPHEMERAL_FALSE_POSITIVE_LABELS),
        }

        return {
            "duration": round(float(duration), 2),
            "fps": round(fps, 3),
            "events": events_sorted,
            "detections": detections_out,
            "keyframes": kh_sorted,
            "stats": stats,
            "engine": "yolo-ultralytics-video",
        }
    finally:
        cap.release()


def build_report_payload(analysis: dict[str, Any]) -> dict[str, Any]:
    """基于当前流水线可**严格兑现**的统计生成报告（不编造语义）。"""
    dur = float(analysis.get("duration") or 0)
    fps = float(analysis.get("fps") or 0)
    stats = analysis.get("stats") or {}
    ch = stats.get("classHits") or {}
    events = analysis.get("events") or []
    sample_count = int(stats.get("sampleCount") or 0)

    ec = Counter(str(e.get("type") or "") for e in events)
    cuts = int(ec.get("cut", 0))
    new_target = int(ec.get("person", 0))
    disappear = int(ec.get("disappear", 0))

    top = sorted(ch.items(), key=lambda x: -x[1])[:8]
    top_s = "、".join(f"{_zh_label(a)}({b}次)" for a, b in top) if top else "未统计到稳定类别"

    scenarios: list[str] = []
    if ch.get("person", 0) >= 3 or new_target > 0:
        scenarios.append("人流/安防：是否有人进入画面、出现与离开的大致时段（人体检测，非考勤/身份）")
    if any(k in ch for k in ("car", "truck", "bus", "motorcycle")):
        scenarios.append("停车场/路口：车辆是否出现、经过时段（类别级，非车牌识别）")
    if cuts >= 3:
        scenarios.append("剪辑预审：镜头切换时刻列表，便于切段落或打点")
    scenarios.append(
        "会议/课程/访谈：语音转写 + 摘要/搜索/提问（需本机 ffmpeg、faster-whisper 与 DeepSeek 配置就绪）"
    )
    scenarios = scenarios[:5]

    summary = (
        f"【元数据】时长 {dur:.1f}s，约 {fps:.1f} fps，抽帧采样 {sample_count} 次。"
        f" 【画面】主要目标（按帧累计命中）：{top_s}。"
        f" 【事件】镜头变化 {cuts} 处、新目标出现 {new_target} 次、目标消失 {disappear} 次。"
        " 以上均为通用目标检测与画面差异估计，适用于监控/巡检/剪辑初筛等场景。"
    )

    bullets = [
        "适用：监控与巡逻、门店/停车场/道路的粗粒度目标与时段、剪辑镜头点；配合语音转写做会议纪要/字幕检索。",
        "不适用：角色/IP/剧情理解、人脸识别、车牌/细粒度识别、仅凭画面检索卡通角色名。",
        f"检测统计：{top_s}",
        f"时间轴事件条目：{len(events)}（后端最多保留部分）。",
    ]

    sections: list[dict[str, Any]] = [
        {
            "title": "本工具能稳定交付的",
            "items": [
                "通用类别（人、车、动物等）在画面中的出现频率与粗粒度时段",
                "镜头切换与画面剧变时刻（直方图差异，非语义「分镜」）",
                "环境就绪时：语音转文字、可搜索字幕、摘要与问答（由 DeepSeek 基于转写生成）",
            ],
        },
        {
            "title": "本工具不承诺的",
            "items": [
                "语义理解「谁是谁」、角色名、品牌或隐含剧情",
                "跨帧跟踪与 Re-ID（当前为抽帧检测，非逐帧跟踪）",
            ],
        },
    ]

    metrics: dict[str, Any] = {
        "durationSec": round(dur, 2),
        "fps": round(fps, 3),
        "sampleFrames": sample_count,
        "sceneCuts": cuts,
        "newTargets": new_target,
        "disappears": disappear,
        "eventTotal": len(events),
        "topClasses": [{"label": _zh_label(a), "key": a, "hits": b} for a, b in top[:6]],
    }

    return {
        "summary": summary,
        "bullets": bullets,
        "sections": sections,
        "metrics": metrics,
        "realWorldScenarios": scenarios,
        "reportVersion": "structured-v1",
    }


def _subs_to_simplified_zh(subs: list[dict[str, Any]], lang: str, whisper_lang: Optional[str]) -> None:
    """与 audio_transcribe 一致：Whisper 中文常出繁体，OpenCC 转简体（需 opencc-python-reimplemented）。"""
    if not subs:
        return
    if os.environ.get("WHISPER_SIMPLIFIED_ZH", "1").strip().lower() in ("0", "false", "no", "off"):
        return
    bcp = (lang or "").strip().replace("_", "-").lower()
    wl = (whisper_lang or "").strip().lower() if whisper_lang else ""
    if not (bcp.startswith("zh") or wl.startswith("zh")):
        return
    try:
        from opencc import OpenCC

        cc = OpenCC("t2s")
    except ImportError:
        return
    for row in subs:
        t = row.get("text")
        if isinstance(t, str) and t.strip():
            row["text"] = cc.convert(t)


def _clamp_subtitle_intervals(subs: list[dict[str, Any]]) -> None:
    """
    压紧句末时间、消除与下一句的重叠。
    前端曾用「无 end 时 +2.8s」导致长尾巴盖住后面真实台词；搜索也会因弱匹配排到错误句。
    """
    if not subs:
        return
    for i, row in enumerate(subs):
        st = float(row.get("time") or 0)
        raw_en = row.get("end")
        if raw_en is None:
            en = st + 1.2
        else:
            en = float(raw_en)
        if en <= st:
            en = st + 0.35
        row["time"] = round(st, 2)
        row["end"] = round(en, 2)
    for i in range(len(subs) - 1):
        st_next = float(subs[i + 1]["time"])
        en = float(subs[i]["end"])
        st_cur = float(subs[i]["time"])
        if en > st_next - 0.05:
            subs[i]["end"] = round(max(st_cur + 0.12, st_next - 0.05), 2)


def task_asr(video_path: Path, lang: str) -> dict[str, Any]:
    fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    wav = Path(wav_path)
    try:
        import subprocess

        r = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(video_path),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(wav),
            ],
            capture_output=True,
            timeout=600,
        )
        if r.returncode != 0:
            err = (r.stderr or b"").decode("utf-8", errors="replace")[:400]
            return {
                "engine": "video-asr",
                "subtitles": [
                    {
                        "time": 0.0,
                        "text": f"未能从视频提取音轨（请安装 ffmpeg 并确认视频含音频）。{err}",
                    }
                ],
            }
    except FileNotFoundError:
        return {
            "engine": "video-asr",
            "subtitles": [
                {
                    "time": 0.0,
                    "text": "未找到 ffmpeg，无法提取音轨。请安装 ffmpeg 并加入 PATH。",
                }
            ],
        }
    except Exception as e:
        return {
            "engine": "video-asr",
            "subtitles": [{"time": 0.0, "text": f"提取音频失败：{e}"}],
        }

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        wav.unlink(missing_ok=True)
        return {
            "engine": "video-asr",
            "subtitles": [
                {
                    "time": 0.0,
                    "text": "未安装 faster-whisper，请 pip install faster-whisper（与音频转写相同环境）。",
                }
            ],
        }

    model_size = (os.environ.get("WHISPER_MODEL") or "tiny").strip() or "tiny"
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    ctype = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    model = WhisperModel(model_size, device=device, compute_type=ctype)

    # BCP-47 -> whisper
    lang_code = None
    l = (lang or "").strip().lower().replace("_", "-")
    initial_prompt = None
    if l.startswith("zh"):
        lang_code = "zh"
        initial_prompt = "以下是普通话口语内容，请用简体中文书写，避免繁体字。"
    elif l.startswith("ja"):
        lang_code = "ja"
    elif l.startswith("en"):
        lang_code = "en"

    try:
        beam_sz = max(1, min(5, int((os.environ.get("WHISPER_BEAM_SIZE") or "1").strip() or "1")))
    except ValueError:
        beam_sz = 1
    transcribe_kw: dict[str, Any] = {
        "language": lang_code,
        "beam_size": beam_sz,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 350},
        # 减轻「前文污染」导致的幻听与时间漂移（句尾常被粘到前一段）
        "condition_on_previous_text": False,
    }
    if initial_prompt:
        transcribe_kw["initial_prompt"] = initial_prompt

    segments_iter, fw_info = model.transcribe(str(wav), **transcribe_kw)
    whisper_detected = getattr(fw_info, "language", None) if fw_info is not None else None
    subs: list[dict[str, Any]] = []
    for seg in segments_iter:
        tx = (seg.text or "").strip()
        if not tx:
            continue
        st = round(float(seg.start), 2)
        en = round(float(seg.end), 2)
        subs.append({"time": st, "end": en, "text": tx})
    _subs_to_simplified_zh(subs, lang, whisper_detected)
    _clamp_subtitle_intervals(subs)
    rich_segments = [{"start": s["time"], "end": s["end"], "text": s["text"]} for s in subs]
    wav.unlink(missing_ok=True)
    if not subs:
        subs = [{"time": 0.0, "end": 0.0, "text": "（未识别到语音内容或音轨为空）"}]
        rich_segments = [{"start": 0.0, "end": 0.0, "text": subs[0]["text"]}]
    return {
        "engine": "faster-whisper-video",
        "subtitles": subs,
        "segments": rich_segments,
        "whisperModel": model_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--task",
        required=True,
        choices=["detect", "keyframes", "report", "asr", "bundle"],
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default=os.environ.get("YOLO_MODEL", "yolov8n.pt"))
    parser.add_argument("--conf", type=float, default=0.18)
    parser.add_argument("--yolo-imgsz", type=int, default=640)
    parser.add_argument("--lang", default="zh-CN", help="ASR 语言（BCP-47）")
    args = parser.parse_args()

    vp = Path(args.input)
    if not vp.exists():
        raise FileNotFoundError(str(vp))

    conf = max(0.01, min(0.99, float(args.conf)))
    imgsz = max(320, min(1280, int(args.yolo_imgsz)))

    task = args.task
    if task == "asr":
        out = task_asr(vp, args.lang)
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
        return

    if task == "bundle":
        # 单次跑 YOLO 抽帧 + ASR，避免 Java/浏览器对同一视频连发三次大 multipart 导致连接被重置
        an = analyze_video_yolo(vp, args.model, conf, imgsz)
        out_detect = {
            "engine": an["engine"],
            "duration": an["duration"],
            "events": an["events"],
            "detections": an["detections"],
            "fps": an.get("fps"),
            "stats": an.get("stats"),
        }
        frames = [{"time": x["time"], "caption": x["caption"]} for x in an.get("keyframes") or []]
        out_keyframes = {"engine": an["engine"], "frames": frames}
        try:
            out_asr = task_asr(vp, args.lang)
        except Exception as exc:
            out_asr = {
                "engine": "video-asr-error",
                "subtitles": [
                    {
                        "time": 0.0,
                        "end": 0.0,
                        "text": f"语音分析失败（已保留画面结果）：{type(exc).__name__}: {exc}",
                    }
                ],
                "segments": [],
            }
        out = {"detect": out_detect, "keyframes": out_keyframes, "asr": out_asr}
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
        return

    an = analyze_video_yolo(vp, args.model, conf, imgsz)

    if task == "detect":
        out = {
            "engine": an["engine"],
            "duration": an["duration"],
            "events": an["events"],
            "detections": an["detections"],
            "fps": an.get("fps"),
            "stats": an.get("stats"),
        }
    elif task == "keyframes":
        frames = [{"time": x["time"], "caption": x["caption"]} for x in an.get("keyframes") or []]
        out = {"engine": an["engine"], "frames": frames}
    elif task == "report":
        rep = build_report_payload(an)
        out = {
            "engine": an["engine"],
            "summary": rep["summary"],
            "bullets": rep["bullets"],
            "sections": rep.get("sections"),
            "metrics": rep.get("metrics"),
            "realWorldScenarios": rep.get("realWorldScenarios"),
            "reportVersion": rep.get("reportVersion"),
        }
    else:
        raise ValueError(task)

    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        err = {"error": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(json.dumps(err, ensure_ascii=False))
        sys.exit(2)
