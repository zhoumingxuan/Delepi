# -*- coding: utf-8 -*-
"""配置加载模块。

读取顺序：
1. 优先读取同目录下的 config.json；
2. 缺失或不可用时回退到 config.example.json 的默认值，并向 stderr 打印告警；
3. 环境变量 DELEPI_UPDATE_ACCESS_KEYS（英文逗号分隔）会与配置里的 accessKeys 合并，
   用于在不改文件的情况下做「旧钥 + 新钥」双钥轮换。

安装包目录：
- packageDir 是所有平台共用的包根目录（默认 ./packages），实际路径为
  <packageDir>/<platform>/<fileName>；
- 可选键 platformPackageDirs 可以「按平台」覆盖包根目录，未配置的平台继续回退
  packageDir/<platform>；该键只影响目录，不影响平台白名单、文件名白名单、
  目录包含校验与符号链接逃逸阻断这四重校验。

注意：config.json 存在时只使用它自己的 accessKeys，绝不会再把示例配置里的开发占位
密钥合并进来，避免「换了密钥但旧占位密钥仍然可用」。
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

# 所有相对路径都以本文件所在目录为基准，避免受启动时工作目录影响
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
EXAMPLE_PATH = BASE_DIR / "config.example.json"

# 开发占位默认授权码（32 字符，符合 [A-Za-z0-9_-] 字符集）；上线前必须更换
DEFAULT_ACCESS_KEYS: Tuple[str, ...] = ("delepi_update_K7mQ3vTz9LpW4aB2cD",)
DEFAULT_PACKAGE_DIR = "./packages"
DEFAULT_MANIFEST_PATH = "./data/manifest.json"
DEFAULT_HTTP_READ_TIMEOUT_SECONDS = 10

# 平台白名单：必须与 manifest.PLATFORMS 完全一致（selfcheck.py 会断言两者相等）
SUPPORTED_PLATFORMS: Tuple[str, ...] = ("win10", "linux", "mac")

# platformPackageDirs 的默认值：空字典表示所有平台都使用 <packageDir>/<platform>
DEFAULT_PLATFORM_PACKAGE_DIRS: Dict[str, str] = {}

# 环境变量名：多把授权码用英文逗号分隔
ACCESS_KEYS_ENV = "DELEPI_UPDATE_ACCESS_KEYS"

# 授权码格式：32 字符，字符集 [A-Za-z0-9_-]（base64url 无填充），区分大小写
_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32}$")


@dataclass(frozen=True)
class Settings:
    """服务端运行期配置（不可变，避免运行中被意外改写）。"""

    access_keys: Tuple[str, ...]        # 所有同时有效的授权码
    package_dir: Path                   # 安装包根目录（绝对路径）
    manifest_path: Path                 # 版本清单文件（绝对路径）
    http_read_timeout_seconds: int      # 读请求头超时（秒），用于启动参数与反代配置建议
    config_source: str                  # 配置来源说明，仅用于启动日志
    platform_package_dirs: Dict[str, Path]  # 按平台覆盖的包根目录（只含显式配置的平台）

    def package_root_for(self, platform: str) -> Path:
        """返回该平台适用的「包根目录」。

        命中 platformPackageDirs 时返回覆盖值，否则返回全局 packageDir；
        最终安装包路径仍由 manifest.package_file_path 统一拼成
        <包根目录>/<platform>/<fileName>，因此四重路径校验不会被绕过。
        """
        override = self.platform_package_dirs.get(platform)
        if override is not None:
            return override
        return self.package_dir

    def platform_dir_for(self, platform: str) -> Path:
        """返回该平台安装包实际所在目录：<包根目录>/<platform>。

        该键缺省时结果就是 <packageDir>/<platform>，与改造前的行为逐字节一致。
        """
        return self.package_root_for(platform) / platform


def _warn(message: str) -> None:
    """向 stderr 打印告警：不打印授权码原文，避免日志泄露。"""
    print(f"[update_config] 警告：{message}", file=sys.stderr, flush=True)


def _read_json_object(path: Path) -> Optional[Dict[str, Any]]:
    """读取 JSON 对象；文件不存在返回 None，格式错误也返回 None 并告警。"""
    try:
        text = path.read_text(encoding="utf-8-sig")
        data = json.loads(text)
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _warn(f"读取 {path.name} 失败（{exc}），该文件中的配置项将使用默认值")
        return None
    if not isinstance(data, dict):
        _warn(f"{path.name} 顶层不是 JSON 对象，该文件中的配置项将使用默认值")
        return None
    return data


def _pick(config_data: Dict[str, Any], example_data: Dict[str, Any], key: str, default: Any) -> Any:
    """按「config.json → config.example.json → 代码默认值」的优先级取一个配置项。"""
    if config_data.get(key) is not None:
        return config_data[key]
    if example_data.get(key) is not None:
        return example_data[key]
    return default


def _parse_keys(value: Any) -> Tuple[str, ...]:
    """把字符串（逗号分隔）或数组解析成合法授权码元组；非法项告警后丢弃。"""
    if isinstance(value, str):
        candidates = [item.strip() for item in value.split(",")]
    elif isinstance(value, (list, tuple)):
        candidates = [item.strip() for item in value if isinstance(item, str)]
    else:
        return ()
    valid = []
    for item in candidates:
        if not item:
            continue
        if _KEY_PATTERN.fullmatch(item) is None:
            _warn("忽略一个格式不合法的授权码（要求 32 位、字符集 [A-Za-z0-9_-]；为避免泄露不打印原值）")
            continue
        valid.append(item)
    # dict.fromkeys 去重且保持先后顺序
    return tuple(dict.fromkeys(valid))


def _pick_timeout(value: Any) -> int:
    """解析读超时秒数，限制在 1–3600，非法值回退默认。"""
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        _warn("httpReadTimeoutSeconds 不是整数，已回退为 10 秒")
        return DEFAULT_HTTP_READ_TIMEOUT_SECONDS
    if seconds < 1 or seconds > 3600:
        _warn("httpReadTimeoutSeconds 超出 1–3600 范围，已回退为 10 秒")
        return DEFAULT_HTTP_READ_TIMEOUT_SECONDS
    return seconds


def _resolve_path(value: Any, default: str) -> Path:
    """把配置里的路径解析成绝对路径；相对路径以本文件所在目录为基准。"""
    text = value if isinstance(value, str) and value.strip() else default
    candidate = Path(text)
    if not candidate.is_absolute():
        candidate = BASE_DIR / candidate
    return candidate.resolve(strict=False)


def parse_platform_package_dirs(value: Any) -> Dict[str, Path]:
    """解析可选键 platformPackageDirs，返回「平台 -> 包根目录（绝对路径）」映射。

    完整语义：
    1. 值必须是 JSON 对象，键只能是 win10 / linux / mac（大小写敏感）；其它键告警后忽略；
    2. 每个值是字符串形式的目录：该平台的包根目录，最终安装包路径为
       <该目录>/<platform>/<fileName>；
    3. 若值的末级目录名恰好等于平台名（例如 /srv/releases/V1.7/win10），说明它已经是
       该平台的最终目录，不再重复追加平台名（否则会得到 .../win10/win10）；
    4. 相对路径以 update_config.py 所在目录为基准解析为绝对路径；
    5. 空字符串、非字符串、整体不是对象等非法输入只告警并忽略，对应平台回退
       packageDir/<platform>，绝不会让服务启动失败或放宽路径校验。
    """
    if value is None:
        return {}
    if not isinstance(value, dict):
        _warn("platformPackageDirs 不是 JSON 对象，已整体忽略（所有平台回退 packageDir/<platform>）")
        return {}

    result: Dict[str, Path] = {}
    for raw_platform, raw_dir in value.items():
        if not isinstance(raw_platform, str) or raw_platform not in SUPPORTED_PLATFORMS:
            _warn(f"platformPackageDirs 含不支持的平台键 {raw_platform!r}，已忽略（仅支持 win10 / linux / mac）")
            continue
        if raw_dir is None:
            continue
        if not isinstance(raw_dir, str) or not raw_dir.strip():
            _warn(f"platformPackageDirs.{raw_platform} 不是非空字符串，已忽略该平台（回退 packageDir/<platform>）")
            continue

        candidate = Path(raw_dir.strip())
        if not candidate.is_absolute():
            candidate = BASE_DIR / candidate
        resolved = candidate.resolve(strict=False)
        if resolved.name.lower() == raw_platform:
            root_dir = resolved.parent
        else:
            root_dir = resolved
        result[raw_platform] = root_dir

        effective_dir = root_dir / raw_platform
        if not effective_dir.is_dir():
            _warn(f"platformPackageDirs.{raw_platform} 指向的目录当前不存在：{effective_dir}（首次放包前出现该告警属正常）")
    return result


def load_config() -> Settings:
    """加载并合并配置；每次调用都会重新读文件，运行期只在进程启动时调用一次。"""
    example_data = _read_json_object(EXAMPLE_PATH) or {}
    config_data = _read_json_object(CONFIG_PATH)
    config_available = config_data is not None

    if not config_available:
        if CONFIG_PATH.exists():
            _warn("config.json 不可用，已回退到 config.example.json 的默认值")
        else:
            _warn("未找到 config.json，已回退到 config.example.json 的默认值；上线前请复制 config.example.json 为 config.json 并更换授权码")
        config_data = {}

    keys = _parse_keys(_pick(config_data, example_data, "accessKeys", list(DEFAULT_ACCESS_KEYS)))
    env_keys = _parse_keys(os.environ.get(ACCESS_KEYS_ENV, ""))
    if env_keys:
        keys = tuple(dict.fromkeys(keys + env_keys))

    if not keys:
        _warn("当前没有任何合法的授权码，所有请求都会返回 404，请检查 accessKeys 或 DELEPI_UPDATE_ACCESS_KEYS")

    package_dir = _resolve_path(_pick(config_data, example_data, "packageDir", DEFAULT_PACKAGE_DIR), DEFAULT_PACKAGE_DIR)
    manifest_path = _resolve_path(_pick(config_data, example_data, "manifestPath", DEFAULT_MANIFEST_PATH), DEFAULT_MANIFEST_PATH)
    timeout = _pick_timeout(_pick(config_data, example_data, "httpReadTimeoutSeconds", DEFAULT_HTTP_READ_TIMEOUT_SECONDS))
    platform_package_dirs = parse_platform_package_dirs(
        _pick(config_data, example_data, "platformPackageDirs", dict(DEFAULT_PLATFORM_PACKAGE_DIRS))
    )

    return Settings(
        access_keys=keys,
        package_dir=package_dir,
        manifest_path=manifest_path,
        http_read_timeout_seconds=timeout,
        config_source="config.json" if config_available else "config.example.json（默认值）",
        platform_package_dirs=platform_package_dirs,
    )


# 进程级单例：首次调用发生在 app.py 导入阶段，请求路径上不会重复读配置
_settings: Optional[Settings] = None
_settings_lock = threading.Lock()


def get_settings() -> Settings:
    """返回进程级配置单例（线程安全）。"""
    global _settings
    if _settings is None:
        with _settings_lock:
            if _settings is None:
                _settings = load_config()
    return _settings
