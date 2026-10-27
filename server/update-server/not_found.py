# -*- coding: utf-8 -*-
"""唯一的 404 产生器。

整个服务只有这一个函数可以产生 404：路径不存在、方法不对、授权码错误、参数非法、
清单或安装包不可用，全部调用它。响应逐字节固定为 22 字节：

    {"detail":"Not Found"}

无 BOM、无尾随换行、无额外字段、无任何自定义响应头（不带 X-Delepi-*、不带
WWW-Authenticate、不带 Retry-After），因此「错误授权码」与「随机不存在路径」
在状态码、Content-Type、Content-Length、响应体字节四项上完全一致。
"""

from __future__ import annotations

from starlette.responses import Response

# 与 Starlette/FastAPI 默认 404 完全一致的响应体（22 字节，UTF-8，不含 BOM 与换行）
NOT_FOUND_BODY: bytes = b'{"detail":"Not Found"}'

# 启动期自检：防止后续维护者误改常量导致字节数漂移
if len(NOT_FOUND_BODY) != 22:  # pragma: no cover
    raise RuntimeError("not_found 响应体必须是 22 字节")


def not_found() -> Response:
    """返回唯一的 404 响应：404 / application/json / Content-Length: 22。"""
    return Response(
        content=NOT_FOUND_BODY,
        status_code=404,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(NOT_FOUND_BODY)),
        },
    )
