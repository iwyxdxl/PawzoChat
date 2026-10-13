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

"""Split an LLM reply into individual message segments."""

from __future__ import annotations

import re
from dataclasses import dataclass

# Emotion enum for the [语音-<emotion>] marker (consumed by MiniMax T2A —
# natively or through an OpenAI-compatible relay's metadata extension).
VOICE_EMOTIONS: tuple[str, ...] = (
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral",
)

# [语音]/[voice] marker with an optional -emotion suffix. Tolerates fullwidth
# brackets, in-marker spaces and long-dash variants (models frequently emit
# them under temperature sampling; paired dashes like [——]/[--] are accepted).
# Three hard constraints on the emotion capture:
# - Must not be letters-only: an invalid emotion such as [语音-开心] must still
#   match as a marker (emotion cleared, synthesis proceeds), otherwise the whole
#   marker degrades to plain text;
# - Must exclude whitespace and be length-capped: allowing whitespace/unbounded
#   capture makes "[语音-" + a long whitespace run backtrack catastrophically
#   (measured O(n^3)), and malformed markers like [语音-happy 正文] would
#   swallow body text into the emotion and silently delete it — such malformed
#   shapes should fail to match entirely and fall back to plain text;
# - Only spaces/tabs inside the marker, every quantifier with a small constant
#   bound: unbounded quantifiers, even non-overlapping ones, still leave O(n^2)
#   backtracking room on long whitespace runs.
_VOICE_MARKER_RE = re.compile(
    r"[\[【][ \t]{0,4}(?:语音|voice)[ \t]{0,4}"
    r"(?:[-—–－]{1,4}[ \t]{0,4}(?P<emotion>[^\]】\s]{0,16})[ \t]{0,4})?[\]】]",
    re.IGNORECASE,
)


@dataclass
class ReplySegment:
    """Product of ``parse_voice_reply``: a text or voice run, in written order."""

    kind: str            # "text" | "voice"
    raw: str             # original text (marker excluded for voice runs;
                         # the degrade path feeds it back through split_reply)
    tts_text: str = ""   # voice runs only: separators already turned into
                         # Chinese commas, ready for TTS
    emotion: str = ""    # voice runs only: validated emotion, "" when
                         # invalid/unspecified


def split_reply(text: str, *, split_newline: bool = True) -> list[str]:
    """Split *text* on ``$``, ``\\`` and optionally newlines.

    Returns a list of non-empty stripped strings.
    """
    if not text:
        return []

    if split_newline:
        parts = re.split(r"[\\$\n]", text)
    else:
        parts = re.split(r"[\\$]", text)

    return [p.strip() for p in parts if p.strip()]


def parse_voice_reply(text: str, *, split_newline: bool = True) -> list[ReplySegment]:
    """Cut a reply into an ordered list of text/voice runs by [语音]/[voice] markers.

    Voice content extends from its marker to the next voice marker or the end
    of the text; message separators inside it (``\\``, ``$``, optionally
    newlines) become Chinese commas, with leading/trailing separators dropped.
    Text without markers yields a single text run; blank input yields [].
    """
    if not text or not text.strip():
        return []

    matches = list(_VOICE_MARKER_RE.finditer(text))
    if not matches:
        return [ReplySegment(kind="text", raw=text)]

    segments: list[ReplySegment] = []
    head = text[: matches[0].start()]
    if head.strip():
        segments.append(ReplySegment(kind="text", raw=head))

    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        raw = text[m.end(): end]
        # Reuse split_reply: separators become commas, and consecutive or
        # leading/trailing separators filter out naturally.
        tts_text = "，".join(split_reply(raw, split_newline=split_newline))
        if not tts_text:
            continue  # empty voice run (marker right before another marker/end)
        emotion = (m.group("emotion") or "").strip().lower()
        if emotion not in VOICE_EMOTIONS:
            emotion = ""  # invalid emotion is ignored; synthesis proceeds
        segments.append(ReplySegment(
            kind="voice", raw=raw.strip(), tts_text=tts_text, emotion=emotion,
        ))
    return segments


def strip_voice_markers(text: str, *, preserve_boundaries: bool = False) -> str:
    """Strip [语音]/[voice] markers themselves, keeping the content after them.

    For text-only flows such as Moments: they have no voice pipeline, so if
    the model leaks a marker, only the marker is removed and the content is
    published as regular text. preserve_boundaries separates adjacent text
    for group mention matching.
    """
    return _VOICE_MARKER_RE.sub(" " if preserve_boundaries else "", text) if text else text


def contains_voice_marker(text: str) -> bool:
    """Whether the text contains a [语音]/[voice] marker (history-merge separator choice)."""
    return bool(text) and _VOICE_MARKER_RE.search(text) is not None
