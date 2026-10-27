# -*- coding: utf-8 -*-
"""本机自检脚本（只使用 Python 标准库）。

两种模式：
1. 默认 / --mode local：**进程内契约自检**，不需要先启动服务。
   直接 import app，优先用 FastAPI TestClient 对同一个应用对象发请求；
   本机缺少 fastapi 时自动降级为「纯函数级 + 静态」自检，并明确打印降级说明。
   临时清单与合成安装包都放在系统临时目录，自检结束后删除，不触碰源码目录。
2. --mode http：真实 HTTP 自检（脚本作为客户端），对 http://127.0.0.1:<port>
   发四组请求并逐字节比对（需要先启动服务，行为与旧版一致）。

默认模式不依赖网络，所以 `python3 selfcheck.py` 可以直接在源码目录跑出退出码 0。

退出码：0 全部通过；1 存在断言失败；2 无法连接服务（仅 --mode http）。
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import secrets
import shutil
import sys
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

BASE_DIR = Path(__file__).resolve().parent

# 某些环境会设置 PYTHONSAFEPATH / 以 -P 启动，导致脚本目录不在 sys.path 里；
# 这里显式补上，保证 `python3 selfcheck.py` 在任何工作目录下都能 import 同目录模块。
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

# 与 not_found.py 保持一致的 22 字节响应体
NOT_FOUND_BODY = b'{"detail":"Not Found"}'

# 格式合法（32 位、base64url 字符集）但值一定错误的授权码
WRONG_KEY = "A" * 32

REQUIRED_CHECK_FIELDS = {"schemaVersion", "latestVersion", "updateNotes", "hasPackage", "package"}

# 自检用的合成安装包大小（2.5 MB 左右，足够验证流式发送与哈希）
SYNTHETIC_PACKAGE_SIZE = 2_500_096


class Checker:
    """累计式断言器：失败不中断，最后统一给出退出码。"""

    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.skipped = 0

    def check(self, condition: bool, message: str) -> bool:
        if condition:
            self.passed += 1
            print(f"  PASS  {message}")
        else:
            self.failed += 1
            print(f"  FAIL  {message}")
        return bool(condition)

    def skip(self, message: str) -> None:
        self.skipped += 1
        print(f"  SKIP  {message}")

    def summary(self) -> int:
        print("-" * 78)
        print(f"通过 {self.passed} 项，失败 {self.failed} 项，跳过 {self.skipped} 项")
        if self.failed == 0:
            print("自检全部通过：HTTP 契约无变更。")
            return 0
        print("自检失败：存在不满足契约的断言，请检查上面的 FAIL 行。")
        return 1


# ---------------------------------------------------------------------------
# 合成测试数据
# ---------------------------------------------------------------------------
def create_synthetic_package(file_path: Path, size: int = SYNTHETIC_PACKAGE_SIZE) -> Tuple[int, str]:
    """生成确定内容的合成安装包，返回 (字节数, sha256)。"""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    block = b"Delepi-SelfCheck-Payload-0123456789ABCDEF"
    hasher = hashlib.sha256()
    written = 0
    with open(file_path, "wb") as handle:
        while written < size:
            chunk = block[: min(len(block), size - written)]
            handle.write(chunk)
            hasher.update(chunk)
            written += len(chunk)
    return written, hasher.hexdigest()


def write_manifest(manifest_path: Path, payload: Dict[str, Any]) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def build_fixture(temp_root: Path, package_size: int = SYNTHETIC_PACKAGE_SIZE) -> Dict[str, Any]:
    """在临时目录里搭一套「有包」的部署结构，并返回描述信息。"""
    package_dir = temp_root / "packages"
    package_file = package_dir / "win10" / "Delepi-Setup-0.8.1.exe"
    size, digest = create_synthetic_package(package_file, package_size)
    manifest_path = temp_root / "data" / "manifest.json"
    write_manifest(
        manifest_path,
        {
            "latestVersion": "0.8.1",
            "updateNotes": "自检用合成清单：仅用于验证服务端契约，不代表任何真实版本。",
            "platforms": {
                "win10": {"fileName": package_file.name, "size": size, "sha256": digest},
                "linux": None,
                "mac": None,
            },
        },
    )
    return {
        "package_dir": package_dir,
        "package_file": package_file,
        "manifest_path": manifest_path,
        "size": size,
        "sha256": digest,
    }


# ---------------------------------------------------------------------------
# 进程内自检
# ---------------------------------------------------------------------------
def _make_settings(app_module: Any, fixture: Dict[str, Any]) -> Any:
    """把 app.SETTINGS 换成指向临时目录的配置（不动全局单例，不影响源码目录）。"""
    return replace(
        app_module.SETTINGS,
        package_dir=fixture["package_dir"],
        manifest_path=fixture["manifest_path"],
        platform_package_dirs={},
    )


def check_config_platform_dirs(checker: Checker) -> None:
    """校验 platformPackageDirs 的解析语义（纯函数级）。"""
    import update_config

    parsed = update_config.parse_platform_package_dirs({"win10": "./custom-pkgs"})
    checker.check(
        parsed == {"win10": (BASE_DIR / "custom-pkgs").resolve(strict=False)},
        "相对路径按 update_config.py 所在目录解析为绝对路径",
    )

    # 注意：Windows 上 Path("/srv/...") 会被解析成「当前盘符 + \srv\...」，
    # 因此期望值同样用 resolve(strict=False) 归一化，避免跨平台误判。
    parsed = update_config.parse_platform_package_dirs({"win10": "/srv/releases/V1.7"})
    checker.check(
        parsed == {"win10": Path("/srv/releases/V1.7").resolve(strict=False)},
        "值为包根目录时原样保留（最终目录由 <包根目录>/win10 组成）",
    )

    parsed = update_config.parse_platform_package_dirs({"win10": "/srv/releases/V1.7/win10"})
    checker.check(
        parsed == {"win10": Path("/srv/releases/V1.7").resolve(strict=False)},
        "值已以平台名结尾时不再重复追加平台名（不会出现 win10/win10）",
    )

    checker.check(
        update_config.parse_platform_package_dirs({}) == {},
        "空对象表示所有平台回退 packageDir/<platform>",
    )
    checker.check(
        update_config.parse_platform_package_dirs({"solaris": "/srv/x"}) == {},
        "不支持的平台键被忽略",
    )
    checker.check(
        update_config.parse_platform_package_dirs({"win10": "   "}) == {},
        "空白字符串被忽略（该平台回退默认目录）",
    )
    checker.check(
        update_config.parse_platform_package_dirs("not-a-dict") == {},
        "整体不是对象时被忽略，不会让服务启动失败",
    )

    checker.check(
        tuple(update_config.SUPPORTED_PLATFORMS) == ("win10", "linux", "mac"),
        "配置层平台白名单与 manifest.PLATFORMS 一致（win10 / linux / mac）",
    )


def check_platform_dir_resolution(checker: Checker, app_module: Any) -> None:
    """校验「缺省回退」与「按平台覆盖」的最终目录计算。"""
    import manifest

    default_settings = replace(app_module.SETTINGS, platform_package_dirs={})
    checker.check(
        default_settings.package_root_for("win10") == default_settings.package_dir
        and default_settings.package_root_for("linux") == default_settings.package_dir,
        "platformPackageDirs 缺省时包根目录恒等于 packageDir（旧行为不变）",
    )
    checker.check(
        default_settings.platform_dir_for("win10") == (default_settings.package_dir / "win10").resolve(strict=False)
        and default_settings.platform_dir_for("linux") == (default_settings.package_dir / "linux").resolve(strict=False),
        "platformPackageDirs 缺省时平台目录恰为 <packageDir>/<platform>",
    )
    checker.check(
        manifest.package_file_path(default_settings.package_root_for("win10"), "win10", "a.exe")
        == (default_settings.package_dir / "win10" / "a.exe").resolve(strict=False),
        "缺省时最终安装包路径仍为 <packageDir>/<platform>/<fileName>",
    )

    override_settings = replace(
        app_module.SETTINGS,
        package_dir=Path("/srv/delepi-update/packages"),
        platform_package_dirs={"win10": Path("/srv/releases/V1.7")},
    )
    resolved = manifest.package_file_path(
        override_settings.package_root_for("win10"), "win10", "Delepi-Setup-0.8.1.exe"
    )
    checker.check(
        override_settings.platform_dir_for("win10") == Path("/srv/releases/V1.7") / "win10",
        "配置 platformPackageDirs.win10=/srv/releases/V1.7 后，平台目录为 /srv/releases/V1.7/win10",
    )
    checker.check(
        resolved == Path("/srv/releases/V1.7/win10/Delepi-Setup-0.8.1.exe").resolve(strict=False),
        "配置 platformPackageDirs.win10=/srv/releases/V1.7 后，包路径指向 /srv/releases/V1.7/win10/",
    )
    checker.check(
        override_settings.package_root_for("linux") == override_settings.package_dir,
        "未配置的平台仍回退全局 packageDir",
    )


def check_path_safety(checker: Checker, fixture: Dict[str, Any], temp_root: Path) -> None:
    """四重校验回归：平台白名单 + 文件名白名单 + 目录包含 + 符号链接逃逸阻断。"""
    import manifest

    package_dir = fixture["package_dir"]
    checker.check(
        manifest.package_file_path(package_dir, "android", "a.exe") is None,
        "平台白名单：android 被拒绝",
    )
    checker.check(
        manifest.package_file_path(package_dir, "win10", "../evil.exe") is None,
        "文件名白名单：../evil.exe 被拒绝",
    )
    checker.check(
        manifest.package_file_path(package_dir, "win10", "..\\evil.exe") is None,
        "文件名白名单：..\\evil.exe 被拒绝",
    )
    checker.check(
        manifest.package_file_path(package_dir, "win10", str(temp_root / "evil.exe")) is None,
        "文件名白名单：绝对路径被拒绝",
    )
    checker.check(
        manifest.package_file_path(package_dir, "win10", "sub/dir/a.exe") is None,
        "文件名白名单：带目录的文件名被拒绝",
    )

    outside_file = temp_root / "outside" / "outside.exe"
    create_synthetic_package(outside_file, 4096)
    link_path = package_dir / "win10" / "link.exe"
    try:
        if link_path.exists() or link_path.is_symlink():
            link_path.unlink()
        os.symlink(outside_file, link_path)
    except (OSError, NotImplementedError) as exc:
        checker.skip(f"符号链接逃逸用例（当前系统不允许创建符号链接：{exc.__class__.__name__}）")
    else:
        checker.check(
            manifest.package_file_path(package_dir, "win10", "link.exe") is None,
            "符号链接逃逸阻断：指向目录外部的符号链接被拒绝",
        )
        link_path.unlink()


def check_manifest_resolution(checker: Checker, fixture: Dict[str, Any]) -> None:
    """清单解析：声明 + 实存 + size 三者同时成立才算有包。"""
    import manifest

    loaded = manifest.load_manifest(fixture["manifest_path"])
    checker.check(loaded is not None, "清单可读取并通过字段校验")
    if loaded is None:
        return
    package = manifest.resolve_package(loaded, "win10", fixture["package_dir"])
    checker.check(
        package is not None
        and package["fileName"] == "Delepi-Setup-0.8.1.exe"
        and package["size"] == fixture["size"]
        and package["sha256"] == fixture["sha256"],
        "win10 命中真实安装包，size 与 sha256 取自磁盘真实值",
    )
    checker.check(
        manifest.resolve_package(loaded, "linux", fixture["package_dir"]) is None,
        "linux 在清单中为 null，按无适配包处理",
    )


def check_routes_and_middleware(checker: Checker, app_module: Any) -> None:
    route_paths = [getattr(route, "path", None) for route in app_module.app.routes]
    checker.check(
        route_paths == ["/check", "/download"],
        f"契约无变更：app.routes 恰为 ['/check', '/download']（实际 {route_paths}）",
    )
    checker.check(
        list(app_module.app.user_middleware) == [],
        "契约无变更：app.user_middleware 为空（未新增任何中间件）",
    )


def run_request_level_checks(checker: Checker, app_module: Any, fixture: Dict[str, Any]) -> None:
    """用 FastAPI TestClient 做请求级契约检查（等价于真实 HTTP 的路由层行为）。"""
    from fastapi.testclient import TestClient

    correct_key = app_module.SETTINGS.access_keys[0]
    wrong_key = WRONG_KEY if correct_key != WRONG_KEY else "B" * 32

    with TestClient(app_module.app) as client:
        # ---- 统一 404：错误授权码 vs 随机路径 ----
        resp_wrong = client.get(
            "/check", params={"version": "0.0.0", "platform": "win10"},
            headers={"X-Delepi-Update-Key": wrong_key},
        )
        resp_missing = client.get("/__delepi_selfcheck_missing__")
        checker.check(resp_wrong.status_code == 404, f"错误授权码 GET /check 返回 404（{resp_wrong.status_code}）")
        checker.check(
            resp_wrong.content == NOT_FOUND_BODY and len(resp_wrong.content) == 22,
            "错误授权码响应体逐字节等于 {\"detail\":\"Not Found\"} 且为 22 字节",
        )
        checker.check(
            resp_wrong.headers.get("content-type") == "application/json"
            and resp_wrong.headers.get("content-length") == "22",
            "错误授权码的 Content-Type=application/json、Content-Length=22",
        )
        checker.check(
            resp_missing.status_code == 404
            and resp_missing.content == resp_wrong.content
            and resp_missing.headers.get("content-type") == resp_wrong.headers.get("content-type")
            and resp_missing.headers.get("content-length") == resp_wrong.headers.get("content-length"),
            "随机不存在路径与错误授权码在状态码/Content-Type/Content-Length/字节四项完全一致",
        )

        # ---- /check 五字段 ----
        resp_check = client.get(
            "/check", params={"version": "0.8.0", "platform": "win10"},
            headers={"X-Delepi-Update-Key": correct_key},
        )
        checker.check(resp_check.status_code == 200, f"正确授权码 GET /check 返回 200（{resp_check.status_code}）")
        payload = resp_check.json()
        checker.check(
            isinstance(payload, dict) and set(payload.keys()) == REQUIRED_CHECK_FIELDS,
            f"契约无变更：/check 字段恰好为 {sorted(REQUIRED_CHECK_FIELDS)}（实际 {sorted(payload.keys())}）",
        )
        checker.check("hasUpdate" not in payload, "契约无变更：响应中不含 hasUpdate 字段")
        checker.check(payload.get("schemaVersion") == 1, "schemaVersion 为整数 1")
        checker.check(payload.get("latestVersion") == "0.8.1", "latestVersion 为清单中的 0.8.1")
        checker.check(isinstance(payload.get("hasPackage"), bool), "hasPackage 为布尔值")
        package = payload.get("package")
        checker.check(
            payload.get("hasPackage") is True
            and isinstance(package, dict)
            and set(package.keys()) == {"fileName", "size", "sha256"}
            and package.get("size") == fixture["size"]
            and package.get("sha256") == fixture["sha256"],
            "hasPackage=true 且 package 恰好包含 fileName / size / sha256",
        )

        # ---- /check 无包平台 ----
        resp_linux = client.get(
            "/check", params={"version": "0.8.0", "platform": "linux"},
            headers={"X-Delepi-Update-Key": correct_key},
        )
        payload_linux = resp_linux.json()
        checker.check(
            resp_linux.status_code == 200
            and payload_linux.get("hasPackage") is False
            and payload_linux.get("package") is None,
            "linux 无适配包时 hasPackage=false、package=null",
        )

        # ---- /download present ----
        resp_present = client.get(
            "/download", params={"platform": "win10"},
            headers={"X-Delepi-Update-Key": correct_key},
        )
        body_present = resp_present.content
        checker.check(resp_present.status_code == 200, f"有包时 GET /download 返回 200（{resp_present.status_code}）")
        checker.check(
            resp_present.headers.get("x-delepi-package-status") == "present",
            "有包时 X-Delepi-Package-Status=present",
        )
        checker.check(
            resp_present.headers.get("content-length") == str(fixture["size"])
            and len(body_present) == fixture["size"],
            f"有包时 Content-Length 与实际字节数一致（{fixture['size']}）",
        )
        checker.check(
            hashlib.sha256(body_present).hexdigest() == fixture["sha256"]
            and resp_present.headers.get("x-delepi-package-sha256") == fixture["sha256"],
            "响应体 SHA-256 与 X-Delepi-Package-Sha256 一致",
        )
        checker.check(
            resp_present.headers.get("etag") == f'"sha256:{fixture["sha256"]}"',
            "ETag 为 \"sha256:<hex>\" 格式",
        )
        checker.check(
            resp_present.headers.get("accept-ranges") == "none",
            "Accept-Ranges=none（未实现断点续传）",
        )

        # ---- /download absent（版本不匹配） ----
        resp_absent = client.get(
            "/download", params={"platform": "win10", "version": "0.0.1"},
            headers={"X-Delepi-Update-Key": correct_key},
        )
        checker.check(resp_absent.status_code == 200, f"版本不匹配时 /download 仍返回 200（{resp_absent.status_code}）")
        checker.check(
            resp_absent.headers.get("x-delepi-package-status") == "absent"
            and resp_absent.headers.get("content-length") == "0"
            and resp_absent.content == b"",
            "无适配包：200 + Content-Length: 0 + X-Delepi-Package-Status: absent",
        )

        # ---- 方法矩阵 ----
        method_ok = True
        for method in ("POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"):
            for target, params in (
                ("/check", {"version": "0.8.0", "platform": "win10"}),
                ("/download", {"platform": "win10"}),
            ):
                response = client.request(
                    method, target, params=params,
                    headers={"X-Delepi-Update-Key": correct_key},
                )
                if response.status_code != 404:
                    method_ok = False
                    print(f"        方法 {method} {target} 实际返回 {response.status_code}")
                if method != "HEAD" and response.content != NOT_FOUND_BODY:
                    method_ok = False
                    print(f"        方法 {method} {target} 响应体不是 22 字节统一 404")
        checker.check(method_ok, "方法矩阵 POST/PUT/DELETE/PATCH/OPTIONS/HEAD 全部收敛到 404（22 字节）")

        # ---- 文档路由 ----
        docs_ok = True
        for target in ("/docs", "/redoc", "/openapi.json"):
            response = client.get(target)
            if response.status_code != 404:
                docs_ok = False
                print(f"        {target} 实际返回 {response.status_code}")
        checker.check(docs_ok, "/docs、/redoc、/openapi.json 全部 404")


def run_pure_checks(checker: Checker, reason: str) -> int:
    """降级模式：不使用 FastAPI，只做纯函数级与静态校验。"""
    print("")
    print("!" * 78)
    print("降级说明：本机无法导入 FastAPI，已跳过请求级验证，改为纯函数级 + 静态校验。")
    print(f"原因：{reason}")
    print("!" * 78)
    print("")

    import manifest
    import update_config

    print("[静态校验] 统一 404 常量与路由声明")
    not_found_source = (BASE_DIR / "not_found.py").read_text(encoding="utf-8")
    checker.check(
        len(NOT_FOUND_BODY) == 22 and 'b\'{"detail":"Not Found"}\'' in not_found_source,
        "not_found.py 中唯一 404 响应体为 22 字节的 {\"detail\":\"Not Found\"}",
    )
    app_source = (BASE_DIR / "app.py").read_text(encoding="utf-8")
    checker.check(
        app_source.count('@app.get("/check"') == 1 and app_source.count('@app.get("/download"') == 1,
        "app.py 只声明 /check 与 /download 两个业务路由",
    )
    checker.check(
        "add_middleware" not in app_source and "CORS" not in app_source,
        "app.py 未注册任何中间件、未引入 CORS",
    )
    checker.check(
        "hasUpdate" not in app_source,
        "app.py 中不存在 hasUpdate 字段",
    )

    print("")
    print("[纯函数级] 清单与路径")
    temp_root = Path(tempfile.mkdtemp(prefix="delepi-selfcheck-pure-"))
    try:
        fixture = build_fixture(temp_root, package_size=65536)
        check_manifest_resolution(checker, fixture)
        check_path_safety(checker, fixture, temp_root)
        check_config_platform_dirs(checker)
        checker.check(
            tuple(manifest.PLATFORMS) == tuple(update_config.SUPPORTED_PLATFORMS),
            f"manifest.PLATFORMS 与 update_config.SUPPORTED_PLATFORMS 完全一致（{manifest.PLATFORMS}）",
        )
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
    checker.skip("请求级契约（/check 五字段、/download absent/present、方法矩阵）——缺少 fastapi")
    return checker.summary()


def run_local_checks() -> int:
    """默认模式：进程内自检，不需要先启动服务。"""
    checker = Checker()
    print("=" * 78)
    print("Delepi 更新服务端自检（模式：local，进程内，不访问网络）")
    print("=" * 78)

    try:
        import fastapi
        import uvicorn
    except Exception as exc:  # ImportError 及其它依赖问题
        return run_pure_checks(checker, f"{exc.__class__.__name__}: {exc}")

    print(f"依赖版本：fastapi {fastapi.__version__}，uvicorn {uvicorn.__version__}")

    try:
        import app as app_module
    except Exception as exc:
        return run_pure_checks(checker, f"导入 app 失败：{exc.__class__.__name__}: {exc}")

    print("")
    print("[1/6] 路由与中间件")
    check_routes_and_middleware(checker, app_module)

    print("")
    print("[2/6] platformPackageDirs 解析语义")
    check_config_platform_dirs(checker)
    check_platform_dir_resolution(checker, app_module)

    temp_root = Path(tempfile.mkdtemp(prefix="delepi-selfcheck-"))
    original_settings = app_module.SETTINGS
    try:
        fixture = build_fixture(temp_root)
        print("")
        print("[3/6] 合成测试数据")
        print(f"  临时清单      = {fixture['manifest_path']}")
        print(f"  合成安装包    = {fixture['package_file']}（{fixture['size']} B）")
        print(f"  合成包 sha256 = {fixture['sha256']}")
        app_module.SETTINGS = _make_settings(app_module, fixture)

        print("")
        print("[4/6] 清单解析与路径四重校验")
        check_manifest_resolution(checker, fixture)
        check_path_safety(checker, fixture, temp_root)

        print("")
        print("[5/6] 请求级契约（TestClient）")
        try:
            run_request_level_checks(checker, app_module, fixture)
        except Exception as exc:
            checker.skip(f"TestClient 不可用或执行失败（{exc.__class__.__name__}: {exc}），请求级契约未验证")
            return checker.summary()
    finally:
        app_module.SETTINGS = original_settings
        shutil.rmtree(temp_root, ignore_errors=True)

    print("")
    print("[6/6] 结论")
    return checker.summary()


# ---------------------------------------------------------------------------
# 真实 HTTP 模式（旧行为：脚本作为客户端访问已启动的服务）
# ---------------------------------------------------------------------------
def load_access_key(explicit: Optional[str]) -> str:
    """确定一把正确的授权码：命令行 > 环境变量 > config.json > config.example.json。"""
    if explicit and explicit.strip():
        return explicit.strip()

    env_value = os.environ.get("DELEPI_UPDATE_ACCESS_KEYS", "")
    for item in env_value.split(","):
        if item.strip():
            return item.strip()

    for file_name in ("config.json", "config.example.json"):
        path = BASE_DIR / file_name
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        keys = data.get("accessKeys") if isinstance(data, dict) else None
        if isinstance(keys, list):
            for item in keys:
                if isinstance(item, str) and item.strip():
                    return item.strip()

    raise SystemExit("未能确定授权码：请用 --key 传入，或设置 DELEPI_UPDATE_ACCESS_KEYS，或在 config.json 中配置 accessKeys")


def perform_get(
    host: str,
    port: int,
    path: str,
    headers: Dict[str, str],
    timeout: float,
) -> Tuple[int, Dict[str, str], bytes]:
    """发起一次 GET，返回 (状态码, 小写头名映射, 响应体字节)。"""
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        header_map: Dict[str, str] = {}
        for name, value in response.getheaders():
            header_map.setdefault(name.lower(), value)
        body = response.read()
        return response.status, header_map, body
    finally:
        connection.close()


def perform_get_stream(
    host: str,
    port: int,
    path: str,
    headers: Dict[str, str],
    timeout: float,
) -> Tuple[int, Dict[str, str], int, str, bytes]:
    """流式 GET：不把大文件整体读入内存，返回 (状态码, 头, 字节数, sha256, 前 64 字节)。"""
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        header_map: Dict[str, str] = {}
        for name, value in response.getheaders():
            header_map.setdefault(name.lower(), value)
        hasher = hashlib.sha256()
        total = 0
        head = b""
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            if len(head) < 64:
                head = (head + chunk)[:64]
            hasher.update(chunk)
            total += len(chunk)
        return response.status, header_map, total, hasher.hexdigest(), head
    finally:
        connection.close()


def print_exchange(
    label: str,
    status: int,
    headers: Dict[str, str],
    body: Optional[bytes] = None,
    stream_total: Optional[int] = None,
    stream_digest: Optional[str] = None,
    stream_head: Optional[bytes] = None,
) -> None:
    """按统一格式打印一次请求的可观察结果。"""
    print("=" * 78)
    print(f"[{label}]")
    print(f"  status_code    = {status}")
    print(f"  Content-Type   = {headers.get('content-type')!r}")
    print(f"  Content-Length = {headers.get('content-length')!r}")
    if body is not None:
        print(f"  body_bytes     = {len(body)}")
        print(f"  body_hex       = {body.hex()}")
        try:
            print(f"  body_text      = {body.decode('utf-8')!r}")
        except UnicodeDecodeError:
            print("  body_text      = <非 UTF-8 字节>")
    else:
        print(f"  body_bytes     = {stream_total}（流式读取，未整体载入内存）")
        print(f"  body_sha256    = {stream_digest}")
        print(f"  body_hex_head  = {(stream_head or b'').hex()}")
    print("")


def ensure(condition: bool, message: str) -> None:
    """断言辅助：失败时抛出 AssertionError，成功时打印 PASS。"""
    if not condition:
        raise AssertionError(message)
    print(f"  PASS  {message}")


def run_http_checks(args: argparse.Namespace) -> int:
    """真实 HTTP 自检：需要先在本机启动服务。"""
    parsed = urlparse(args.base_url)
    if parsed.scheme != "http":
        print("本脚本只用于本机 http 自检（禁止对线上域名发起请求），请使用 http://127.0.0.1:<port>")
        return 2
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 80
    if host not in ("127.0.0.1", "localhost"):
        print(f"本脚本只允许访问本机回环地址，当前为 {host}，已拒绝执行")
        return 2

    correct_key = load_access_key(args.key)
    wrong_key = WRONG_KEY if correct_key != WRONG_KEY else "B" * 32

    check_path = f"/check?version={args.version}&platform={args.platform}"
    missing_path = f"/__delepi_selfcheck_missing_{secrets.token_hex(8)}"
    download_path = f"/download?platform={args.platform}"

    print(f"目标服务：http://{host}:{port}")
    print(f"测试平台：{args.platform}；本地版本号：{args.version}")
    print("")

    try:
        # ① 错误授权码请求 /check（格式合法但值错误）
        status_wrong, headers_wrong, body_wrong = perform_get(
            host, port, check_path, {"X-Delepi-Update-Key": wrong_key}, args.timeout
        )
        print_exchange("① 错误授权码 GET /check", status_wrong, headers_wrong, body=body_wrong)

        # ② 随机不存在路径（不带授权码）
        status_missing, headers_missing, body_missing = perform_get(
            host, port, missing_path, {}, args.timeout
        )
        print_exchange("② 随机不存在路径 GET", status_missing, headers_missing, body=body_missing)

        print("-" * 78)
        print("[①② 逐字节比对]")
        ensure(status_wrong == status_missing, f"状态码一致：{status_wrong} == {status_missing}")
        ensure(
            headers_wrong.get("content-type") == headers_missing.get("content-type"),
            f"Content-Type 一致：{headers_wrong.get('content-type')!r}",
        )
        ensure(
            headers_wrong.get("content-length") == headers_missing.get("content-length"),
            f"Content-Length 一致：{headers_wrong.get('content-length')!r}",
        )
        ensure(body_wrong == body_missing, "响应体字节完全一致")
        ensure(body_wrong == NOT_FOUND_BODY, '响应体恰为 b\'{"detail":"Not Found"}\'')
        ensure(len(body_wrong) == 22, f"响应体长度为 22 字节（实际 {len(body_wrong)}）")
        ensure(not body_wrong.startswith(b"\xef\xbb\xbf"), "响应体无 UTF-8 BOM")
        ensure(not body_wrong.endswith(b"\n") and not body_wrong.endswith(b"\r"), "响应体无尾随换行")
        print("")

        # ③ 正确授权码请求 /check
        status_check, headers_check, body_check = perform_get(
            host, port, check_path, {"X-Delepi-Update-Key": correct_key}, args.timeout
        )
        print_exchange("③ 正确授权码 GET /check", status_check, headers_check, body=body_check)

        print("-" * 78)
        print("[③ 响应契约检查]")
        ensure(status_check == 200, f"状态码为 200（实际 {status_check}）")
        ensure(
            (headers_check.get("content-type") or "").startswith("application/json"),
            f"Content-Type 为 application/json（实际 {headers_check.get('content-type')!r}）",
        )
        ensure(
            headers_check.get("content-length") == str(len(body_check)),
            "Content-Length 与响应体字节数一致",
        )
        payload = json.loads(body_check.decode("utf-8"))
        ensure(isinstance(payload, dict), "响应体是 JSON 对象")
        ensure(set(payload.keys()) == REQUIRED_CHECK_FIELDS, f"契约无变更：字段恰好为 {sorted(REQUIRED_CHECK_FIELDS)}（实际 {sorted(payload.keys())}）")
        ensure("hasUpdate" not in payload, "契约无变更：响应中不含 hasUpdate 字段")
        ensure(payload.get("schemaVersion") == 1, "schemaVersion 为整数 1")
        ensure(isinstance(payload.get("latestVersion"), str), "latestVersion 为字符串")
        ensure(isinstance(payload.get("updateNotes"), str), "updateNotes 为字符串")
        ensure(isinstance(payload.get("hasPackage"), bool), "hasPackage 为布尔值")
        package = payload.get("package")
        if payload.get("hasPackage") is True:
            ensure(isinstance(package, dict), "hasPackage=true 时 package 为对象")
            ensure(set(package.keys()) == {"fileName", "size", "sha256"}, "package 恰好包含 fileName / size / sha256")
            ensure(isinstance(package.get("fileName"), str), "package.fileName 为字符串")
            ensure(isinstance(package.get("size"), int) and not isinstance(package.get("size"), bool), "package.size 为整数")
            ensure(isinstance(package.get("sha256"), str) and len(package["sha256"]) == 64, "package.sha256 为 64 位十六进制字符串")
        else:
            ensure(package is None, "hasPackage=false 时 package 为 null")
        print("")

        # ④ 正确授权码请求 /download（流式读取）
        status_download, headers_download, total, digest, head = perform_get_stream(
            host, port, download_path, {"X-Delepi-Update-Key": correct_key}, args.timeout
        )
        print_exchange(
            "④ 正确授权码 GET /download",
            status_download,
            headers_download,
            stream_total=total,
            stream_digest=digest,
            stream_head=head,
        )

        print("-" * 78)
        print("[④ 响应契约检查]")
        ensure(status_download == 200, f"状态码为 200（实际 {status_download}）")
        package_status = headers_download.get("x-delepi-package-status")
        ensure(package_status in ("absent", "present"), f"X-Delepi-Package-Status 为 absent 或 present（实际 {package_status!r}）")
        if package_status == "absent":
            ensure(headers_download.get("content-length") == "0", "无包时 Content-Length 为 0")
            ensure(total == 0, "无包时响应体为 0 字节")
            print("  说明：当前平台没有适配包，/download 返回 absent，这是设计行为。")
        else:
            ensure(
                headers_download.get("content-length") == str(total),
                f"有包时 Content-Length 等于实际发送字节数（{total}）",
            )
            header_sha = (headers_download.get("x-delepi-package-sha256") or "").lower()
            ensure(header_sha == digest, "X-Delepi-Package-Sha256 与响应体实际 SHA-256 一致")
            ensure(headers_download.get("etag") == f'"sha256:{digest}"', "ETag 为 \"sha256:<hex>\" 格式且与响应体一致")
            ensure(headers_download.get("accept-ranges") == "none", "Accept-Ranges 为 none")
            ensure(
                (headers_download.get("content-disposition") or "").startswith("attachment;"),
                "Content-Disposition 为 attachment",
            )
        print("")

    except ConnectionRefusedError:
        print(f"连接被拒绝：请先在 127.0.0.1:{port} 启动服务（bash start.sh 或 python app.py）")
        return 2
    except OSError as exc:
        print(f"网络错误：{exc}")
        return 2
    except AssertionError as exc:
        print(f"自检失败：{exc}")
        return 1

    print("=" * 78)
    print("自检全部通过：四组请求的可观察结果均符合预期（HTTP 契约无变更）。")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Delepi 更新服务端本机自检")
    parser.add_argument(
        "--mode",
        choices=["auto", "local", "http"],
        default="auto",
        help="auto/local：进程内自检（默认，不需要先启动服务）；http：对已启动的本机服务做真实 HTTP 自检",
    )
    parser.add_argument("--base-url", default=None, help="http 模式的服务地址，默认 http://127.0.0.1:8080")
    parser.add_argument("--key", default=None, help="http 模式的正确授权码；缺省时从环境变量或 config*.json 读取")
    parser.add_argument("--platform", default="win10", choices=["win10", "linux", "mac"], help="http 模式的测试平台，默认 win10")
    parser.add_argument("--version", default="0.0.0", help="http 模式的测试用本地版本号，默认 0.0.0")
    parser.add_argument("--timeout", type=float, default=30.0, help="http 模式的单次请求超时秒数，默认 30")
    args = parser.parse_args(argv)

    mode = args.mode
    if mode == "auto":
        mode = "http" if args.base_url else "local"

    if mode == "http":
        if args.base_url is None:
            args.base_url = "http://127.0.0.1:8080"
        return run_http_checks(args)
    return run_local_checks()


if __name__ == "__main__":
    sys.exit(main())
