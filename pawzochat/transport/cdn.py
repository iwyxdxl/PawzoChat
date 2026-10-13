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

"""CDN upload/download for WeChat iLink — AES-128-ECB encryption.

This file contains code ported from ``@tencent-weixin/openclaw-weixin``
``src/cdn/`` (MIT-licensed).
See https://github.com/Tencent/openclaw-weixin for the original.

Upload: read file → MD5 + size → generate AES key → encrypt ECB →
        getUploadUrl → POST ciphertext to CDN → read x-encrypted-param header.

Download: build CDN URL from encrypt_query_param → GET ciphertext →
          parse AES key → decrypt ECB → plaintext bytes.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
from pathlib import Path
import re
import secrets
from urllib.parse import quote

import requests
from Crypto.Cipher import AES

from pawzochat.transport.client import CDN_BASE_URL, ILinkClient
from pawzochat.transport.models import CDNMedia, ImageData, UploadMediaType

logger = logging.getLogger(__name__)

UPLOAD_MAX_RETRIES = 3
DOWNLOAD_MAX_RETRIES = 3
DOWNLOAD_CHUNK_SIZE = 1024 * 1024
DEFAULT_IMAGE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024
DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

# ---------------------------------------------------------------------------
# AES-128-ECB helpers
# ---------------------------------------------------------------------------


def _aes_ecb_encrypt(plaintext: bytes, key: bytes) -> bytes:
    """AES-128-ECB encrypt with PKCS7 padding."""
    pad_len = 16 - (len(plaintext) % 16)
    padded = plaintext + bytes([pad_len] * pad_len)
    cipher = AES.new(key, AES.MODE_ECB)
    return cipher.encrypt(padded)


def _aes_ecb_decrypt(ciphertext: bytes, key: bytes) -> bytes:
    """AES-128-ECB decrypt with PKCS7 unpadding."""
    cipher = AES.new(key, AES.MODE_ECB)
    padded = cipher.decrypt(ciphertext)
    return _strip_pkcs7_padding(padded)


def _strip_pkcs7_padding(padded: bytes) -> bytes:
    """Reject corrupt data instead of passing invalid plaintext to callers."""
    if not padded or len(padded) % 16:
        raise ValueError("invalid PKCS7 padded length")
    pad_len = padded[-1]
    if pad_len < 1 or pad_len > 16 or padded[-pad_len:] != bytes([pad_len]) * pad_len:
        raise ValueError("invalid PKCS7 padding")
    return padded[:-pad_len]


def _build_cdn_upload_url(cdn_base: str, upload_param: str, filekey: str) -> str:
    return (
        f"{cdn_base}/upload"
        f"?encrypted_query_param={quote(upload_param, safe='')}"
        f"&filekey={quote(filekey, safe='')}"
    )


def _build_cdn_download_url(cdn_base: str, encrypt_query_param: str) -> str:
    return (
        f"{cdn_base}/download"
        f"?encrypted_query_param={quote(encrypt_query_param, safe='')}"
    )


def upload_image(
    client: ILinkClient,
    image_path: str,
    to_user_id: str,
    cdn_base: str = CDN_BASE_URL,
) -> dict:
    """Upload a local image file to Weixin CDN.

    Returns a dict with keys needed to construct an image message:
      - encrypt_query_param: CDN download param
      - aes_key: base64-encoded AES-128 key
      - mid_size: ciphertext file size
    """
    with open(image_path, "rb") as f:
        plaintext = f.read()

    raw_size = len(plaintext)
    raw_md5 = hashlib.md5(plaintext).hexdigest()
    aes_key = secrets.token_bytes(16)
    aes_key_hex = aes_key.hex()
    ciphertext = _aes_ecb_encrypt(plaintext, aes_key)
    file_size = len(ciphertext)
    filekey = secrets.token_hex(16)

    logger.debug(
        "CDN upload: file=%s raw=%d cipher=%d md5=%s filekey=%s",
        os.path.basename(image_path), raw_size, file_size, raw_md5, filekey,
    )

    resp = client.get_upload_url(
        filekey=filekey,
        media_type=1,
        to_user_id=to_user_id,
        rawsize=raw_size,
        rawfilemd5=raw_md5,
        filesize=file_size,
        aeskey=aes_key_hex,
        no_need_thumb=True,
    )

    # WeChat returns either upload_full_url (newer, URL is ready-to-use) or
    # upload_param (older, URL must be assembled). upload_full_url takes precedence.
    upload_full_url = (resp.get("upload_full_url") or "").strip()
    upload_param = resp.get("upload_param") or ""
    if upload_full_url:
        cdn_url = upload_full_url
    elif upload_param:
        cdn_url = _build_cdn_upload_url(cdn_base, upload_param, filekey)
    else:
        raise RuntimeError(f"getUploadUrl returned no upload URL: {resp}")

    download_param = _cdn_post_with_retry(cdn_url, ciphertext, image_path, guard=client.connection.check if client.connection else None)

    return {
        "encrypt_query_param": download_param,
        "aes_key": base64.b64encode(aes_key_hex.encode("ascii")).decode("ascii"),
        "mid_size": file_size,
    }


def upload_file(
    client: ILinkClient,
    file_path: str,
    to_user_id: str,
    cdn_base: str = CDN_BASE_URL,
    file_name: str = "",
) -> dict:
    """Upload a local non-image file (doc/pdf/zip/...) to Weixin CDN.

    Mirrors :func:`upload_image` but with ``media_type=FILE`` and returns
    the extra fields the file_item message envelope needs (file_name,
    md5, length).

    Returns a dict with keys needed to construct a file message:
      - encrypt_query_param: CDN download param
      - aes_key: base64-encoded AES key (base64 of the 32-char hex string)
      - mid_size: ciphertext file size
      - file_name: file name to show the receiver
      - md5: lowercase hex MD5 of the plaintext
      - length: plaintext byte length
    """
    with open(file_path, "rb") as f:
        plaintext = f.read()

    raw_size = len(plaintext)
    raw_md5 = hashlib.md5(plaintext).hexdigest()
    aes_key = secrets.token_bytes(16)
    aes_key_hex = aes_key.hex()
    ciphertext = _aes_ecb_encrypt(plaintext, aes_key)
    file_size = len(ciphertext)
    filekey = secrets.token_hex(16)
    file_name = os.path.basename(file_name or file_path) or "file"

    logger.debug(
        "CDN upload (file): file=%s raw=%d cipher=%d md5=%s filekey=%s",
        file_name, raw_size, file_size, raw_md5, filekey,
    )

    resp = client.get_upload_url(
        filekey=filekey,
        media_type=UploadMediaType.FILE,
        to_user_id=to_user_id,
        rawsize=raw_size,
        rawfilemd5=raw_md5,
        filesize=file_size,
        aeskey=aes_key_hex,
        no_need_thumb=True,
    )

    upload_full_url = (resp.get("upload_full_url") or "").strip()
    upload_param = resp.get("upload_param") or ""
    if upload_full_url:
        cdn_url = upload_full_url
    elif upload_param:
        cdn_url = _build_cdn_upload_url(cdn_base, upload_param, filekey)
    else:
        raise RuntimeError(f"getUploadUrl returned no upload URL: {resp}")

    download_param = _cdn_post_with_retry(cdn_url, ciphertext, file_path, guard=client.connection.check if client.connection else None)

    return {
        "encrypt_query_param": download_param,
        "aes_key": base64.b64encode(aes_key_hex.encode("ascii")).decode("ascii"),
        "mid_size": file_size,
        "file_name": file_name,
        "md5": raw_md5,
        "length": raw_size,
    }


def _cdn_post_with_retry(cdn_url: str, data: bytes, label: str, *, guard=None) -> str:
    """POST ciphertext to CDN, return x-encrypted-param header."""
    last_error: Exception | None = None

    for attempt in range(1, UPLOAD_MAX_RETRIES + 1):
        if guard:
            guard()
        try:
            r = requests.post(
                cdn_url,
                data=data,
                headers={"Content-Type": "application/octet-stream"},
                timeout=30,
            )
            if 400 <= r.status_code < 500:
                r.raise_for_status()
            if r.status_code != 200:
                raise RuntimeError(f"CDN server error: status {r.status_code}")

            download_param = r.headers.get("x-encrypted-param", "")
            if not download_param:
                raise RuntimeError("CDN response missing x-encrypted-param header")

            logger.debug("CDN upload success: %s attempt=%d", label, attempt)
            return download_param

        except requests.HTTPError:
            # Only the explicit 4xx branch above raises HTTPError.
            raise
        except (requests.RequestException, RuntimeError) as e:
            last_error = e
            # Network exceptions may contain the signed upload URL.
            detail = type(e).__name__ if isinstance(e, requests.RequestException) else str(e)
            if attempt < UPLOAD_MAX_RETRIES:
                logger.warning("CDN upload attempt %d failed: %s", attempt, detail)
            else:
                logger.error("CDN upload all %d attempts failed: %s", UPLOAD_MAX_RETRIES, detail)

    raise last_error or RuntimeError("CDN upload failed")


# ---------------------------------------------------------------------------
# CDN Download
# ---------------------------------------------------------------------------

_HEX32_RE = re.compile(r"^[0-9a-fA-F]{32}$")


def _parse_aes_key(aes_key_b64: str) -> bytes:
    """Parse a base64-encoded AES key into a raw 16-byte key.

    Two encodings appear in the wild (per openclaw-weixin source):
      - base64(raw 16 bytes)            → images (media.aes_key)
      - base64(hex string of 16 bytes)  → file / voice / video
    """
    decoded = base64.b64decode(aes_key_b64)
    if len(decoded) == 16:
        return decoded
    if len(decoded) == 32 and _HEX32_RE.match(decoded.decode("ascii", errors="ignore")):
        return bytes.fromhex(decoded.decode("ascii"))
    raise ValueError(
        f"aes_key must decode to 16 raw bytes or 32-char hex, got {len(decoded)} bytes"
    )


def _resolve_image_aes_key(image: ImageData) -> str:
    """Return a base64 AES key string from an ImageData, preferring aeskey field.

    ImageData.aeskey is a hex string (e.g. from image_item.aeskey);
    ImageData.media.aes_key is already base64.
    """
    if image.aeskey:
        return base64.b64encode(bytes.fromhex(image.aeskey)).decode("ascii")
    if image.media and image.media.aes_key:
        return image.media.aes_key
    return ""


def download_image(
    image: ImageData,
    cdn_base: str = CDN_BASE_URL,
    max_bytes: int = DEFAULT_IMAGE_DOWNLOAD_MAX_BYTES,
) -> bytes:
    """Download and decrypt an image from WeChat CDN.

    Returns the plaintext image bytes.
    """
    if not image.media:
        raise ValueError("ImageData has no media field")

    aes_key_b64 = _resolve_image_aes_key(image)
    return _download_and_decrypt(
        image.media,
        aes_key_b64,
        "image",
        cdn_base,
        max_bytes=max_bytes,
    )


def download_media(
    media: CDNMedia,
    cdn_base: str = CDN_BASE_URL,
    label: str = "media",
    max_bytes: int = DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES,
) -> bytes:
    """Download and decrypt a generic WeChat CDN media object into memory."""
    if not media.aes_key:
        raise ValueError(f"{label}: missing aes_key")
    return _download_and_decrypt(
        media,
        media.aes_key,
        label,
        cdn_base,
        max_bytes=max_bytes,
    )


def download_media_to_path(
    media: CDNMedia,
    output_path: str | Path,
    cdn_base: str = CDN_BASE_URL,
    label: str = "media",
    max_bytes: int = DEFAULT_MEDIA_DOWNLOAD_MAX_BYTES,
) -> int:
    """Download and decrypt CDN media directly to disk.

    Returns the plaintext file size in bytes.
    """
    if not media.aes_key:
        raise ValueError(f"{label}: missing aes_key")
    return _download_and_decrypt_to_path(
        media,
        media.aes_key,
        label,
        cdn_base,
        output_path,
        max_bytes=max_bytes,
    )


def _download_and_decrypt(
    media: CDNMedia,
    aes_key_b64: str,
    label: str,
    cdn_base: str,
    *,
    max_bytes: int | None = None,
) -> bytes:
    full_url = media.full_url
    encrypt_param = media.encrypt_query_param

    if not full_url and not encrypt_param:
        raise ValueError(f"{label}: has neither full_url nor encrypt_query_param")

    url = full_url or _build_cdn_download_url(cdn_base, encrypt_param)

    logger.debug(
        "CDN download [%s]: url=%s hasAesKey=%s",
        label, url[:80], bool(aes_key_b64),
    )

    ciphertext = _cdn_get_with_retry(url, label, max_bytes=max_bytes)

    if aes_key_b64:
        key = _parse_aes_key(aes_key_b64)
        plaintext = _aes_ecb_decrypt(ciphertext, key)
        logger.debug(
            "CDN decrypt [%s]: cipher=%d → plain=%d bytes",
            label, len(ciphertext), len(plaintext),
        )
        return plaintext

    return ciphertext


def _download_and_decrypt_to_path(
    media: CDNMedia,
    aes_key_b64: str,
    label: str,
    cdn_base: str,
    output_path: str | Path,
    *,
    max_bytes: int | None = None,
) -> int:
    full_url = media.full_url
    encrypt_param = media.encrypt_query_param

    if not full_url and not encrypt_param:
        raise ValueError(f"{label}: has neither full_url nor encrypt_query_param")

    url = full_url or _build_cdn_download_url(cdn_base, encrypt_param)
    key = _parse_aes_key(aes_key_b64)
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    cipher_tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.cipher.tmp")
    plain_tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")

    try:
        cipher_size = _cdn_get_to_path_with_retry(
            url,
            label,
            cipher_tmp,
            max_bytes=max_bytes,
        )
        plain_size = _aes_ecb_decrypt_file(cipher_tmp, plain_tmp, key)
        os.replace(plain_tmp, target)
        logger.debug(
            "CDN decrypt-to-file [%s]: cipher=%d → plain=%d path=%s",
            label, cipher_size, plain_size, target.name,
        )
        return plain_size
    finally:
        for tmp_path in (cipher_tmp, plain_tmp):
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                logger.debug("CDN temp cleanup failed: %s", tmp_path, exc_info=True)


def _aes_ecb_decrypt_file(
    ciphertext_path: Path,
    plaintext_path: Path,
    key: bytes,
) -> int:
    """Decrypt an AES-128-ECB file to disk while keeping memory bounded."""
    cipher = AES.new(key, AES.MODE_ECB)
    pending = b""
    tail = b""
    written = 0

    with ciphertext_path.open("rb") as src, plaintext_path.open("wb") as dst:
        while True:
            chunk = src.read(DOWNLOAD_CHUNK_SIZE)
            if not chunk:
                break
            pending += chunk
            process_len = (len(pending) // 16) * 16
            if process_len == 0:
                continue

            plain = cipher.decrypt(pending[:process_len])
            pending = pending[process_len:]
            combined = tail + plain
            if len(combined) <= 16:
                tail = combined
                continue

            dst.write(combined[:-16])
            written += len(combined) - 16
            tail = combined[-16:]

        if pending:
            raise ValueError("ciphertext size is not a multiple of 16 bytes")

        final = _strip_pkcs7_padding(tail)
        dst.write(final)
        written += len(final)

    return written


def _cdn_get_with_retry(
    url: str,
    label: str,
    *,
    max_bytes: int | None = None,
) -> bytes:
    """GET ciphertext from CDN with retries."""
    last_error: Exception | None = None

    for attempt in range(1, DOWNLOAD_MAX_RETRIES + 1):
        try:
            with requests.get(url, timeout=30, stream=True) as r:
                if 400 <= r.status_code < 500:
                    raise RuntimeError(f"CDN client error {r.status_code}: {r.text[:200]}")
                if r.status_code != 200:
                    raise RuntimeError(f"CDN server error: status {r.status_code}")

                declared_size = _declared_download_size(r.headers.get("Content-Length"))
                _ensure_download_size_within_limit(declared_size, max_bytes, label)

                chunks: list[bytes] = []
                total = 0
                for chunk in r.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                    if not chunk:
                        continue
                    total += len(chunk)
                    _ensure_download_size_within_limit(total, max_bytes, label)
                    chunks.append(chunk)

            payload = b"".join(chunks)
            logger.debug(
                "CDN download success: %s attempt=%d size=%d",
                label, attempt, len(payload),
            )
            return payload

        except Exception as e:
            last_error = e
            if isinstance(e, ValueError):
                raise
            if isinstance(e, RuntimeError) and "client error" in str(e):
                raise
            if attempt < DOWNLOAD_MAX_RETRIES:
                logger.warning("CDN download attempt %d failed: %s", attempt, e)
            else:
                logger.error("CDN download all %d attempts failed: %s", DOWNLOAD_MAX_RETRIES, e)

    raise last_error or RuntimeError("CDN download failed")


def _cdn_get_to_path_with_retry(
    url: str,
    label: str,
    dest_path: Path,
    *,
    max_bytes: int | None = None,
) -> int:
    """GET ciphertext from CDN directly to disk with retries."""
    last_error: Exception | None = None

    for attempt in range(1, DOWNLOAD_MAX_RETRIES + 1):
        try:
            with requests.get(url, timeout=30, stream=True) as r:
                if 400 <= r.status_code < 500:
                    raise RuntimeError(f"CDN client error {r.status_code}: {r.text[:200]}")
                if r.status_code != 200:
                    raise RuntimeError(f"CDN server error: status {r.status_code}")

                declared_size = _declared_download_size(r.headers.get("Content-Length"))
                _ensure_download_size_within_limit(declared_size, max_bytes, label)

                total = 0
                with dest_path.open("wb") as f:
                    for chunk in r.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                        if not chunk:
                            continue
                        total += len(chunk)
                        _ensure_download_size_within_limit(total, max_bytes, label)
                        f.write(chunk)

            logger.debug(
                "CDN download success: %s attempt=%d size=%d path=%s",
                label, attempt, total, dest_path.name,
            )
            return total

        except Exception as e:
            last_error = e
            try:
                if dest_path.exists():
                    dest_path.unlink()
            except OSError:
                logger.debug("Failed to clean partial CDN file: %s", dest_path, exc_info=True)
            if isinstance(e, ValueError):
                raise
            if isinstance(e, RuntimeError) and "client error" in str(e):
                raise
            if attempt < DOWNLOAD_MAX_RETRIES:
                logger.warning("CDN download attempt %d failed: %s", attempt, e)
            else:
                logger.error("CDN download all %d attempts failed: %s", DOWNLOAD_MAX_RETRIES, e)

    raise last_error or RuntimeError("CDN download failed")


def _declared_download_size(raw_value: str | None) -> int | None:
    if not raw_value:
        return None
    try:
        size = int(raw_value)
    except (TypeError, ValueError):
        return None
    return size if size >= 0 else None


def _ensure_download_size_within_limit(
    size: int | None,
    max_bytes: int | None,
    label: str,
) -> None:
    if size is None or max_bytes is None:
        return
    if size > max_bytes:
        raise ValueError(
            f"{label}: download size {size} exceeds limit {max_bytes} bytes",
        )
