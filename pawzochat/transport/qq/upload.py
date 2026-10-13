"""QQ SDK 1.0.4 compatible C2C small-file and chunked upload.

Protocol reference: @tencent-connect/qqbot-nodejs src/protocol/api/media-chunked.ts.
No public URL fallback and no cross-process upload resumption.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlsplit

import requests

from pawzochat.transport.qq.client import QQClientError, _sanitize_file_name

logger = logging.getLogger(__name__)
MIB = 1024 * 1024
CHUNK_THRESHOLD = 5 * MIB
MD5_10M_SIZE = 10_002_432
MAX_SIZES = {1: 30 * MIB, 2: 100 * MIB, 3: 20 * MIB, 4: 100 * MIB}


class MediaSource:
    def __init__(self, source):
        self.path = Path(source) if isinstance(source, (str, Path)) else None
        self.data = None if self.path else source
        if self.data is not None and not isinstance(self.data, bytes):
            raise QQClientError("上传源必须是文件路径或 bytes")
        try:
            self.size = self.path.stat().st_size if self.path else len(self.data)
            self.signature = self.path.stat().st_mtime_ns if self.path else None
        except OSError as exc:
            raise QQClientError("媒体文件不可读") from exc

    def open(self):
        try:
            if self.path:
                stat = self.path.stat()
                if stat.st_size != self.size or stat.st_mtime_ns != self.signature:
                    raise QQClientError("上传期间文件已修改，请重试")
                return self.path.open('rb')
            return io.BytesIO(self.data)
        except OSError as exc:
            raise QQClientError("媒体文件不可读") from exc

    def hashes(self, check):
        md5, sha1, head = hashlib.md5(), hashlib.sha1(), hashlib.md5()
        consumed = 0
        with self.open() as stream:
            while True:
                check()
                chunk = stream.read(MIB)
                if not chunk:
                    break
                if consumed + len(chunk) > self.size:
                    raise QQClientError("上传期间文件大小改变")
                md5.update(chunk)
                sha1.update(chunk)
                if consumed < MD5_10M_SIZE:
                    head.update(chunk[:MD5_10M_SIZE - consumed])
                consumed += len(chunk)
        if consumed != self.size:
            raise QQClientError("上传期间文件大小改变")
        return {'md5': md5.hexdigest(), 'sha1': sha1.hexdigest(), 'md5_10m': head.hexdigest()}


class RichMediaUploader:
    def __init__(self, client, openid, *, file_type, file_name='', on_progress=None):
        self.client, self.openid = client, openid
        self.file_type, self.file_name = file_type, file_name
        self.on_progress = on_progress
        self.cancelled = threading.Event()

    def check(self):
        self.client.check_open()
        if self.cancelled.is_set():
            raise QQClientError("媒体上传已取消")

    def wait(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.check()
            self.cancelled.wait(min(.1, max(0, deadline - time.monotonic())))

    def retry(self, fn, *, pending_timeout=None):
        failures = 0
        deadline = None
        while True:
            self.check()
            try:
                return fn()
            except QQClientError as exc:
                if exc.biz_code == 40093001 and pending_timeout is not None:
                    if deadline is None:
                        deadline = time.monotonic() + pending_timeout
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise QQClientError("QQ 分片确认超时", biz_code=exc.biz_code) from exc
                    self.wait(min(1, remaining))
                elif exc.retryable and failures < 2:
                    self.wait(2 ** failures)
                    failures += 1
                else:
                    raise

    def post(self, suffix, payload):
        self.check()
        return self.client.api_post(f'/v2/users/{self.openid}/{suffix}', payload, timeout=120)

    def upload(self, source):
        try:
            return self._upload(source)
        except OSError as exc:
            self.cancelled.set()
            raise QQClientError("媒体文件读取失败，请检查文件后重试") from exc

    def _upload(self, source):
        src = MediaSource(source)
        maximum = MAX_SIZES.get(self.file_type)
        if maximum is None:
            raise QQClientError("不支持的 QQ 媒体类型")
        if src.size <= 0 or src.size > maximum:
            raise QQClientError(f"QQ 媒体大小必须在 1 字节至 {maximum // MIB} MiB 之间")
        self.check()
        name = self.file_name or (src.path.name if src.path else 'media')
        if self.file_type == 4:
            name = _sanitize_file_name(name)
        if src.size < CHUNK_THRESHOLD:
            with src.open() as stream:
                data = stream.read(src.size + 1)
            if len(data) != src.size:
                raise QQClientError("上传期间文件大小改变")
            payload = {'file_type': self.file_type, 'srv_send_msg': False,
                       'file_data': base64.b64encode(data).decode('ascii')}
            if self.file_type == 4:
                payload['file_name'] = name
            return self._result(self.retry(lambda: self.post('files', payload)))

        hashes = src.hashes(self.check)
        prepared = self.retry(lambda: self.post('upload_prepare', {
            'file_type': self.file_type, 'file_name': name, 'file_size': src.size, **hashes,
        }))
        try:
            upload_id = prepared['upload_id']
            block_size = prepared['block_size']
            parts = prepared['parts']
            if not upload_id or type(block_size) is not int or not 0 < block_size <= MAX_SIZES[self.file_type]:
                raise ValueError('invalid block size')
            count = math.ceil(src.size / block_size)
            if not isinstance(parts, list) or len(parts) != count:
                raise ValueError('incomplete parts')
            indices = [p['index'] for p in parts]
            if any(type(index) is not int for index in indices) or any(
                index != expected for expected, index in enumerate(sorted(indices), 1)
            ):
                raise ValueError('incomplete or duplicate parts')
            for part in parts:
                url = urlsplit(part['presigned_url'])
                if url.scheme != 'https' or not url.hostname or url.username or url.password:
                    raise ValueError('invalid signed URL')
            concurrency = max(1, min(4, int(prepared.get('concurrency') or 1)))
            confirm_timeout = max(1, min(600, float(prepared.get('retry_timeout') or 120)))
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise QQClientError("QQ 分片准备响应不完整") from exc

        logger.info("QQ 分片上传: %s (%d bytes, %d parts)", name, src.size, len(parts))
        completed = 0
        progress_lock = threading.Lock()

        def upload_part(part):
            nonlocal completed
            self.check()
            offset = (part['index'] - 1) * block_size
            length = min(block_size, src.size - offset)
            with src.open() as stream:
                stream.seek(offset)
                data = stream.read(length)
            if len(data) != length:
                raise QQClientError("上传期间文件大小改变")
            digest = hashlib.md5(data).hexdigest()
            self.retry(lambda: self.put(part['presigned_url'], data))
            self.retry(lambda: self.post('upload_part_finish', {
                'upload_id': upload_id, 'part_index': part['index'], 'block_size': length, 'md5': digest,
            }), pending_timeout=confirm_timeout)
            with progress_lock:
                completed += length
                logger.info("QQ 上传进度: %s %d/%d bytes", name, completed, src.size)
                if self.on_progress:
                    try:
                        self.on_progress(completed, src.size)
                    except Exception:
                        logger.debug("上传进度通知失败", exc_info=True)

        pool = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix='qq-upload')
        try:
            jobs = [pool.submit(upload_part, part) for part in parts]
            for job in as_completed(jobs):
                job.result()
            self.check()
            return self._result(self.retry(lambda: self.post('files', {'upload_id': upload_id})))
        except Exception:
            self.cancelled.set()
            raise
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

    def put(self, url, data):
        self.check()
        try:
            # Signed COS requests must not carry the QQ API bearer token.
            with requests.put(url, data=data, headers={'Content-Length': str(len(data))},
                              timeout=300, allow_redirects=False) as response:
                if not 200 <= response.status_code < 300:
                    raise QQClientError(f"QQ 分片上传失败 HTTP {response.status_code}",
                                        retryable=response.status_code >= 500)
        except requests.RequestException:
            raise QQClientError("QQ 分片上传网络错误", retryable=True) from None

    @staticmethod
    def _result(result):
        if not result.get('file_info'):
            raise QQClientError("QQ 上传响应缺少 file_info")
        return result
