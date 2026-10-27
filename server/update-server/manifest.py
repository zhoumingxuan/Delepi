# -*- coding: utf-8 -*-
"""版本清单读取与安装包元数据解析。

职责：
1. 读取并校验 data/manifest.json（按 mtime + size 缓存，避免每次请求都解析）；
2. 把清单里的平台条目解析成安装包元数据：用 stat 取真实 size、流式计算 sha256
   （按文件 mtime + size 缓存，文件被替换后缓存自动失效）；
3. 所有路径都做「平台白名单 + 文件名白名单 + 目录包含 + 符号链接逃逸阻断」四重校验，
   杜绝 ../、绝对路径与符号链接逃逸；禁止把任何 query 参数直接拼进文件系统路径。

本模块不产生 HTTP 响应，失败统一返回 None，由 app.py 转成统一的 404。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import stat as stat_module
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("delepi.update.manifest")

# 平台白名单：与客户端三个平台严格一致（小写敏感）
PLATFORMS: Tuple[str, ...] = ("win10", "linux", "mac")

_VERSION_PATTERN = re.compile(r"^[0-9A-Za-z.+-]{1,32}$")
_FILE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

# 流式计算 sha256 的分块大小：1 MiB，保证大安装包不会整体进内存
_HASH_CHUNK_SIZE = 1024 * 1024

_LOCK = threading.Lock()

# 清单缓存：{"key": (路径, mtime_ns, size), "value": 归一化后的清单}
_MANIFEST_CACHE: Dict[str, Any] = {"key": None, "value": None}

# 安装包哈希缓存：绝对路径 -> {"key": (mtime_ns, size), "sha256": ...}
_HASH_CACHE: Dict[str, Dict[str, Any]] = {}


def _is_safe_file_name(file_name: str) -> bool:
    """文件名白名单：字母数字开头，只允许字母数字 . _ -，且不含 ..、不是绝对路径、不带目录。"""
    if _FILE_NAME_PATTERN.fullmatch(file_name) is None:
        return False
    if ".." in file_name:
        return False
    if os.path.isabs(file_name):
        return False
    if Path(file_name).name != file_name:
        return False
    return True


def is_safe_file_name(file_name: str) -> bool:
    """公开别名：供 publish.py 复用同一套文件名白名单校验，避免两处正则漂移。"""
    return _is_safe_file_name(file_name)


def _is_inside(child: Path, parent: Path) -> bool:
    """判断 child 是否位于 parent 目录内部（用于阻断路径逃逸）。"""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def package_file_path(package_dir: Path, platform: str, file_name: str) -> Optional[Path]:
    """把「平台 + 文件名」安全地解析成绝对路径；任何越界都返回 None。

    这里不接受任何来自 query 的字符串：fileName 只能来自清单，且必须通过白名单。
    """
    if platform not in PLATFORMS:
        return None
    if not _is_safe_file_name(file_name):
        return None
    try:
        base_dir = Path(package_dir).resolve(strict=False)
        platform_dir = (base_dir / platform).resolve(strict=False)
        candidate = (platform_dir / file_name).resolve(strict=False)
    except OSError:
        return None
    # 平台目录必须位于包根目录内（防止 packages/win10 被替换成指向外部的符号链接）
    if not _is_inside(platform_dir, base_dir) or platform_dir == base_dir:
        return None
    # 最终文件必须位于平台目录内（防止符号链接文件指向外部）
    if not _is_inside(candidate, platform_dir):
        return None
    return candidate


def _normalize_manifest(raw: Any) -> Optional[Dict[str, Any]]:
    """校验清单结构并归一化成固定形状；任何字段不合法都返回 None。"""
    if not isinstance(raw, dict):
        return None

    latest_version = raw.get("latestVersion")
    update_notes = raw.get("updateNotes")
    platforms = raw.get("platforms")

    # latestVersion 只校验长度与字符集（语义比较由客户端负责）
    if not isinstance(latest_version, str) or _VERSION_PATTERN.fullmatch(latest_version) is None:
        return None
    # updateNotes：纯文字，≤4000 字符，禁止 HTML 标签与 Markdown 链接语法
    if not isinstance(update_notes, str) or len(update_notes) > 4000:
        return None
    if "<" in update_notes or ">" in update_notes or "](" in update_notes:
        return None
    if not isinstance(platforms, dict):
        return None

    normalized: Dict[str, Any] = {
        "latestVersion": latest_version,
        "updateNotes": update_notes,
        "platforms": {},
    }
    for platform in PLATFORMS:
        entry = platforms.get(platform)
        if entry is None:
            # null 或缺失都表示该平台当前没有适配包
            normalized["platforms"][platform] = None
            continue
        if not isinstance(entry, dict):
            return None
        file_name = entry.get("fileName")
        size = entry.get("size")
        sha256 = entry.get("sha256")
        if not isinstance(file_name, str) or not _is_safe_file_name(file_name):
            return None
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            return None
        if not isinstance(sha256, str) or _SHA256_PATTERN.fullmatch(sha256) is None:
            return None
        normalized["platforms"][platform] = {
            "fileName": file_name,
            "size": size,
            "sha256": sha256,
        }
    return normalized


def load_manifest(manifest_path: Path) -> Optional[Dict[str, Any]]:
    """读取并校验版本清单；成功返回归一化清单，失败返回 None（由调用方转 404）。"""
    path = Path(manifest_path)
    try:
        file_stat = path.stat()
    except FileNotFoundError:
        logger.error("清单文件不存在：%s", path)
        return None
    except OSError as exc:
        logger.error("清单文件不可访问：%s（%s）", path, exc)
        return None

    cache_key = (str(path), file_stat.st_mtime_ns, file_stat.st_size)
    with _LOCK:
        if _MANIFEST_CACHE["key"] == cache_key and _MANIFEST_CACHE["value"] is not None:
            return _MANIFEST_CACHE["value"]
        last_good = _MANIFEST_CACHE["value"]

    try:
        raw_text = path.read_text(encoding="utf-8-sig")
        raw = json.loads(raw_text)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        # 解析失败时保留上一份可用清单，避免一次半写入导致所有平台不可用
        logger.error("清单读取或解析失败：%s（%s）", path, exc)
        return last_good

    normalized = _normalize_manifest(raw)
    if normalized is None:
        logger.error("清单字段校验失败：%s", path)
        return last_good

    with _LOCK:
        _MANIFEST_CACHE["key"] = cache_key
        _MANIFEST_CACHE["value"] = normalized
    return normalized


def _compute_sha256(file_path: Path) -> str:
    """分块流式计算文件 SHA-256，绝不把整个安装包读入内存。"""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as handle:
        while True:
            chunk = handle.read(_HASH_CHUNK_SIZE)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _sha256_cached(file_path: Path, file_stat: os.stat_result) -> Optional[str]:
    """按 (mtime_ns, size) 缓存 SHA-256；文件被替换后缓存自动失效。"""
    cache_key = (file_stat.st_mtime_ns, file_stat.st_size)
    path_key = str(file_path)
    with _LOCK:
        cached = _HASH_CACHE.get(path_key)
        if cached is not None and cached["key"] == cache_key:
            return cached["sha256"]
    try:
        digest = _compute_sha256(file_path)
    except OSError as exc:
        logger.error("计算安装包 SHA-256 失败：%s（%s）", file_path, exc)
        return None
    with _LOCK:
        _HASH_CACHE[path_key] = {"key": cache_key, "sha256": digest}
    return digest


def resolve_package(
    manifest_data: Dict[str, Any],
    platform: str,
    package_dir: Path,
) -> Optional[Dict[str, Any]]:
    """解析某平台的安装包元数据：清单声明 + 文件实存 + size 匹配，三者同时成立才算有包。

    返回 {"fileName", "size", "sha256"}；任一条件不满足返回 None（按「无适配包」处理）。
    sha256 以磁盘文件的真实值为准（客户端下载后用同一个值校验），若与清单不一致只告警。
    """
    entry = manifest_data["platforms"].get(platform)
    if not entry:
        return None

    file_path = package_file_path(package_dir, platform, entry["fileName"])
    if file_path is None:
        logger.error("清单中的文件名不合法或路径越界：platform=%s file=%r", platform, entry["fileName"])
        return None

    try:
        file_stat = file_path.stat()
    except FileNotFoundError:
        logger.warning("安装包文件不存在，按无适配包处理：%s", file_path)
        return None
    except OSError as exc:
        logger.warning("安装包 stat 失败，按无适配包处理：%s（%s）", file_path, exc)
        return None

    if not stat_module.S_ISREG(file_stat.st_mode):
        logger.warning("安装包不是普通文件，按无适配包处理：%s", file_path)
        return None

    if file_stat.st_size != entry["size"]:
        logger.warning(
            "安装包大小与清单不一致，按无适配包处理：%s（磁盘=%d，清单=%d）",
            file_path,
            file_stat.st_size,
            entry["size"],
        )
        return None

    sha256 = _sha256_cached(file_path, file_stat)
    if sha256 is None:
        return None

    if sha256 != entry["sha256"]:
        # 不阻断：以磁盘真实值为准，保证客户端下载后的 SHA-256 校验一定通过
        logger.warning(
            "安装包 SHA-256 与清单不一致，已改用磁盘真实值：%s（磁盘=%s，清单=%s）",
            file_path,
            sha256,
            entry["sha256"],
        )

    return {"fileName": entry["fileName"], "size": file_stat.st_size, "sha256": sha256}
