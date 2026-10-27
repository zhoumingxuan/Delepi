# -*- coding: utf-8 -*-
"""Delepi 自动更新 HTTP 服务端主文件。

职责：
1. 只对外提供两个业务路由：GET /check（检查更新）与 GET /download（下载安装包）；
2. 关闭 /docs、/redoc、/openapi.json，不注册任何 CORS 中间件；
3. 所有失败出口（路径不存在、方法不对、授权码错误、参数非法、清单或安装包不可用）
   统一收敛到 not_found.not_found()，保证这些失败在状态码与字节层面不可区分。

启动方式（二选一）：
    uvicorn app:app --host 0.0.0.0 --port 8080
    python app.py
"""

from __future__ import annotations

import logging
import re
import traceback
from typing import Dict, Optional

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

import auth
import manifest
import update_config
from not_found import not_found

# ---------------------------------------------------------------------------
# 启动期初始化：配置只在这里（进程启动时）读取一次；
# 请求路径上不会为了读配置而做磁盘 IO，更不会在鉴权之前触碰清单或包目录。
# ---------------------------------------------------------------------------
SETTINGS = update_config.get_settings()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("delepi.update")
logger.info(
    "配置来源=%s，有效授权码=%d 把，清单=%s，包目录=%s，读超时=%ds",
    SETTINGS.config_source,
    len(SETTINGS.access_keys),
    SETTINGS.manifest_path,
    SETTINGS.package_dir,
    SETTINGS.http_read_timeout_seconds,
)
# 按平台覆盖的包目录只在配置里出现时打印，便于部署时确认「最新包到底读的是哪个目录」
for _platform, _root_dir in sorted(SETTINGS.platform_package_dirs.items()):
    logger.info(
        "平台包目录覆盖：platform=%s，包根目录=%s，实际目录=%s",
        _platform,
        _root_dir,
        _root_dir / _platform,
    )

app = FastAPI(
    title="Delepi Update Server",
    docs_url=None,                    # 显式关闭 /docs
    redoc_url=None,                   # 显式关闭 /redoc
    openapi_url=None,                 # 显式关闭 /openapi.json
    swagger_ui_oauth2_redirect_url=None,
    redirect_slashes=False,           # 关闭「/check/ → /check」的 307 跳转，避免出现任何 3xx
)

_PLATFORM_VALUES = manifest.PLATFORMS
_VERSION_PATTERN = re.compile(r"^[0-9A-Za-z.+-]{1,32}$")

# 两个接口的公共响应头：禁止任何中间层缓存「带授权码」的响应
_BASE_RESPONSE_HEADERS: Dict[str, str] = {
    "Cache-Control": "no-store",
    "Vary": "X-Delepi-Update-Key",
}


@app.exception_handler(StarletteHTTPException)
async def _handle_http_exception(request: Request, exc: StarletteHTTPException) -> Response:
    """把框架抛出的 404（路径不存在）与 405（方法不对）统一收敛到同一个 404。"""
    return not_found()


@app.exception_handler(Exception)
async def _handle_unexpected_exception(request: Request, exc: Exception) -> Response:
    """兜底：未捕获异常也返回同一个 404；堆栈只写服务端日志，不回给客户端。"""
    logger.error("未捕获异常：%s\n%s", exc, traceback.format_exc())
    return not_found()


def _is_valid_version(value: Optional[str]) -> bool:
    """version 只校验长度 1–32 与字符集 [0-9A-Za-z.+-]，不做语义解析。"""
    return isinstance(value, str) and _VERSION_PATTERN.fullmatch(value) is not None


def _absent_response() -> Response:
    """无适配包：200 + Content-Length: 0 + X-Delepi-Package-Status: absent（不用 204、不用 404）。"""
    return Response(
        content=b"",
        status_code=200,
        media_type="application/octet-stream",
        headers={
            **_BASE_RESPONSE_HEADERS,
            "X-Delepi-Package-Status": "absent",
        },
    )


