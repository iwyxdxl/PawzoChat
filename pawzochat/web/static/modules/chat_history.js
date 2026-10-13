/* PawzoChat — Copyright (C) 2026 iwyxdxl. SPDX-License-Identifier: AGPL-3.0-or-later */
import { ChatTimeline } from './chat_timeline.js';
import { VirtualMessages } from './virtual_messages.js';

/* Owns one mounted chat session. Read requests never use the shared SWR cache. */
export class ChatHistory {
  constructor({ el, personaId, messagesUrl, renderItem, onUnread, onError, onDistanceChange, onState }) {
    this.personaId = personaId;
    this.messagesUrl = messagesUrl || `/api/conversations/${encodeURIComponent(personaId)}/messages`;
    this.onUnread = onUnread;
    this.onError = onError;
    this.onDistanceChange = onDistanceChange;
    this.onState = onState;
    this.timeline = new ChatTimeline();
    this.unread = new Set();
    this.generation = 0;
    this.destroyed = false;
    this.list = new VirtualMessages(el, renderItem, () => this.onScroll());
    this.reload();
  }

  async request(params, signal = this.controller.signal) {
    const query = new URLSearchParams({ limit: '60', ...params });
    const response = await fetch(`${window.PAWZOCHAT_BASE || ''}${this.messagesUrl}?${query}`, { signal, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || '加载失败'), { status: response.status });
    return result;
  }

  current(generation) { return !this.destroyed && generation === this.generation; }

  async reload(notify = false) {
    if (this.destroyed) return;
    this.controller?.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;
    this.loading = true;
    this.olderTask = null;
    this.syncTask = null;
    this.syncDirty = false;
    this.hasMore = false;
    this.olderFailed = false;
    this.before = this.after = null;
    this.list.setStatus('加载中…');
    try {
      const page = await this.request({});
      if (!this.current(generation)) return;
      this.onState?.(page.state);
      // Keep outstanding local sends when a structural edit resets paging.
      const persisted = new Set(page.messages.map(m => m.local_id || m._page_key));
      const pending = this.timeline.items.filter(m => (m._pending || m._failed) && !persisted.has(m._key));
      const ownKeys = this.timeline.ownKeys;
      this.timeline = new ChatTimeline();
      this.timeline.ownKeys = ownKeys;
      this.timeline.merge([...page.messages, ...pending]);
      this.before = page.before_cursor;
      this.after = page.after_cursor;
      this.hasMore = page.has_more;
      this.unread.clear();
      this.onUnread(0);
      this.list.setItems(this.timeline.items, { bottom: true });
      if (notify) this.onError('历史已更新，已重新加载');
    } catch (error) {
      if (!this.current(generation) || error.name === 'AbortError') return;
      this.list.setStatus('加载失败，点击重试', () => this.reload());
      return;
    } finally {
      if (this.current(generation)) this.loading = false;
    }
    if (!this.current(generation)) return;
    this.historyStatus();
    this.onScroll();
    if (this.syncDirty) this.sync();
  }

  historyStatus() {
    this.list.setStatus(this.hasMore ? '上滑加载更多' : '已到最早消息');
  }

  onScroll() {
    if (this.destroyed || this.loading) return;
    const el = this.list.el;
    this.onDistanceChange?.(Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop));
    if (this.list.isNearBottom()) this.clearUnread();
    if (this.hasMore && !this.olderTask && !this.olderFailed && this.list.el.scrollTop < 300) this.loadOlder();
  }

  async loadOlder() {
    if (this.destroyed || this.loading || this.olderTask || !this.hasMore) return;
    const generation = this.generation;
    this.olderFailed = false;
    this.list.setStatus('加载中…');
    const task = this.request({ before: this.before });
    this.olderTask = task;
    try {
      const page = await task;
      if (!this.current(generation)) return;
      this.onState?.(page.state);
      this.before = page.before_cursor;
      this.hasMore = page.has_more;
      this.timeline.merge(page.messages);
      // A history prepend must preserve the reader even when the previous
      // short page happened to fit inside the viewport.
      this.list.setItems(this.timeline.items, { bottom: false });
      this.historyStatus();
    } catch (error) {
      if (!this.current(generation) || error.name === 'AbortError') return;
      if (error.status === 409) { this.reload(true); return; }
      this.olderFailed = true;
      this.list.setStatus('加载失败，点击重试', () => this.loadOlder());
    } finally {
      if (this.current(generation) && this.olderTask === task) this.olderTask = null;
    }
    if (this.current(generation) && !this.olderFailed) this.onScroll();
  }

  apply(messages, incoming = false) {
    const bottom = this.list.followBottom;
    const added = this.timeline.merge(messages);
    if (incoming && !bottom) for (const m of added) this.unread.add(m._key);
    this.list.setItems(this.timeline.items, { bottom });
    if (bottom) this.clearUnread();
    else this.onUnread(this.unread.size);
  }

  receive(message) {
    if (this.destroyed) return;
    if (!this.loading && this.after) {
      // Storage precedes the channel's typing delay. Fetching after every SSE
      // bubble can reveal the next stored reply before it has been delivered.
      this.apply([message], true);
    } else this.syncDirty = true;
  }

  sync() {
    if (this.destroyed) return Promise.resolve();
    this.syncDirty = true;
    if (this.loading || !this.after) return Promise.resolve();
    if (this.syncTask) return this.syncTask;
    const generation = this.generation;
    const task = (async () => {
      try {
        do {
          this.syncDirty = false;
          let more;
          do {
            const page = await this.request({ after: this.after });
            if (!this.current(generation)) return;
            this.onState?.(page.state);
            this.after = page.after_cursor;
            if (page.messages.length) this.apply(page.messages, true);
            more = page.has_more;
          } while (more);
        } while (this.syncDirty);
      } catch (error) {
        if (!this.current(generation) || error.name === 'AbortError') return;
        if (error.status === 409) { this.reload(true); return; }
        this.onError('新消息同步失败，请刷新页面重试');
      } finally {
        if (this.current(generation)) this.syncTask = null;
      }
    })();
    this.syncTask = task;
    return task;
  }

  optimistic(message) {
    const key = this.timeline.optimistic({ ...message, _pending: true });
    this.list.setItems(this.timeline.items);
    return key;
  }

  acknowledge(key, message) {
    if (this.destroyed) return;
    this.timeline.acknowledge(key, message ? { ...message, _pending: true } : null);
    this.unread.delete(message?.local_id);
    this.onUnread(this.unread.size);
    this.list.setItems(this.timeline.items);
    // The queue publishes new_message when this accepted message is stored.
  }

  fail(key) {
    if (this.destroyed) return;
    this.timeline.fail(key);
    this.list.setItems(this.timeline.items);
  }

  clearUnread() {
    if (!this.unread.size) return;
    this.unread.clear();
    this.onUnread(0);
  }

  async goToBottom() {
    if (this.destroyed) return;
    this.list.scrollToBottom();
    this.clearUnread();
    await this.sync();
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    this.controller.abort();
    this.list.destroy();
    this.timeline = new ChatTimeline();
    this.unread.clear();
  }
}
