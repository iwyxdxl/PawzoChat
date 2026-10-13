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

"""Server-Sent Events broadcast for real-time frontend updates."""

from __future__ import annotations

import json
import queue
import threading

MAX_SSE_CLIENTS = 20
_LOCAL_PLUGIN_EVENTS = frozenset({"plugin_task_progress", "plugin_updates_available"})

_clients: list[queue.Queue] = []
_clients_lock = threading.Lock()


def sse_stream(*, is_public: bool = False):
    """Generator for the SSE endpoint — yields ``data: …\\n\\n`` lines."""
    with _clients_lock:
        if len(_clients) >= MAX_SSE_CLIENTS:
            err = json.dumps({"type": "error", "message": "too_many_connections"})
            yield f"data: {err}\n\n"
            return

    q: queue.Queue = queue.Queue(maxsize=100)
    with _clients_lock:
        _clients.append(q)
    try:
        while True:
            data = q.get()
            if is_public and json.loads(data).get("type") in _LOCAL_PLUGIN_EVENTS:
                continue
            yield f"data: {data}\n\n"
    finally:
        with _clients_lock:
            _clients.remove(q)


def broadcast(event_type: str, **payload):
    """Push an event to every connected SSE client."""
    message = json.dumps({"type": event_type, **payload}, ensure_ascii=False)
    with _clients_lock:
        for q in list(_clients):
            try:
                q.put_nowait(message)
            except queue.Full:
                pass