@app.get("/check", include_in_schema=False)
def check_update(request: Request) -> Response:
    """检查更新。

    处理顺序严格为：路由匹配（框架层）→ 方法判定 → 授权码判定 → 参数校验 → 磁盘 IO。
    鉴权失败时立即返回 404，不会读取清单文件，也不会对包目录做 stat/open。
    """
    # 1. 方法判定：只接受 GET（Starlette 会自动把 HEAD 也映射到 GET 路由，这里一并拒绝）
    if request.method != "GET":
        return not_found()

    # 2. 授权码判定：失败直接 404，且此后才允许触碰磁盘
    denied = auth.require_valid_key(request)
    if denied is not None:
        return denied

    # 3. 参数校验：platform 严格三值、version 必填且满足长度与字符集
    platform = request.query_params.get("platform")
    version = request.query_params.get("version")
    if platform not in _PLATFORM_VALUES or not _is_valid_version(version):
        return not_found()

    # 4. 磁盘 IO：读取清单并解析安装包元数据（只在鉴权与参数都通过后执行）
    manifest_data = manifest.load_manifest(SETTINGS.manifest_path)
    if manifest_data is None:
        return not_found()

    package = manifest.resolve_package(manifest_data, platform, SETTINGS.package_root_for(platform))

    # 5. 响应恰好五个字段，刻意不返回 hasUpdate（版本比较由客户端完成，避免两处真相）
    payload = {
        "schemaVersion": 1,
        "latestVersion": manifest_data["latestVersion"],
        "updateNotes": manifest_data["updateNotes"],
        "hasPackage": package is not None,
        "package": package,
    }
    return JSONResponse(content=payload, headers=dict(_BASE_RESPONSE_HEADERS))


@app.get("/download", include_in_schema=False)
def download_package(request: Request) -> Response:
    """下载安装包。

    无适配包时返回 200 + Content-Length: 0 + X-Delepi-Package-Status: absent；
    有适配包时用 FileResponse 从磁盘分块流式发送，不把整包读入内存。
    """
    # 1. 方法判定：只接受 GET
    if request.method != "GET":
        return not_found()

    # 2. 授权码判定：失败直接 404，且此前不触碰任何磁盘文件
    denied = auth.require_valid_key(request)
    if denied is not None:
        return denied

    # 3. 参数校验：platform 必填三值；version 可选，但传了就必须满足长度与字符集
    platform = request.query_params.get("platform")
    version = request.query_params.get("version")
    if platform not in _PLATFORM_VALUES:
        return not_found()
    if version is not None and not _is_valid_version(version):
        return not_found()

    # 4. 磁盘 IO：读取清单
    manifest_data = manifest.load_manifest(SETTINGS.manifest_path)
    if manifest_data is None:
        return not_found()

    # v1 只服务清单当前指向的版本：指定了其他版本按「无适配包」处理，避免历史包被任意拉取
    if version is not None and version != manifest_data["latestVersion"]:
        return _absent_response()

    package = manifest.resolve_package(manifest_data, platform, SETTINGS.package_root_for(platform))
    if package is None:
        return _absent_response()

    file_path = manifest.package_file_path(SETTINGS.package_root_for(platform), platform, package["fileName"])
    if file_path is None:
        return _absent_response()

    headers: Dict[str, str] = {
        **_BASE_RESPONSE_HEADERS,
        "X-Delepi-Package-Status": "present",
        "X-Delepi-Package-Sha256": package["sha256"],
        "ETag": f'"sha256:{package["sha256"]}"',
        "Accept-Ranges": "none",  # v1 不支持断点续传
    }

    # FileResponse 会在写出首个字节之前完成 stat/open：
    # 若文件此刻已被删除，异常会落到上面的兜底处理器，客户端仍然看到统一的 404。
    return FileResponse(
        path=str(file_path),
        media_type="application/octet-stream",
        filename=package["fileName"],
        headers=headers,
    )


if __name__ == "__main__":
    # 直接 python app.py 启动时使用的入口；等价于 uvicorn app:app --host 0.0.0.0 --port 8080
    import uvicorn

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8080,
        timeout_keep_alive=SETTINGS.http_read_timeout_seconds,
        server_header=False,
    )
