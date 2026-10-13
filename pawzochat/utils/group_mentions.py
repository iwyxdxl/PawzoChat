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

"""Resolve visible role mentions using the same name boundaries as the composer."""
from __future__ import annotations

import re
import unicodedata


_EMAIL_LOCAL_CHAR = re.compile(r"[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~\-]")
_URL_START = re.compile(r"(?:[a-z][a-z0-9+.-]*://|(?:^|[<(])(?:mailto:|www\.))", re.I)
_ADDRESS_SUFFIX = re.compile(r"(?:\.[a-zA-Z0-9-]|[/\\][^\s]|:\d)")


def _can_start(text, at, previous_end):
    if at == 0 or at == previous_end:
        return True
    if _EMAIL_LOCAL_CHAR.fullmatch(text[at - 1]):
        return False
    return not _URL_START.search(re.split(r"\s", text[:at])[-1])


def _can_end(text, end):
    if end == len(text):
        return True
    following = text[end]
    if following == "_" or not (following.isspace()
            or unicodedata.category(following).startswith("P") or following in "$+<=>^`|~"):
        return False
    return not _ADDRESS_SUFFIX.match(text[end:])


def annotate_reply_mentions(messages, member_names, *, speaker_id, user_name, seen=None):
    """Annotate a whole reply and turn repeated text mentions into plain names.

    Only visible text/voice transcripts count. User names, ambiguous names,
    self mentions and @所有人 remain ordinary text. Keep voice transcripts
    intact since their audio has already been synthesized. Pass a shared
    ``seen`` set when normalizing successive text runs before synthesis.
    """
    names = {"所有人": {None}, user_name: {None}}
    for persona_id, name in member_names.items():
        if isinstance(name, str) and name:
            names.setdefault(name, set()).add(persona_id)
    candidates = sorted(names, key=len, reverse=True)
    if seen is None:
        seen = set()
    for message in messages:
        mentions = []
        for block in message["content"]:
            text = block.get("text")
            if block.get("type") not in {"text", "voice"} or not isinstance(text, str):
                continue
            at, previous_end = 0, -1
            previous_repeated = False
            replacements = []
            while at < len(text):
                if text[at] != "@" or not _can_start(text, at, previous_end):
                    at += 1
                    continue
                for name in candidates:
                    end = at + len(name) + 1
                    if not text.startswith(name, at + 1) or not _can_end(text, end):
                        continue
                    identities = names[name]
                    target = next(iter(identities)) if len(identities) == 1 else None
                    adjacent = at == previous_end
                    repeated = False
                    if target is not None and target != speaker_id:
                        if target not in seen:
                            seen.add(target)
                            mentions.append(target)
                        elif block["type"] == "text":
                            repeated = True
                    if block["type"] == "text":
                        if repeated:
                            # Removing @ from adjacent names must not merge
                            # them: @B@B@C becomes @B B @C, not @BB@C.
                            replacements.append((at, " " if adjacent else ""))
                        elif adjacent and previous_repeated:
                            replacements.append((at, " @"))
                    previous_repeated = repeated
                    at = previous_end = end
                    break
                else:
                    at += 1
            if replacements:
                parts, start = [], 0
                for index, replacement in replacements:
                    parts.extend((text[start:index], replacement))
                    start = index + 1
                parts.append(text[start:])
                block["text"] = "".join(parts)
        if mentions:
            message["mentions"] = mentions
