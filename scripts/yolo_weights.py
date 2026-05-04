#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YOLO 权重解析与（国内镜像）自动下载，避免 Ultralytics 直连 GitHub 超时。
可通过环境变量覆盖：
  ULTRALYTICS_ASSETS_TAG   默认 v8.4.0（与 ultralytics 8.4.x 资源一致）
  YOLO_DOWNLOAD_TIMEOUT_S  单次 HTTP 超时秒数，默认 300
"""
from __future__ import annotations

import os
from typing import Optional
import ssl
import urllib.error
import urllib.request
from pathlib import Path


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _default_models_dir() -> Path:
    return _project_root() / "models"


def _github_release_urls(filename: str, tag: str) -> list[str]:
    path = f"ultralytics/assets/releases/download/{tag}/{filename}"
    base = f"https://github.com/{path}"
    mirrors = [
        base,
        f"https://ghproxy.com/https://github.com/{path}",
        f"https://mirror.ghproxy.com/https://github.com/{path}",
        f"https://ghfast.top/https://github.com/{path}",
        f"https://kkgithub.com/{path}",
    ]
    # 去重保序
    seen = set()
    out = []
    for u in mirrors:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _download(url: str, dest: Path, timeout_s: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; deepseek-multimodal/1.0)"})
    with urllib.request.urlopen(req, timeout=timeout_s, context=ctx) as r:
        with open(tmp, "wb") as f:
            while True:
                chunk = r.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
    tmp.replace(dest)


def resolve_yolo_weights(model_arg: str) -> str:
    """
    返回可直接传给 ultralytics.YOLO() 的本地 .pt 绝对路径。
    - 若已是存在的绝对路径，原样返回。
    - 若项目 models/ 下已有同名文件，返回该路径。
    - 否则按镜像列表下载到 models/<文件名>。
    """
    raw = (model_arg or "").strip()
    if not raw:
        raise ValueError("empty model path")

    p = Path(raw)
    if p.is_absolute():
        if p.exists():
            return str(p.resolve())
        raise FileNotFoundError(f"YOLO 权重不存在: {p}")

    filename = p.name
    models_dir = _default_models_dir()
    local = (models_dir / filename).resolve()
    if local.exists():
        return str(local)

    tag = os.environ.get("ULTRALYTICS_ASSETS_TAG", "v8.4.0").strip() or "v8.4.0"
    timeout_s = int(os.environ.get("YOLO_DOWNLOAD_TIMEOUT_S", "300"))

    last_err: Optional[Exception] = None
    for url in _github_release_urls(filename, tag):
        try:
            _download(url, local, timeout_s=timeout_s)
            if local.exists() and local.stat().st_size > 1000:
                return str(local)
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last_err = e
            continue

    raise RuntimeError(
        f"无法下载 YOLO 权重 {filename}（已尝试镜像）。最后错误: {last_err!r}。"
        "可手动将文件放到: " + str(local)
    )
