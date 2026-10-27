# -*- coding: utf-8 -*-
"""授权码校验模块。

规则：
1. 只从请求头 X-Delepi-Update-Key 读取授权码，不接受 query 传参（避免落访问日志）；
2. 支持多把密钥同时有效：环境变量 DELEPI_UPDATE_ACCESS_KEYS + config.json 的 accessKeys；
3. 全部使用 hmac.compare_digest 做常量时间比对，禁止使用 ==；
4. 校验失败一律返回 not_found()，绝不返回 401/403，也绝不设置 WWW-Authenticate。
"""

from __future__ import annotations

import hmac
import re
from typing import Optional

from fastapi import Request
from starlette.responses import Response

import update_config
from not_found import not_found

# 授权码请求头名（大小写不敏感，但客户端固定使用这个写法）
HEADER_NAME = "X-Delepi-Update-Key"

# 授权码格式：32 字符，字符集 [A-Za-z0-9_-]，区分大小写
_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32}$")


def _candidate_key(request: Request) -> Optional[str]:
    """从请求头取授权码；缺失或格式不合法的返回 None（后续统一走 404）。"""
    raw = request.headers.get(HEADER_NAME)
    if raw is None:
        return None
    candidate = raw.strip()
    if _KEY_PATTERN.fullmatch(candidate) is None:
        return None
    return candidate


def is_authorized(request: Request) -> bool:
    """判断请求是否携带了任意一把有效授权码。"""
    candidate = _candidate_key(request)
    if candidate is None:
        return False
    candidate_bytes = candidate.encode("ascii")

    matched = False
    for configured in update_config.get_settings().access_keys:
        try:
            configured_bytes = configured.encode("ascii")
        except UnicodeEncodeError:
            # 配置解析阶段已过滤非 ASCII，这里是兜底，绝不因为坏配置导致 500
            continue
        # 注意：不使用短路 return，无论命中哪一把都比对完全部密钥，
        # 避免通过响应耗时推断命中的是第几把密钥
        if hmac.compare_digest(candidate_bytes, configured_bytes):
            matched = True
    return matched


def require_valid_key(request: Request) -> Optional[Response]:
    """鉴权守卫：通过返回 None；失败返回统一的 404 响应。

    这是「鉴权失败统一走 not_found()」的唯一入口，app.py 在每个业务路由的第一步调用它。
    """
    if is_authorized(request):
        return None
    return not_found()
