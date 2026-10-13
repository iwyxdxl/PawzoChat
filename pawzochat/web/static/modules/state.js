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
export const state = {
  currentTab: "chat",
  pageStack: [],
  tabScrollPos: {},
  sidebarScrollPos: {},
  personas: [],
  conversations: [],
  groups: [],
  confirmCb: null,
  sseSource: null,
  processingPersonas: new Set(),
  settings: null,
  profile: { name: "我", has_avatar: false },
};

export const $ = id => document.getElementById(id);
export const content = () => $("content-area");
export const sidebar = () => $("sidebar-body");
export const topTitle = () => $("top-bar-title");
export const topBack = () => $("top-bar-back");
export const topActions = () => $("top-bar-actions");
