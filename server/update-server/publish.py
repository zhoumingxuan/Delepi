# -*- coding: utf-8 -*-
"""安装包发布工具：算出真实 size / sha256 并原子更新 data/manifest.json。

设计目标：
1. 发布新版本时**不需要改代码、不需要手算哈希**：一条命令完成「取真实字节数 +
   流式计算 SHA-256 + 原子替换清单」；
2. 只使用 Python 标准库（argparse / hashlib / json / os / pathlib / tempfile），
   不引入任何第三方依赖，也不修改 requirements.txt；
3. 写入清单走「同目录临时文件 + os.replace」的原子替换，进程被中断也不会留下半个 JSON；
4. 只改「目标平台条目 + latestVersion（可选）」，清单里的 updateNotes 等其它字段、
   以及其它平台条目原样保留；
5. --dry-run 只读取与计算，绝不写任何文件（清单字节与 mtime 都不变）。

用法示例：
    python publish.py --dry-run /srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe --platform win10 --version 0.8.1
    python publish.py /srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe --platform win10 --version 0.8.1
    python publish.py /data/pkg/Delepi-0.8.1-linux-x86_64.AppImage --platform linux --manifest ./data/manifest.json

退出码：0 成功；1 校验或写入失败；2 参数错误（argparse 默认）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

BASE_DIR = Path(__file__).resolve().parent

# 某些环境会设置 PYTHONSAFEPATH / 以 -P 启动，脚本目录不在 sys.path 里；这里显式补上，
# 保证在任意工作目录下执行 `python publish.py` 都能 import 同目录的 manifest.py。
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

import manifest  # noqa: E402  （同目录模块，必须在 sys.path 补齐之后导入）

DEFAULT_MANIFEST_PATH = BASE_DIR / "data" / "manifest.json"

# 分块读取大小：1 MiB，保证几百 MB 的安装包也不会整体进内存
HASH_CHUNK_SIZE = 1024 * 1024

# 版本号字符集必须与服务端 manifest.py 的 _VERSION_PATTERN 完全一致
_VERSION_PATTERN = re.compile(r"^[0-9A-Za-z.+-]{1,32}$")


class PublishError(RuntimeError):
    """发布过程中的可预期错误（参数之外的校验/写入失败）。"""


def _configure_stdout() -> None:
    """Windows 控制台默认不是 UTF-8：尽力切到 UTF-8，失败也不影响发布逻辑。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError, ValueError):
        pass


