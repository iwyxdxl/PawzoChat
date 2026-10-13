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

import { avatarHtml, personaAvatarUrl, iconHtml, esc, escAttr } from './utils.js';
import { MENTION_ALL_ID } from './chat_mentions.js';

// The textarea keeps focus throughout selection, including on touch screens.
// Selecting a suggestion preserves its exact identity; sending also resolves
// complete, unambiguous mention names typed directly into the composer.
export class ChatMentionPicker {
  constructor({ input, getQuery, getMembers, onSelect }) {
    Object.assign(this, { input, getQuery, getMembers, onSelect });
    this.element = null;
    this.query = null;
    this.members = [];
    this.active = -1;
    this.dismissed = null;
    this.composing = false;
    this.frame = null;
    this.listeners = [];
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this.listeners.push(() => target.removeEventListener(type, handler, options));
    };
    listen(input, 'click', () => this.update());
    listen(input, 'keyup', () => this.update());
    listen(input, 'select', () => this.update());
    listen(input, 'focus', () => this.update());
    listen(input, 'blur', () => this.dismiss());
    listen(input, 'beforeinput', event => {
      if (!this.dismissed) return;
      const at = this.dismissed.length - 1;
      const start = input.selectionStart, end = input.selectionEnd;
      if ((start <= at && end > at) || (start === at && event.data?.includes('@'))) this.dismissed = null;
    });
    listen(input, 'compositionstart', () => { this.composing = true; this.close(); });
    listen(input, 'compositionend', () => {
      this.composing = false;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.update(); });
    });
    listen(document, 'pointerdown', event => {
      if (event.target !== input && !this.element?.contains(event.target)) this.dismiss();
    }, true);
    listen(window, 'resize', () => this.position());
    listen(window, 'scroll', () => this.position(), true);
    if (window.visualViewport) {
      listen(window.visualViewport, 'resize', () => this.position());
      listen(window.visualViewport, 'scroll', () => this.position());
    }
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
  }

  update() {
    if (!this.input.isConnected || document.activeElement !== this.input || this.composing) {
      this.close();
      return;
    }
    // WebKit can report a temporary caret of 0 during focus. Dismissing an @
    // survives caret changes; only editing its prefix or starting a new @ resets it.
    if (this.dismissed && !this.input.value.startsWith(this.dismissed)) this.dismissed = null;
    const query = this.getQuery();
    if (!query) { this.close(); return; }
    const anchor = this.input.value.slice(0, query.start + 1);
    if (this.dismissed === anchor) { this.close(); return; }
    this.dismissed = null;
    const allMembers = this.getMembers();
    const filter = query.query.toLocaleLowerCase();
    const candidates = allMembers.length ? [{ id: MENTION_ALL_ID, name: '所有人' }, ...allMembers] : [];
    const members = candidates.filter(persona => persona.name.toLocaleLowerCase().includes(filter)
      || (persona.id !== MENTION_ALL_ID && persona.id.toLocaleLowerCase().includes(filter)));
    if (!members.length) { this.close(); return; }
    const key = JSON.stringify([query, members.map(persona => [persona.id, persona.name, persona.has_avatar])]);
    if (this.element && this.key === key) { this.position(); return; }
    this.close();
    this.key = key;
    this.query = query;
    this.members = members;
    const element = this.element = document.createElement('div');
    element.className = 'moments-actions-pop chat-mention-picker';
    element.id = 'chat-mention-picker';
    element.setAttribute('role', 'listbox');
    element.setAttribute('aria-label', '选择要提及的群成员');
    element.innerHTML = members.map((persona, index) => {
      const mentionAll = persona.id === MENTION_ALL_ID;
      const duplicate = !mentionAll && (persona.name === '所有人'
        || allMembers.some(other => other.id !== persona.id && other.name === persona.name));
      const label = `${persona.name}${duplicate ? ` · ${persona.id}` : ''}`;
      const avatar = mentionAll
        ? `<span class="avatar sm chat-mention-all-avatar" aria-hidden="true">${iconHtml('ri-group-line')}</span>`
        : avatarHtml(persona.name, 'sm', personaAvatarUrl(persona));
      return `<button type="button" class="map-btn chat-mention-option" role="option" tabindex="-1" id="chat-mention-option-${index}" data-persona-id="${escAttr(persona.id)}" aria-label="${escAttr(label)}" aria-selected="false">
        ${avatar}<span class="chat-mention-label"><span class="chat-mention-name">${esc(persona.name)}</span>${duplicate ? `<small>${esc(persona.id)}</small>` : ''}</span>
      </button>`;
    }).join('');
    let press = null;
    element.addEventListener('pointerdown', event => {
      // Cancel compatibility mousedown focus, while touch-action keeps vertical
      // scrolling available. A scrolling gesture won't produce a choice click.
      const option = event.target.closest('[role="option"]');
      if (!option) return;
      event.preventDefault();
      press = event.isPrimary === false ? null : {
        option, pointerId: event.pointerId, type: event.pointerType,
        x: event.clientX, y: event.clientY,
      };
    });
    element.addEventListener('pointermove', event => {
      if (press && (Math.abs(event.clientX - press.x) > 10 || Math.abs(event.clientY - press.y) > 10)) press = null;
    });
    element.addEventListener('pointercancel', () => { press = null; });
    element.addEventListener('scroll', () => { press = null; }, { passive: true });
    element.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) press = null;
    }, { passive: true });
    element.addEventListener('touchend', event => {
      const choice = press;
      press = null;
      if (!choice || choice.type !== 'touch' || event.touches.length || this.element !== element) return;
      const touch = event.changedTouches[0], rect = choice.option.getBoundingClientRect();
      if (!touch || touch.clientX < rect.left || touch.clientX > rect.right
          || touch.clientY < rect.top || touch.clientY > rect.bottom) return;
      // Safari suppresses click when pointerdown is cancelled. Commit a tap at
      // touchend and suppress compatibility clicks so Chromium commits it once.
      event.preventDefault();
      this.choose(choice.option.dataset.personaId);
    }, { passive: false });
    element.addEventListener('pointerup', event => {
      if (press?.type !== 'pen' || press.pointerId !== event.pointerId || this.element !== element) return;
      event.preventDefault();
      const choice = press;
      press = null;
      this.choose(choice.option.dataset.personaId);
    });
    element.addEventListener('mousedown', event => event.preventDefault());
    element.addEventListener('click', event => {
      const option = event.target.closest('[data-persona-id]');
      if (option && this.element === element) this.choose(option.dataset.personaId);
    });
    document.body.appendChild(element);
    this.input.setAttribute('aria-controls', element.id);
    this.input.setAttribute('aria-expanded', 'true');
    this.position();
  }

  position() {
    const element = this.element;
    if (!element || !this.input.isConnected) return;
    const rect = this.input.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8;
    const top = (viewport?.offsetTop || 0) + 8;
    const right = left + (viewport?.width || window.innerWidth) - 16;
    const bottom = Math.min(rect.top - 8, top + (viewport?.height || window.innerHeight) - 16);
    const room = bottom - top;
    if (room < 48) { this.close(); return; }
    const width = Math.min(288, right - left);
    element.style.width = `${width}px`;
    element.style.maxHeight = `${Math.min(280, room)}px`;
    element.style.left = `${Math.max(left, Math.min(rect.left, right - width))}px`;
    element.style.top = `${bottom - element.offsetHeight}px`;
  }

  choose(personaId) {
    const query = this.getQuery();
    const currentMembers = this.getMembers();
    const validMember = personaId === MENTION_ALL_ID ? currentMembers.length > 0
      : currentMembers.some(persona => persona.id === personaId);
    if (!query || !this.query || query.start !== this.query.start || query.end !== this.query.end
        || query.query !== this.query.query || !validMember || !this.members.some(persona => persona.id === personaId)) {
      this.close();
      return;
    }
    this.close();
    this.onSelect(personaId, query);
    this.close();
  }

  handleKey(event) {
    if (!this.element || this.composing || event.isComposing || event.keyCode === 229) return false;
    if (event.key === 'Escape') { event.preventDefault(); this.dismiss(); return true; }
    if (event.key === 'Tab') { this.dismiss(); return false; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.active = this.active < 0
        ? (event.key === 'ArrowDown' ? 0 : this.members.length - 1)
        : (this.active + (event.key === 'ArrowDown' ? 1 : -1) + this.members.length) % this.members.length;
      const options = [...this.element.querySelectorAll('[role="option"]')];
      options.forEach((option, index) => option.setAttribute('aria-selected', String(index === this.active)));
      const option = options[this.active];
      this.input.setAttribute('aria-activedescendant', option.id);
      // Scroll only the list, never the page or the focused composer.
      const bounds = option.getBoundingClientRect(), list = this.element.getBoundingClientRect();
      if (bounds.top < list.top) this.element.scrollTop -= list.top - bounds.top + 4;
      else if (bounds.bottom > list.bottom) this.element.scrollTop += bounds.bottom - list.bottom + 4;
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey && this.active >= 0) {
      event.preventDefault();
      this.choose(this.members[this.active].id);
      return true;
    }
    return false;
  }

  dismiss() {
    const query = this.getQuery();
    if (query) this.dismissed = this.input.value.slice(0, query.start + 1);
    this.close();
  }

  close() {
    this.element?.remove();
    this.element = null;
    this.query = null;
    this.active = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-controls');
    this.input.removeAttribute('aria-activedescendant');
  }

  destroy() {
    this.close();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.listeners.forEach(remove => remove());
    for (const attribute of ['aria-autocomplete', 'aria-haspopup', 'aria-expanded']) this.input.removeAttribute(attribute);
  }
}
