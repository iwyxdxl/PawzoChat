# PawzoChat - Human-like, versatile, extensible AI companion engine
# Copyright (C) 2026  iwyxdxl
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""Validated, immutable plugin releases and bounded index retrieval.

Plugin signatures provide trust continuity after a key has been pinned by the
installer. A key supplied by an index is not independent proof of authorship.
"""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import asdict, dataclass
from functools import total_ordering
from threading import Event
from urllib.parse import urljoin, urlsplit

import requests
from urllib3.exceptions import HTTPError as UrllibHTTPError
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from pawzochat import __version__
from .platforms import normalize_platforms, supports_platform

MAX_INDEX_BYTES = 1024 * 1024
SIGNED_FIELDS = ("download_url", "id", "min_app_version", "pawzochat_plugin_index", "sha256", "version")
_ID_RE = re.compile(r"[a-z0-9][a-z0-9_-]*\Z")
_VERSION_RE = re.compile(
    r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z"
)


class PluginError(ValueError):
    """A safe, structured error shared by the installer and HTTP routes."""

    def __init__(self, code: str, message: str, status: int = 400, **details):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details

    def to_dict(self) -> dict:
        return {**self.details, "error": self.code, "message": self.message}


@total_ordering
@dataclass(frozen=True, eq=False)
class SemVersion:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...] = ()
    build: str = ""

    def _precedence(self):
        # Numeric identifiers precede non-numeric ones; release precedes no
        # prerelease (represented by the separate release flag).
        pre = tuple((0, int(p)) if p.isdigit() else (1, p) for p in self.prerelease)
        return self.major, self.minor, self.patch, not self.prerelease, pre

    def __eq__(self, other):
        if not isinstance(other, SemVersion):
            return NotImplemented
        return self._precedence() == other._precedence()

    def __lt__(self, other):
        if not isinstance(other, SemVersion):
            return NotImplemented
        return self._precedence() < other._precedence()

    def __hash__(self):
        return hash(self._precedence())


def parse_version(value: str) -> SemVersion:
    if not isinstance(value, str) or len(value) > 200:
        raise PluginError("bad_field", "版本必须是合法的 SemVer 字符串，如 1.2.0")
    match = _VERSION_RE.fullmatch(value)
    if not match:
        raise PluginError("bad_field", "版本必须是合法的 SemVer 字符串，如 1.2.0")
    major, minor, patch, pre, build = match.groups()
    parts = tuple(pre.split(".")) if pre else ()
    if any(p.isdigit() and len(p) > 1 and p.startswith("0") for p in parts):
        raise PluginError("bad_field", "预发布版本的数字标识不能包含前导零")
    return SemVersion(int(major), int(minor), int(patch), parts, build or "")


def validate_url(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 8192:
        raise PluginError("bad_field", "地址必须是 http/https URL")
    if value != value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise PluginError("bad_field", "URL 不能包含空白边界或控制字符")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError
        parsed.port  # Validate malformed and out-of-range port numbers.
    except ValueError as exc:
        raise PluginError("bad_field", "地址必须是合法的 http/https URL") from exc
    return value


def validate_plugin_id(value: str) -> str:
    if not isinstance(value, str) or len(value) > 128 or not _ID_RE.fullmatch(value):
        raise PluginError("bad_field", "插件 id 必须匹配 [a-z0-9][a-z0-9_-]*，且不超过 128 字符")
    return value


def _canonical_payload(index: dict) -> bytes:
    payload = {k: index.get(k, "") for k in SIGNED_FIELDS}
    # Preserve signatures of existing indexes, while authenticating a declared
    # restriction (including its presence) for platform-specific releases.
    if "platforms" in index:
        payload["platforms"] = index["platforms"]
    return json.dumps(payload,
                      sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def verify_index_signature(index: dict) -> None:
    present = ("public_key" in index, "signature" in index)
    if not any(present):
        return
    if not all(present):
        raise PluginError("signature_malformed", "public_key 和 signature 必须同时存在或同时缺失")
    try:
        if not isinstance(index["public_key"], str) or not isinstance(index["signature"], str):
            raise ValueError
        raw_key = base64.b64decode(index["public_key"], validate=True)
        signature = base64.b64decode(index["signature"], validate=True)
        if len(raw_key) != 32 or len(signature) != 64:
            raise ValueError
    except (ValueError, TypeError) as exc:
        raise PluginError("signature_malformed", "公钥和签名必须是合法的 base64，分别解码为 32 和 64 字节") from exc
    try:
        Ed25519PublicKey.from_public_bytes(raw_key).verify(signature, _canonical_payload(index))
    except InvalidSignature as exc:
        raise PluginError("signature_invalid", "插件索引签名验证失败，安装包可能已被篡改") from exc


@dataclass(frozen=True)
class ReleaseInfo:
    source_url: str
    id: str
    version: str
    download_url: str
    sha256: str
    name: str = ""
    description: str = ""
    author: str = ""
    min_app_version: str = ""
    changelog: str = ""
    public_key: str | None = None
    signature: str | None = None
    platforms: tuple[str, ...] = ()

    @property
    def app_compatible(self) -> bool:
        return not self.min_app_version or parse_version(__version__) >= parse_version(self.min_app_version)

    @property
    def platform_compatible(self) -> bool:
        return supports_platform(self.platforms)

    @property
    def compatible(self) -> bool:
        return self.app_compatible and self.platform_compatible

    def to_dict(self) -> dict:
        return asdict(self)


def parse_index(index: dict, *, source_url: str) -> ReleaseInfo:
    validate_url(source_url)
    if not isinstance(index, dict):
        raise PluginError("not_plugin_index", "插件索引顶层必须是 JSON 对象")
    marker = index.get("pawzochat_plugin_index")
    if type(marker) is not int or marker < 1:
        raise PluginError("not_plugin_index", "该 JSON 不是 PawzoChat 插件索引（需要整数 pawzochat_plugin_index）")
    if marker > 1:
        raise PluginError("index_too_new", f"插件索引格式版本过新（需要 {marker}，当前支持 1），请升级 PawzoChat")
    for field in ("id", "version", "download_url", "sha256"):
        if not isinstance(index.get(field), str) or not index[field]:
            raise PluginError("missing_field", f"索引缺少字符串字段 {field}")
    validate_plugin_id(index["id"])
    validate_url(index["download_url"])
    if not re.fullmatch(r"[0-9a-fA-F]{64}", index["sha256"]):
        raise PluginError("bad_field", "sha256 必须是 64 位十六进制字符串")
    parse_version(index["version"])
    for field in ("name", "description", "author", "min_app_version", "changelog"):
        if field in index and not isinstance(index[field], str):
            raise PluginError("bad_field", f"{field} 必须是字符串")
    if "min_app_version" in index:
        parse_version(index["min_app_version"])
    platforms = ()
    if "platforms" in index:
        try:
            platforms = normalize_platforms(index["platforms"])
        except ValueError as exc:
            raise PluginError("bad_field", str(exc)) from exc
    verify_index_signature(index)
    fields = {key: index[key] for key in ReleaseInfo.__dataclass_fields__
              if key != "source_url" and key in index}
    # Normalize only after verification; the signature covers the exact strings.
    fields["sha256"] = index["sha256"].lower()
    fields["platforms"] = platforms
    if "public_key" in fields:
        fields["public_key"] = base64.b64encode(base64.b64decode(fields["public_key"], validate=True)).decode("ascii")
    return ReleaseInfo(source_url=source_url, **fields)


def _check_request(cancel_event: Event | None, deadline: float | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise PluginError("cancelled", "已取消", 409)
    if deadline is not None and time.monotonic() >= deadline:
        raise PluginError("bad_response", "请求超过总时间限制", 502)


def open_http_stream(url: str, *, timeout=(5.0, 30.0), cancel_event: Event | None = None,
                     deadline: float | None = None) -> requests.Response:
    """Return a response whose redirects have been checked; caller must close it."""
    current = validate_url(url)
    for _ in range(6):
        _check_request(cancel_event, deadline)
        request_timeout = timeout
        if deadline is not None:
            left = max(0.01, deadline - time.monotonic())
            request_timeout = (min(timeout[0], left), min(timeout[1], left)) if isinstance(timeout, tuple) else min(timeout, left)
        try:
            response = requests.get(current, stream=True, allow_redirects=False,
                                    timeout=request_timeout, headers={"User-Agent": "PawzoChat-PluginInstaller"})
        except requests.RequestException as exc:
            raise PluginError("bad_response", "无法连接插件来源，请检查地址和网络", 502) from exc
        if response.status_code in {301, 302, 303, 307, 308}:
            location = response.headers.get("Location", "")
            response.close()
            if not location:
                raise PluginError("bad_response", "插件来源返回了缺少地址的重定向", 502)
            current = validate_url(urljoin(current, location))
            continue
        if not 200 <= response.status_code < 300:
            status = response.status_code
            response.close()
            raise PluginError("bad_response", f"插件来源返回 HTTP {status}", 502)
        return response
    raise PluginError("bad_response", "插件来源重定向次数过多", 502)


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def fetch_release(source_url: str, *, cancel_event: Event | None = None,
                  timeout: float = 30.0) -> ReleaseInfo:
    """Fetch at most one MiB, including decompressed HTTP response bytes."""
    validate_url(source_url)
    deadline = time.monotonic() + timeout
    chunks = []
    count = 0
    try:
        with open_http_stream(source_url, timeout=(min(5.0, timeout), timeout),
                              cancel_event=cancel_event, deadline=deadline) as response:
            while True:
                _check_request(cancel_event, deadline)
                # read1 yields after a network read instead of waiting to fill
                # a large iter_content chunk while an endpoint trickles bytes.
                chunk = response.raw.read1(8192, decode_content=True)
                _check_request(cancel_event, deadline)
                if not chunk:
                    break
                count += len(chunk)
                if count > MAX_INDEX_BYTES:
                    raise PluginError("bad_response", "索引响应体超过 1 MB", 400)
                chunks.append(chunk)
        _check_request(cancel_event, deadline)
    except (requests.RequestException, UrllibHTTPError, OSError) as exc:
        raise PluginError("bad_response", "读取插件索引失败或超时", 502) from exc
    try:
        index = json.loads(b"".join(chunks).decode("utf-8-sig"), object_pairs_hook=_json_object,
                           parse_constant=_reject_json_constant)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise PluginError("not_json", "响应不是合法的 JSON") from exc
    return parse_index(index, source_url=source_url)
