"""QR transport diagnostics without authorization data or upstream free text."""

from __future__ import annotations

import hashlib
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests

logger = logging.getLogger(__name__)

QR_STATUSES = frozenset({
    "wait", "scaned", "confirmed", "expired", "need_verifycode",
    "verify_code_blocked", "scaned_but_redirect", "binded_redirect",
})
ERROR_MESSAGES = {
    "timeout": "等待微信响应超时，正在重试",
    "connection": "连接微信服务失败，正在重试",
    "http": "微信服务暂时不可用，正在重试",
    "invalid_response": "微信返回了无法识别的响应，请重新开始",
    "upstream": "微信未完成授权请求，请稍后重新开始",
}


def _codes(data: dict) -> dict:
    # No arbitrary values from response fields may reach logs or the UI.
    return {key: int(str(data[key])) for key in ("ret", "errcode")
            if key in data and re.fullmatch(r"-?\d{1,12}", str(data[key]))}


def qr_error(kind: str, *, retryable: bool = False, data: dict | None = None) -> dict:
    return {
        "status": "wait" if retryable else "error",
        "error_kind": kind, "retryable": retryable,
        # Upstream errmsg is opaque and may echo QR codes or credentials.
        # Redact it completely, retaining numeric codes for diagnosis.
        "errmsg": ERROR_MESSAGES[kind], **_codes(data or {}),
    }


def qr_request(endpoint: str, base_url: str, *, headers: dict,
               tokens=(), qrcode: str = "", verify_code: str = "") -> dict:
    started = time.monotonic()
    http_status = None
    result = qr_error("invalid_response")
    correlation = hashlib.sha256(qrcode.encode()).hexdigest()[:16] if qrcode else "pending"
    host = "invalid"
    try:
        host = urlsplit(base_url).hostname or "invalid"
        # Limit logs to a hostname, never userinfo, path or query parameters.
        host = re.sub(r"[^a-zA-Z0-9.:-]", "_", host)[:253]
        url = f"{base_url.rstrip('/')}/ilink/bot/{endpoint}"
        if endpoint == "get_bot_qrcode":
            response = requests.post(url, params={"bot_type": 3},
                                     json={"local_token_list": list(tokens)},
                                     headers=headers, timeout=None)
        else:
            params = {"qrcode": qrcode}
            if verify_code:
                params["verify_code"] = verify_code
            response = requests.get(url, params=params, headers=headers, timeout=35)
        http_status = response.status_code
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            return result
        codes = _codes(data)
        if any(data.get(k) not in (None, 0, "0") for k in ("ret", "errcode")):
            result = qr_error("upstream", data=data)
        elif endpoint == "get_bot_qrcode":
            qr = data.get("qrcode")
            content = data.get("qrcode_img_content")
            if isinstance(qr, str) and qr and (content is None or isinstance(content, str)):
                correlation = hashlib.sha256(qr.encode()).hexdigest()[:16]
                result = {"qrcode": qr, "qrcode_img_content": content or qr, **codes}
        elif isinstance(data.get("status"), str) and data["status"] in QR_STATUSES:
            result = {key: data[key] for key in (
                "status", "bot_token", "ilink_bot_id", "ilink_user_id", "baseurl", "redirect_host",
            ) if isinstance(data.get(key), str)}
            result.update(codes)
        return result
    except requests.ConnectTimeout:
        result = qr_error("connection", retryable=True)
    except requests.Timeout:
        result = qr_error("timeout", retryable=True)
    except requests.HTTPError:
        result = qr_error("http", retryable=True)
    except (ValueError, TypeError):
        result = qr_error("invalid_response")
    except requests.RequestException:
        result = qr_error("connection", retryable=True)
    finally:
        logger.info(
            "weixin_qr time=%s endpoint=%s host=%s elapsed_ms=%d http=%s "
            "ret=%s errcode=%s status=%s error_kind=%s qr_id=%s",
            datetime.now(timezone.utc).isoformat(), endpoint, host,
            (time.monotonic() - started) * 1000, http_status,
            result.get("ret"), result.get("errcode"), result.get("status", "created"),
            result.get("error_kind", ""), correlation,
        )
    return result
