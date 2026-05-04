#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
测试：解析/下载 YOLO 权重并做一次最小推理（需已安装 ultralytics）。
用法（在项目根目录）:
  .venv\\Scripts\\python.exe scripts\\test_yolo_weights.py
"""
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))

from yolo_weights import resolve_yolo_weights  # noqa: E402


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "yolov8n.pt"
    path = resolve_yolo_weights(name)
    print("weights:", path)

    from ultralytics import YOLO

    model = YOLO(path)
    # 最小自检：不跑真实图片，只确认权重可读
    print("model loaded OK:", type(model))


if __name__ == "__main__":
    main()