def compute_size_and_sha256(file_path: Path) -> tuple[int, str]:
    """流式计算文件字节数与 SHA-256（64 位小写十六进制）。"""
    hasher = hashlib.sha256()
    total = 0
    with open(file_path, "rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK_SIZE)
            if not chunk:
                break
            hasher.update(chunk)
            total += len(chunk)
    return total, hasher.hexdigest()


def read_manifest(manifest_path: Path) -> Dict[str, Any]:
    """读取清单原始 JSON（保留全部字段，不做归一化，避免丢掉未知字段）。"""
    try:
        raw_text = manifest_path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise PublishError(f"清单文件不存在：{manifest_path}") from exc
    except OSError as exc:
        raise PublishError(f"清单文件不可读：{manifest_path}（{exc}）") from exc
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise PublishError(f"清单不是合法 JSON：{manifest_path}（{exc}）") from exc
    if not isinstance(data, dict):
        raise PublishError(f"清单顶层必须是 JSON 对象：{manifest_path}")
    return data


def atomic_write_json(manifest_path: Path, data: Dict[str, Any]) -> None:
    """同目录写临时文件 + os.replace 原子替换；失败时清理临时文件。"""
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{manifest_path.name}.",
        suffix=".tmp",
        dir=str(manifest_path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, manifest_path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def build_updated_manifest(
    data: Dict[str, Any],
    platform: str,
    file_name: str,
    size: int,
    sha256: str,
    version: Optional[str],
) -> Dict[str, Any]:
    """构造新的清单对象：只改动目标平台条目与 latestVersion，其它内容保持原样。"""
    latest_version = data.get("latestVersion")
    if not isinstance(latest_version, str) or _VERSION_PATTERN.fullmatch(latest_version) is None:
        raise PublishError(
            "现有清单的 latestVersion 缺失或格式非法（要求 1–32 位、字符集 [0-9A-Za-z.+-]）；"
            "请先用 --version 指定一个合法版本号"
        )
    if version is not None and _VERSION_PATTERN.fullmatch(version) is None:
        raise PublishError(f"--version 格式非法：{version!r}（要求 1–32 位、字符集 [0-9A-Za-z.+-]）")

    platforms = data.get("platforms")
    if platforms is None:
        platforms = {}
    if not isinstance(platforms, dict):
        raise PublishError("现有清单的 platforms 字段不是 JSON 对象，拒绝改写")

    existing_entry = platforms.get(platform)
    if existing_entry is None:
        new_entry: Dict[str, Any] = {}
    elif isinstance(existing_entry, dict):
        # 先复制旧条目，再覆盖三个必需字段：旧条目里的额外字段不会被顺手删掉
        new_entry = dict(existing_entry)
    else:
        raise PublishError(f"现有清单的 platforms.{platform} 既不是对象也不是 null，拒绝改写")

    new_entry["fileName"] = file_name
    new_entry["size"] = size
    new_entry["sha256"] = sha256

    updated = dict(data)
    if version is not None:
        updated["latestVersion"] = version
    updated["platforms"] = dict(platforms)
    updated["platforms"][platform] = new_entry
    return updated


def describe_platforms(data: Dict[str, Any]) -> str:
    """把各平台条目压缩成一行，便于在发布输出里确认「其它平台没被动过」。"""
    platforms = data.get("platforms")
    if not isinstance(platforms, dict):
        return "<platforms 缺失或不是对象>"
    parts = []
    for platform in manifest.PLATFORMS:
        entry = platforms.get(platform)
        if isinstance(entry, dict):
            parts.append(f"{platform}={entry.get('fileName')}({entry.get('size')} B)")
        elif entry is None:
            parts.append(f"{platform}=null")
        else:
            parts.append(f"{platform}=<非对象>")
    return "，".join(parts)


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="publish.py",
        description="计算安装包真实 size / sha256 并原子更新 data/manifest.json（只依赖标准库）",
    )
    parser.add_argument("file", help="安装包文件路径（真实存在、普通文件）")
    parser.add_argument(
        "--platform",
        required=True,
        choices=list(manifest.PLATFORMS),
        help="目标平台：win10 / linux / mac",
    )
    parser.add_argument(
        "--version",
        default=None,
        help="写入 latestVersion 的版本号；省略时保持清单现有 latestVersion 不变（只更新平台条目）",
    )
    parser.add_argument(
        "--manifest",
        default=str(DEFAULT_MANIFEST_PATH),
        help=f"清单文件路径，默认 {DEFAULT_MANIFEST_PATH}",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印字节数与 SHA-256，不写任何文件（清单字节与 mtime 均不变）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    _configure_stdout()
    args = parse_args(argv)

    file_path = Path(args.file)
    manifest_path = Path(args.manifest)

    try:
        if not file_path.exists():
            raise PublishError(f"安装包文件不存在：{file_path}")
        if not file_path.is_file():
            raise PublishError(f"安装包路径不是普通文件：{file_path}")
        file_name = file_path.name
        if not manifest.is_safe_file_name(file_name):
            raise PublishError(
                f"文件名不符合服务端白名单（^[A-Za-z0-9][A-Za-z0-9._-]{{0,127}}$）：{file_name!r}"
            )

        size, sha256 = compute_size_and_sha256(file_path)
        if size <= 0:
            raise PublishError(f"安装包是 0 字节文件，拒绝发布：{file_path}")

        data = read_manifest(manifest_path)
        stat_before = manifest_path.stat()
        updated = build_updated_manifest(data, args.platform, file_name, size, sha256, args.version)

        print("=" * 72)
        print("Delepi 安装包发布工具 publish.py")
        print("=" * 72)
        print(f"模式          = {'dry-run（只计算，不写任何文件）' if args.dry_run else 'write（原子替换清单）'}")
        print(f"安装包        = {file_path.resolve(strict=False)}")
        print(f"平台          = {args.platform}")
        print(f"文件名        = {file_name}")
        print(f"字节大小      = {size}")
        print(f"SHA-256       = {sha256}")
        print(f"清单文件      = {manifest_path.resolve(strict=False)}")
        print(f"清单字节数    = {stat_before.st_size}（写入前）")
        print(f"清单 mtime_ns = {stat_before.st_mtime_ns}（写入前）")
        print(f"版本          = {updated.get('latestVersion')}（latestVersion）")
        print(f"平台条目      = {describe_platforms(updated)}")
        print(f"保留字段      = {', '.join(sorted(k for k in updated if k not in ('latestVersion', 'platforms')))}")

        if args.dry_run:
            print("清单状态      = 未写入（dry-run）")
            print("=" * 72)
            return 0

        atomic_write_json(manifest_path, updated)
        stat_after = manifest_path.stat()
        print(f"清单字节数    = {stat_after.st_size}（写入后）")
        print(f"清单 mtime_ns = {stat_after.st_mtime_ns}（写入后）")
        print("清单状态      = 已原子替换（同目录临时文件 + os.replace）")
        print("=" * 72)
        return 0
    except PublishError as exc:
        print(f"[publish] 失败：{exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"[publish] 失败（IO 错误）：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
