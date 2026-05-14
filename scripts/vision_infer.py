#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
真实图片模型桥接脚本：
- task=yolo -> ultralytics YOLO 检测
- task=ocr  -> 默认 RapidOCR+ONNX（无 PyTorch）；可选 PaddleOCR（见 --ocr-backend）
输出 JSON 到 stdout，错误输出到 stderr 并返回非0状态码
"""
import sys as _sys

# Redirect stdout → stderr immediately so that ultralytics / other libraries
# that print info/progress to stdout do not contaminate the JSON response.
# _json_out is restored only for the final json.dumps write at the end of main().
_json_out = _sys.stdout
_sys.stdout = _sys.stderr

import argparse
import json
import os
from pathlib import Path

# PaddleOCR 3.x：Windows 需关闭 MKLDNN/PIR（见下方 FLAGS_*）
# HF_ENDPOINT 由 Java 层按 application.yml 注入；不在此处强制设置，避免覆盖海外部署配置
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

# Windows / CPU：仅设环境变量往往不够，PaddleX 仍可能选 run_mode=mkldnn。
# 必须在 import paddle 之前强制覆盖（勿用 setdefault，避免继承到错误值）。
# 另须在 PaddleOCR(..., enable_mkldnn=False) 中关闭（见 run_ocr）。
def _force_paddle_cpu_safe():
    os.environ["FLAGS_use_mkldnn"] = "0"
    os.environ["FLAGS_enable_pir_api"] = "0"
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "-1")


_force_paddle_cpu_safe()

from yolo_weights import resolve_yolo_weights

# COCO 80 类英文名（与 Ultralytics 训练标签一致）；标准 YOLO 权重仅含这些，无 flag 等
_COCO80: list[str] = [
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush",
]

# YOLO-World 开放词：在 COCO 之外补充旗帜、导弹等（仍可能漏检，取决于画面与模型）
_DEFAULT_WORLD_EXTRAS: list[str] = [
    "flag",
    "national flag",
    "banner",
    "missile",
    "rocket",
    "military vehicle",
    "tank",
]


def _is_yolo_world_weights(model_name: str) -> bool:
    return "world" in Path(model_name).name.lower()


def _dedupe_str(seq: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in seq:
        t = (x or "").strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _build_world_class_prompts(extra_csv: str) -> list[str]:
    parts = list(_COCO80) + list(_DEFAULT_WORLD_EXTRAS)
    if extra_csv and extra_csv.strip():
        for p in extra_csv.split(","):
            t = p.strip()
            if t:
                parts.append(t)
    return _dedupe_str(parts)


def run_yolo(
    image_path: Path,
    model_name: str,
    conf: float = 0.25,
    imgsz: int = 640,
    yolo_world_extra_classes: str = "",
):
    try:
        from ultralytics import YOLO
        from ultralytics import YOLOWorld
    except Exception as e:
        raise RuntimeError("missing dependency ultralytics") from e

    weights_path = resolve_yolo_weights(model_name)
    world = _is_yolo_world_weights(model_name)
    clip_fallback = False
    clip_fallback_hint = ""

    # YOLO-World 的 set_classes 依赖 OpenAI CLIP（import clip）；未安装时回退 COCO 模型，避免整条接口失败
    if world:
        try:
            import clip  # noqa: F401
        except ImportError:
            world = False
            clip_fallback = True
            clip_fallback_hint = (
                "未检测到 Python 包 clip（YOLO-World 文本头所需）。"
                "已自动改用 yolov8n.pt（仅 COCO 80 类，无 flag 等开放词）。"
                "请执行: pip install \"clip @ https://github.com/ultralytics/CLIP/archive/refs/heads/main.zip\""
            )
            model_name = "yolov8n.pt"
            weights_path = resolve_yolo_weights(model_name)
            model = YOLO(weights_path)
        else:
            # YOLO-World 权重必须用 YOLOWorld 类加载
            model = YOLOWorld(weights_path)
            prompts = _build_world_class_prompts(yolo_world_extra_classes)
            try:
                model.set_classes(prompts)
            except Exception as e:
                raise RuntimeError(
                    "YOLO-World set_classes 失败: "
                    + str(e)
                    + "（请确认 ultralytics>=8.2、已安装 clip，且权重为 yolov8*s-world*.pt）"
                ) from e
    else:
        model = YOLO(weights_path)

    iz = int(imgsz)
    if iz < 320:
        iz = 320
    if iz > 1280:
        iz = 1280

    results = model.predict(
        source=str(image_path),
        verbose=False,
        conf=conf,
        iou=0.45,
        imgsz=iz,
        max_det=50,
    )
    if not results:
        out_empty: dict = {
            "model": model_name,
            "weightsPath": weights_path,
            "backend": "ultralytics",
            "yoloMode": "yolo-world" if world else "coco",
            "imgsz": iz,
            "detections": [],
        }
        if clip_fallback:
            out_empty["clipFallback"] = True
            out_empty["warning"] = clip_fallback_hint
        return out_empty

    r = results[0]
    names = getattr(r, "names", {}) or {}
    dets = []
    if r.boxes is not None and len(r.boxes) > 0:
        xyxy = r.boxes.xyxy.cpu().numpy()
        cls = r.boxes.cls.cpu().numpy()
        conf = r.boxes.conf.cpu().numpy()
        h = float(r.orig_shape[0]) if r.orig_shape else 1.0
        w = float(r.orig_shape[1]) if r.orig_shape else 1.0

        for i in range(len(xyxy)):
            x1, y1, x2, y2 = [float(v) for v in xyxy[i]]
            label = names.get(int(cls[i]), str(int(cls[i])))
            c = float(conf[i])
            # 前端当前按 0-100 的相对 bbox 百分比渲染
            bx = max(0.0, min(100.0, x1 / w * 100.0))
            by = max(0.0, min(100.0, y1 / h * 100.0))
            bw = max(0.1, min(100.0, (x2 - x1) / w * 100.0))
            bh = max(0.1, min(100.0, (y2 - y1) / h * 100.0))
            dets.append(
                {
                    "label": str(label),
                    "confidence": round(c, 4),
                    "box": [round(bx, 2), round(by, 2), round(bw, 2), round(bh, 2)],
                }
            )

    out: dict = {
        "model": model_name,
        "weightsPath": weights_path,
        "backend": "ultralytics",
        "yoloMode": "yolo-world" if world else "coco",
        "imgsz": iz,
        "width": int(r.orig_shape[1]) if r.orig_shape else 0,
        "height": int(r.orig_shape[0]) if r.orig_shape else 0,
        "detections": dets,
    }
    if clip_fallback:
        out["clipFallback"] = True
        out["warning"] = clip_fallback_hint
    return out


def _dedupe_preserve(lines: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for t in lines:
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _extract_text_lines_from_ocr_result(result) -> list[str]:
    """兼容 PaddleOCR 2.x、3.x / PaddleX OCRResult（list[dict] 与 dict-like）。"""
    if result is None:
        return []

    if isinstance(result, (list, tuple)):
        acc: list[str] = []
        for it in result:
            acc.extend(_extract_text_lines_from_ocr_result(it))
        return _dedupe_preserve(acc)

    if isinstance(result, dict):
        texts: list[str] = []
        for k in ("rec_texts", "texts"):
            v = result.get(k)
            if isinstance(v, (list, tuple)):
                for t in v:
                    if t is not None and str(t).strip():
                        texts.append(str(t).strip())
        tv = result.get("text")
        if isinstance(tv, str) and tv.strip():
            texts.append(tv.strip())
        if texts:
            return _dedupe_preserve(texts)
        for k in ("res", "result", "data", "ocr_res"):
            if k in result:
                return _extract_text_lines_from_ocr_result(result[k])
        return []

    # PaddleX OCRResult 等 dict 子类
    if hasattr(result, "get"):
        try:
            d = dict(result) if hasattr(result, "keys") else None
        except Exception:
            d = None
        if d:
            return _extract_text_lines_from_ocr_result(d)

    if hasattr(result, "json") and callable(result.json):
        try:
            return _extract_text_lines_from_ocr_result(result.json())
        except Exception:
            pass

    if isinstance(result, str) and result.strip():
        return [result.strip()]
    return []


def run_ocr_rapid(image_path: Path, lang: str) -> dict:
    """RapidOCR + ONNX Runtime：不依赖 PyTorch/Paddle，适合 Windows 避免 shm.dll 等问题。"""
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:
        raise RuntimeError(
            "缺少 rapidocr-onnxruntime，请在 venv 中执行: pip install rapidocr-onnxruntime onnxruntime"
        ) from e

    use_lang = "ch" if not lang or lang.lower().startswith("zh") else "en"
    engine = RapidOCR()
    # rapidocr_onnxruntime：返回 (ocr_result, elapse_list)；每项为 [box, text, score, ...]
    result, _elapse_list = engine(str(image_path))
    lines: list[str] = []
    if result:
        for item in result:
            if not item or len(item) < 2:
                continue
            txt_field = item[1]
            if isinstance(txt_field, str) and txt_field.strip():
                lines.append(txt_field.strip())
            elif isinstance(txt_field, (list, tuple)) and len(txt_field) >= 1:
                t = txt_field[0]
                if t is not None and str(t).strip():
                    lines.append(str(t).strip())
    lines = _dedupe_preserve(lines)
    text = "\n".join(lines)
    return {
        "engine": "rapidocr-onnxruntime",
        "lang": use_lang,
        "backend": "rapidocr-onnxruntime",
        "text": text,
        "lines": lines,
    }


def run_ocr_paddle(image_path: Path, lang: str) -> dict:
    _force_paddle_cpu_safe()
    try:
        import paddle

        paddle.set_device("cpu")
        if hasattr(paddle, "set_flags"):
            try:
                paddle.set_flags(
                    {
                        "FLAGS_use_mkldnn": False,
                        "FLAGS_enable_pir_api": False,
                    }
                )
            except Exception:
                pass
    except Exception:
        pass

    try:
        from paddleocr import PaddleOCR
    except Exception as e:
        raise RuntimeError("missing dependency paddleocr: " + str(e)) from e

    use_lang = "ch" if not lang or lang.lower().startswith("zh") else "en"

    def _build_ocr():
        try:
            return PaddleOCR(
                lang=use_lang,
                ocr_version="PP-OCRv4",
                enable_mkldnn=False,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
        except (TypeError, ValueError):
            return PaddleOCR(
                lang=use_lang,
                enable_mkldnn=False,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )

    ocr = _build_ocr()
    result = ocr.predict(str(image_path))
    lines = _extract_text_lines_from_ocr_result(result)
    text = "\n".join(lines)
    return {
        "engine": "paddleocr",
        "lang": use_lang,
        "backend": "paddleocr",
        "text": text,
        "lines": lines,
    }


def run_ocr(image_path: Path, lang: str, ocr_backend: str) -> dict:
    """
    ocr_backend:
      - rapid   : 仅 RapidOCR
      - paddle  : 仅 PaddleOCR
      - auto    : 先 RapidOCR，失败再 PaddleOCR（推荐 Windows）
    """
    b = (ocr_backend or "auto").strip().lower()

    if b == "rapid":
        return run_ocr_rapid(image_path, lang)
    if b == "paddle":
        return run_ocr_paddle(image_path, lang)

    # auto
    errs: list[str] = []
    try:
        return run_ocr_rapid(image_path, lang)
    except Exception as e1:
        errs.append(f"rapidocr: {e1}")
    try:
        return run_ocr_paddle(image_path, lang)
    except Exception as e2:
        errs.append(f"paddleocr: {e2}")
    raise RuntimeError(
        "OCR 两种引擎均失败（建议: pip install rapidocr-onnxruntime onnxruntime）。详情: "
        + " | ".join(errs)
    ) from None


def classify_ocr_script(text: str) -> str:
    """
    返回 ocrScript，供 Java 决定是否调用翻译：
    - empty: 无文本
    - cjk: 以中日韩统一表意文字为主 → 繁简转换在 Python 内完成
    - translate: 以外语等为主 → Java 调 DeepSeek 译为中文
    """
    if not text or not str(text).strip():
        return "empty"
    s = str(text).strip()
    cjk_unified = sum(1 for c in s if "\u4e00" <= c <= "\u9fff")
    # 日文假名：不走繁简，交给翻译
    if any("\u3040" <= c <= "\u30ff" or "\u31f0" <= c <= "\u31ff" for c in s):
        return "translate"
    # 韩文音节：翻译
    if any("\uac00" <= c <= "\ud7a3" for c in s):
        return "translate"
    if cjk_unified == 0:
        return "translate"
    n = max(len(s), 1)
    cjk_ratio = cjk_unified / n
    # 仅标题级少量汉字、正文以外文为主：走全文翻译（Java textZh），避免只走「片段释义」导致长文无译文
    if cjk_ratio < 0.06:
        return "translate"
    if cjk_unified >= 2 or cjk_ratio >= 0.08:
        return "cjk"
    return "translate"


def apply_ocr_enrichment(out: dict) -> dict:
    """为 OCR 结果附加脚本类型；中文路径下附加简体与是否含繁体差异。"""
    text = out.get("text")
    if text is None:
        text = ""
    kind = classify_ocr_script(text)
    out["ocrScript"] = kind
    if kind != "cjk":
        return out
    try:
        import zhconv

        simplified = zhconv.convert(str(text), "zh-cn")
        out["textSimplified"] = simplified
        out["hasTraditionalVariant"] = str(text) != simplified
    except Exception:
        pass
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", required=True, choices=["yolo", "ocr"])
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="yolov8n.pt")
    parser.add_argument(
        "--conf",
        type=float,
        default=0.25,
        help="YOLO confidence threshold (0~1)",
    )
    parser.add_argument(
        "--yolo-imgsz",
        type=int,
        default=640,
        help="YOLO 推理边长（320~1280），World 模型检测小目标时可提高到 960",
    )
    parser.add_argument(
        "--yolo-world-extra-classes",
        default="",
        help="仅 YOLO-World：在 COCO+默认扩展之外追加英文类别，逗号分隔，如 tank,warship",
    )
    parser.add_argument("--lang", default="ch")
    parser.add_argument(
        "--ocr-backend",
        default="auto",
        choices=["auto", "rapid", "paddle"],
        help="OCR 引擎：rapid=ONNX（默认推荐 Windows）；paddle=PaddleOCR；auto=先 rapid 后 paddle",
    )
    args = parser.parse_args()

    image_path = Path(args.input)
    if not image_path.exists():
        raise FileNotFoundError(f"input not found: {image_path}")

    if args.task == "yolo":
        out = run_yolo(
            image_path,
            args.model,
            conf=float(args.conf),
            imgsz=int(args.yolo_imgsz),
            yolo_world_extra_classes=str(args.yolo_world_extra_classes or ""),
        )
    else:
        out = run_ocr(image_path, args.lang, args.ocr_backend)
        out = apply_ocr_enrichment(out)

    _json_out.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        err = {"error": f"{type(exc).__name__}: {exc}"}
        sys.stderr.write(json.dumps(err, ensure_ascii=False))
        sys.exit(2)
