/*!
 * PawzoChat - Human-like, versatile, extensible AI companion engine
 * Copyright (C) 2026  iwyxdxl
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Offsets use UTF-16 code units, like textarea.selectionStart/selectionEnd.
// The separating space is plain text; it never belongs to a mention range.
export const MENTION_ALL_ID = "@all";

const EMAIL_LOCAL_CHAR = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~\-]/;
const NAME_END = /[\s\p{P}$+<=>^`|~]/u;

function canStartMention(text, at, previousMentionEnd) {
  if (at === previousMentionEnd || at === 0) return true;
  if (EMAIL_LOCAL_CHAR.test(text[at - 1])) return false;
  // A display name appearing in an address/path is ordinary text. The
  // token check also covers URL fragments preceded by punctuation, e.g. #@.
  const token = text.slice(0, at).split(/\s/u).pop();
  return !/(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|[<(])(?:mailto:|www\.))/i.test(token);
}

function canEndMention(text, end) {
  if (end === text.length) return true;
  const next = String.fromCodePoint(text.codePointAt(end));
  // Underscores and emoji can be part of a name; never match a shorter
  // prefix of one. A final full stop is punctuation, but .com is an address.
  if (next === "_" || !NAME_END.test(next)) return false;
  return !/^(?:\.[a-zA-Z0-9-]|[\/\\][^\s]|:\d)/u.test(text.slice(end));
}

export class ChatMentions {
  constructor() {
    this.reset();
  }

  reset(text = "") {
    this._text = text;
    this._ranges = [];
  }

  // Optional edit is the old replacement range, or a beforeinput snapshot:
  // { start: selectionStart, end: selectionEnd, inputType: event.inputType }.
  // It disambiguates deleting one of two identical adjacent mention labels.
  sync(text, edit = null) {
    const previous = this._text;
    let change = this._hintedChange(previous, text, edit);
    let ambiguous = null;
    if (!change) {
      if (text === previous) return;
      let prefix = 0;
      const shorter = Math.min(previous.length, text.length);
      while (prefix < shorter && previous[prefix] === text[prefix]) prefix++;
      let suffix = 0;
      while (suffix < shorter && previous[previous.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
      // Repeated identical text can describe several different edits. Without
      // a selection snapshot, forget affected identities rather than attach
      // the wrong ID to an indistinguishable remaining label.
      if (prefix + suffix > shorter) {
        ambiguous = { start: shorter - suffix, end: prefix + Math.max(0, previous.length - text.length) };
      }
      const preservedSuffix = Math.min(suffix, shorter - prefix);
      change = { start: prefix, end: previous.length - preservedSuffix };
    }

    const delta = text.length - previous.length;
    const ranges = [];
    for (const range of this._ranges) {
      if (ambiguous && range.start < ambiguous.end && range.end > ambiguous.start) continue;
      let next;
      if (change.end <= range.start) {
        next = { ...range, start: range.start + delta, end: range.end + delta };
      } else if (change.start >= range.end) {
        next = range;
      } else {
        // Insertion strictly inside, or replacement of any token character,
        // cancels its explicit identity. A complete current name can still
        // be recognized as a new plain-text mention when the message is sent.
        continue;
      }
      if (text.slice(next.start, next.end) === next.token) ranges.push(next);
    }
    this._ranges = ranges;
    this._text = text;
  }

  insert(text, start, end, personaId, name) {
    if (typeof personaId !== "string" || !personaId || typeof name !== "string" || !name) {
      throw new TypeError("A mention requires a persona ID and display name");
    }
    this.sync(text);
    start = Number.isInteger(start) ? Math.max(0, Math.min(start, text.length)) : text.length;
    end = Number.isInteger(end) ? Math.max(0, Math.min(end, text.length)) : start;
    if (end < start) [start, end] = [end, start];
    const token = `@${name}`;
    const nextText = text.slice(0, start) + token + " " + text.slice(end);
    this.sync(nextText, { start, end });
    this._ranges.push({ start, end: start + token.length, token, personaId });
    this._ranges.sort((a, b) => a.start - b.start);
    return { text: nextText, caret: start + token.length + 1 };
  }

  ids(text = this._text, members = null) {
    this.sync(text);
    // Keep the original range-only API for callers that have no member list.
    // An explicit empty list, however, represents a group with no recipients.
    if (members === null) {
      return [...new Set(this._ranges.map(range => range.personaId).filter(id => id !== MENTION_ALL_ID))];
    }
    const memberIds = new Set();
    const names = new Map();
    for (const member of members) {
      if (typeof member?.id !== "string" || !member.id || member.id === MENTION_ALL_ID) continue;
      memberIds.add(member.id);
      if (typeof member.name !== "string" || !member.name || member.name === "所有人") continue;
      if (!names.has(member.name)) names.set(member.name, new Set());
      names.get(member.name).add(member.id);
    }
    const candidates = [{ name: "所有人", id: MENTION_ALL_ID }];
    for (const [name, ids] of names) {
      // A typed display name cannot identify one of several same-name people.
      // Still consume its full label so a shorter name cannot steal its prefix.
      candidates.push({ name, id: ids.size === 1 ? ids.values().next().value : null });
    }
    candidates.sort((a, b) => b.name.length - a.name.length);

    const ids = new Set();
    const add = id => {
      if (id === MENTION_ALL_ID) {
        for (const memberId of memberIds) ids.add(memberId);
      } else if (memberIds.has(id)) {
        ids.add(id);
      }
    };
    const explicit = new Map(this._ranges.map(range => [range.start, range]));
    let previousMentionEnd = -1;
    for (let at = 0; at < text.length;) {
      const range = explicit.get(at);
      if (range) {
        // The chosen identity wins even after renaming/removal. In particular,
        // never rebind a removed member's old label to someone with that name.
        add(range.personaId);
        previousMentionEnd = range.end;
        at = range.end;
        continue;
      }
      if (text[at] !== "@" || !canStartMention(text, at, previousMentionEnd)) {
        at++;
        continue;
      }
      let match = null;
      for (const candidate of candidates) {
        const end = at + candidate.name.length + 1;
        if (!text.startsWith(candidate.name, at + 1) || !canEndMention(text, end)) continue;
        if (this._ranges.some(item => item.start < end && item.end > at)) continue;
        match = { ...candidate, end };
        break;
      }
      if (match) {
        add(match.id);
        previousMentionEnd = match.end;
        at = match.end;
      } else {
        at++;
      }
    }
    return [...ids];
  }

  // Read-only completion query. Call sync after text edits before asking for
  // suggestions; querying the picker never creates a persistent identity.
  suggestion(text, start, end = start) {
    if (typeof text !== "string" || !Number.isInteger(start)
        || start !== end || start < 1 || start > text.length) return null;
    const at = text.lastIndexOf("@", start - 1);
    if (at < 0) return null;
    // This also excludes the end of an already confirmed token and names
    // containing an @ themselves, even when the caret moves back into them.
    if (this._ranges.some(range => at >= range.start && at < range.end)) return null;
    // Do not open a picker in an email local part. Chinese text and emoji
    // immediately before an @ are still valid conversation prefixes.
    if (at > 0 && /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~\-]/.test(text[at - 1])) return null;
    const query = text.slice(at + 1, start);
    // Whitespace lets people continue ordinary text without choosing anyone;
    // address/URL punctuation similarly ends a possible name query.
    if (/[\s@./:\\?#=&<>]/u.test(query)) return null;
    return { start: at, end: start, query };
  }

  _hintedChange(previous, text, edit) {
    if (!edit || !Number.isInteger(edit.start) || !Number.isInteger(edit.end)) return null;
    let { start, end } = edit;
    if (start < 0 || end < start || end > previous.length) return null;
    if (start === end && text.length < previous.length) {
      const removed = previous.length - text.length;
      if (/^delete.*Backward$/.test(edit.inputType || "")) start -= removed;
      else if (/^delete.*Forward$/.test(edit.inputType || "")) end += removed;
    }
    const inserted = text.length - previous.length + end - start;
    if (start < 0 || end > previous.length || inserted < 0) return null;
    if (previous.slice(0, start) !== text.slice(0, start)
        || previous.slice(end) !== text.slice(start + inserted)) return null;
    return { start, end };
  }
}
