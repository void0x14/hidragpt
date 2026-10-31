// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// Kahin as a first-class Browser Use backend.
//
// The app's browser-service discovers *.sock files under /tmp/codex-browser-use,
// connects, and speaks framed JSON-RPC (4-byte native-endian length + JSON).
// This file implements the same backend API the in-app browser implements
// (getInfo/getTabs/executeCdp/createTab/...), but every page operation is
// proxied to Kahin's MCP/CDP engine instead of an Electron <webview>.
const net = require('node:net');
const { DomShim } = require('./dom-shim.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIPE_DIR = process.platform === 'win32' ? '\\\\.\\pipe\\codex-browser-use' : '/tmp/codex-browser-use';
const LE = os.endianness() === 'LE';

function frame(json) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const head = Buffer.alloc(4);
  if (LE) head.writeUInt32LE(body.length, 0); else head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

function readLength(buf) {
  return LE ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// Mirage/Juggler event names -> the Chromium CDP names browser-service.mjs dispatches on.
function translateEvent(event) {
  const p = event.params || {};
  switch (event.event) {
    case 'Page.navigationStarted':
      return [{ method: 'Page.frameStartedLoading', params: { frameId: p.frameId } }];
    case 'Page.navigationCommitted':
      return [{ method: 'Page.frameNavigated', params: { frame: {
        id: p.frameId, parentId: null, loaderId: p.navigationId || null, name: p.name || '',
        url: p.url, securityOrigin: originOf(p.url), mimeType: 'text/html',
      } } }];
    case 'Page.eventFired':
      if (p.name === 'DOMContentLoaded') return [{ method: 'Page.domContentEventFired', params: { timestamp: Date.now() / 1000 } }];
      if (p.name === 'load') return [{ method: 'Page.loadEventFired', params: { timestamp: Date.now() / 1000 } }];
      return [];
    case 'Runtime.executionContextCreated':
      return [{ method: 'Runtime.executionContextCreated', params: { context: {
        id: p.executionContextId, origin: '', name: p.name || '', auxData: p.auxData || {},
      } } }];
    case 'Network.requestFinished':
      return [{ method: 'Network.loadingFinished', params: {
        requestId: p.requestId, encodedDataLength: p.encodedBodySize || p.transferSize || 0,
        timestamp: Date.now() / 1000,
      } }];
    default:
      return [{ method: event.event, params: p }];
  }
}

class KahinBrowserApi {
  constructor({ ensureKahin, appSessionId, buildFlavor, version }) {
    this.ensureKahin = ensureKahin;
    this.appSessionId = appSessionId || null;
    this.buildFlavor = buildFlavor || 'prod';
    this.version = version || '0.0.0';
    this.tabs = new Map();      // numeric tabId -> { targetId, sessionId, url, title }
    this.nextTabId = 1;
    this.sessionName = null;
    this.activeTabId = null;
    this.clients = new Set();
    this.sessionId = null;
    this.initialTabAdopted = false;
    this.lastSeq = 0;
    this.pumpPrimed = false;
    this.pumping = false;
    this.used = false;
    this.pumpTimer = null;
    this.dom = new DomShim(this);
  }

  async mcp() {
    return this.ensureKahin();
  }

  // --- backend identity -----------------------------------------------------
  async getInfo(params) {
    return {
      name: 'Kahin',
      version: this.version,
      type: 'iab',
      discoveryScope: 'global',
      capabilities: { browser: [], tab: [] },
      apiSupportOverrides: { 'Tab.ax': false, 'Browser.user': false },
      metadata: {
        codexSessionId: this.sessionId || (params && params.session_id) || this.appSessionId,
        codexAppBuildFlavor: this.buildFlavor,
        codexAppSessionId: this.appSessionId,
      },
    };
  }

  // --- tabs -----------------------------------------------------------------
  async refreshTabs() {
    const engine = await this.mcp();
    let pages = [];
    try {
      const res = await engine.call('kahin_mirage_tab_list', {}, 30000);
      pages = Array.isArray(res) ? res : (res && (res.pages || res.tabs)) || [];
    } catch {
      pages = [];
    }
    const seen = new Set();
    for (const page of pages) {
      const targetId = String(page.targetId || page.target_id || page.id || '');
      const sessionId = page.sessionId || page.session_id || null;
      if (!targetId) continue;
      let tab = null;
      for (const existing of this.tabs.values()) {
        if (existing.targetId === targetId) { tab = existing; break; }
      }
      if (!tab) {
        tab = { id: this.nextTabId++, targetId, sessionId, url: '', title: '' };
        this.tabs.set(tab.id, tab);
      }
      tab.sessionId = sessionId || tab.sessionId;
      tab.url = page.url || tab.url;
      tab.title = page.title || tab.title;
      seen.add(tab.id);
    }
    for (const id of [...this.tabs.keys()]) if (!seen.has(id) && this.tabs.size > 1) this.tabs.delete(id);
    if (this.activeTabId == null && this.tabs.size > 0) this.activeTabId = this.tabs.keys().next().value;
    return [...this.tabs.values()];
  }

  async getTabs() {
    this.used = true;
    const tabs = await this.refreshTabs();
    try {
      const engine = await this.mcp();
      const session = await engine.call('kahin_get_session', {}, 15000);
      const sid = session && (session.sessionId || session.session_id);
      if (sid) for (const tab of this.tabs.values()) if (tab.sessionId === sid) this.activeTabId = tab.id;
      const active = this.tabs.get(this.activeTabId);
      if (active) {
        const info = await engine.call('kahin_execute_cdp', { domain: 'Runtime', command: 'evaluate', parameters: { expression: '({ title: document.title, url: location.href })', returnByValue: true } }, 30000).catch(() => null);
        const value = info && info.result && info.result.value;
        if (value && typeof value === 'object') { active.title = value.title || active.title; active.url = value.url || active.url; }
      }
    } catch {}
    return tabs.map((tab) => ({
      id: tab.id,
      active: tab.id === this.activeTabId,
      title: tab.title || '',
      url: tab.url || '',
    }));
  }

  async activate(tab) {
    if (!tab || !tab.targetId) return;
    if (this.activeTabId === tab.id) return;
    const engine = await this.mcp();
    try { await engine.call('kahin_mirage_tab_switch', { target_id: tab.targetId }, 30000); } catch {}
    this.activeTabId = tab.id;
  }

  tab(tabId) {
    const tab = this.tabs.get(Number(tabId));
    if (!tab) throw new Error('Unknown tab: ' + tabId);
    return tab;
  }

  async createTab(params) {
    this.used = true;
    const engine = await this.mcp();
    await this.refreshTabs();
    // The browser starts with one about:blank tab. Reuse it exactly once for
    // the first createTab; otherwise every session leaves an uncontrollable
    // blank tab behind and the real page opens as a second tab (the zombie).
    if (!this.initialTabAdopted && this.tabs.size === 1) {
      const only = [...this.tabs.values()][0];
      this.initialTabAdopted = true;
      this.activeTabId = only.id;
      return { id: only.id, active: true, title: only.title || '', url: 'about:blank' };
    }
    const created = await engine.call('kahin_mirage_tab_new', { url: 'about:blank' }, 60000);
    await this.refreshTabs();
    const targetId = (created && (created.targetId || created.target_id)) || null;
    const tab = targetId
      ? [...this.tabs.values()].find((t) => t.targetId === targetId)
      : [...this.tabs.values()].at(-1);
    if (!tab) throw new Error('Kahin did not report the created tab');
    this.activeTabId = tab.id;
    if (tab.targetId) await engine.call('kahin_mirage_tab_switch', { target_id: tab.targetId }, 30000).catch(() => {});
    return { id: tab.id, active: true, title: tab.title || '', url: tab.url || 'about:blank' };
  }

  async getCommittedTabUrl(params) {
    this.used = true;
    return this.tab(params.tabId).url;
  }

  attachClient(send) {
    this.clients.add(send);
    if (this.pumpTimer == null) {
      this.pumpTimer = setInterval(() => { this.pumpEvents().catch(() => {}); }, 400);
      this.pumpTimer.unref?.();
    }
  }

  detachClient(send) {
    this.clients.delete(send);
  }

  activeTab() {
    return this.tabs.get(this.activeTabId) || this.tabs.values().next().value || null;
  }

  tabForSession(sessionId) {
    if (sessionId == null) return this.activeTab();
    for (const tab of this.tabs.values()) if (tab.sessionId === sessionId) return tab;
    return this.activeTab();
  }

  async pumpEvents() {
    if (!this.used || this.clients.size === 0 || this.pumping) return;
    this.pumping = true;
    try {
      const engine = await this.ensureKahin();
      const events = await engine.call('kahin_event_history', { limit: 500 }, 15000).catch(() => null);
      if (!Array.isArray(events) || events.length === 0) return;
      const maxSeq = events.reduce((max, e) => Math.max(max, Number(e && e.seq) || 0), 0);
      if (!this.pumpPrimed) { this.pumpPrimed = true; this.lastSeq = maxSeq; return; }
      if (maxSeq < this.lastSeq) this.lastSeq = 0; // engine restart resets seq
      for (const event of events) {
        const seq = Number(event && event.seq) || 0;
        if (seq <= this.lastSeq) continue;
        if (event.event === 'Page.screencastFrame' || String(event.event).startsWith('Target.')) continue;
        const tab = this.tabForSession(event.session_id);
        if (!tab) continue;
        const source = { tabId: tab.id, sessionId: event.session_id ?? tab.sessionId ?? null };
        for (const translated of translateEvent(event)) {
          const params = { source, method: translated.method, params: translated.params };
          for (const send of this.clients) send({ jsonrpc: '2.0', method: 'onCDPEvent', params });
          if (translated.method === 'Page.frameNavigated') {
            const url = translated.params && translated.params.frame && translated.params.frame.url;
            if (url) { tab.url = url; for (const t of this.tabs.values()) if (t.id === tab.id) t.url = url; }
            this.dom.onNavigated(tab).catch(() => {});
          }
        }
      }
      this.lastSeq = maxSeq;
    } finally {
      this.pumping = false;
    }
  }

  // --- CDP ------------------------------------------------------------------
  async executeCdp(request) {
    this.used = true;
    const { target, method, commandParams } = request || {};
    const tab = this.tab(target && target.tabId);
    await this.activate(tab);
    if (method === 'Target.getTargets') {
      return {
        targetInfos: [...this.tabs.values()].map((t) => ({
          targetId: t.targetId,
          type: 'page',
          title: t.title,
          url: t.url,
          attached: true,
          tabId: t.id,
        })),
      };
    }
    if (method === 'Target.getTargetInfo') {
      return { targetInfo: { targetId: tab.targetId, type: 'page', title: tab.title, url: tab.url, attached: true, tabId: tab.id } };
    }
    if (method === 'Target.closeTarget') {
      const engine = await this.mcp();
      await engine.call('kahin_mirage_tab_close', { target_id: tab.targetId }, 30000).catch(() => {});
      this.tabs.delete(tab.id);
      return { success: true };
    }
    if (method === 'Page.getNavigationHistory') {
      try {
        const engine = await this.mcp();
        const history = await engine.call('kahin_execute_cdp', { domain: 'Page', command: 'getNavigationHistory', parameters: {} }, 30000);
        if (history && Array.isArray(history.entries)) return history;
      } catch {}
      return { currentIndex: 0, entries: [{ id: 0, url: tab.url, title: tab.title, transitionType: 'typed' }] };
    }
    const shimmed = await this.dom.handle(tab, method, commandParams || {});
    if (shimmed !== null) return shimmed;
    const dot = String(method || '').indexOf('.');
    if (dot < 1) throw new Error('Invalid CDP method: ' + method);
    const domain = method.slice(0, dot);
    const command = method.slice(dot + 1);
    const engine = await this.mcp();
    const result = await engine.call('kahin_execute_cdp', { domain, command, parameters: commandParams || {} }, 120000);
    if (result && result.error) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error));
    if (method === 'Page.navigate' && commandParams && commandParams.url) {
      tab.url = String(commandParams.url);
    }
    if (method === 'Page.getFrameTree' && result && result.frameTree) {
      const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
      const walk = (node) => {
        if (!node) return;
        if (!node.frame.securityOrigin) node.frame.securityOrigin = origin(node.frame.url);
        for (const child of node.childFrames || []) walk(child);
      };
      walk(result.frameTree);
    }
    return result;
  }

  async executeUnhandledCommand(request) {
    switch (request && request.type) {
      case 'create_tab': return this.createTab(request);
      case 'close_tab': this.tabs.delete(this.tab(request.tabId || request.tab_id).id); return {};
      case 'list_tabs': return this.getTabs();
      case 'navigate_tab_url': {
        const tab = this.tab(request.tabId || request.tab_id);
        return this.executeCdp({ target: { tabId: tab.id }, method: 'Page.navigate', commandParams: { url: request.url } });
      }
      default: throw new Error('Kahin backend does not support command "' + (request && request.type) + '"');
    }
  }

  // --- lifecycle / misc -----------------------------------------------------
  async attach(params) {
    await this.refreshTabs();
    const tab = this.tab(params && params.tabId);
    if (!tab.sessionId) {
      try {
        const engine = await this.mcp();
        const session = await engine.call('kahin_get_session', {}, 15000);
        tab.sessionId = (session && (session.sessionId || session.session_id)) || null;
      } catch {}
    }
    if (!tab.targetId) tab.targetId = 'kahin-tab-' + tab.id;
    return {
      sessionId: tab.sessionId,
      targetInfo: { targetId: tab.targetId, type: 'page', title: tab.title, url: tab.url, attached: true, tabId: tab.id },
    };
  }
  async attachTarget() { return {}; }
  async detach() { return {}; }
  async detachTarget() { return {}; }
  async moveMouse(params) {
    await this.activate(this.tab(params && params.tabId));
    const engine = await this.mcp();
    return engine.call('kahin_mirage_mouse_move', { x: params.x, y: params.y }, 15000).catch(() => ({}));
  }
  async nameSession(params) { this.sessionName = params && params.name; return {}; }
  async markTab() { return {}; }
  async allowDownload() { return {}; }
  async followSessionTab() { return false; }
  async getUserTabs() { return []; }
  async getUserHistory() { throw new Error('browser.history is unavailable in the Kahin backend'); }
  async executeTabRead() { throw new Error('tabs.content is unavailable in the Kahin backend'); }
  async claimUserTab() { throw new Error('claimTab is unavailable in the Kahin backend'); }
  async browserAuthNewTargetProtection() { return {}; }
  async ping() { return 'pong'; }
  async turnEnded() { return {}; }
}

function startKahinBrowserPipe(options) {
  const api = new KahinBrowserApi(options);
  fs.mkdirSync(PIPE_DIR, { recursive: true, mode: 0o700 });
  const socketPath = path.join(PIPE_DIR, 'kahin-' + process.pid + '.sock');
  try { fs.unlinkSync(socketPath); } catch {}
  // A crashed run leaves a dead socket behind; the service scans this dir and
  // would try to connect to it. Only our own prefix is touched.
  try {
    for (const name of fs.readdirSync(PIPE_DIR)) {
      if (!name.startsWith('kahin-') || !name.endsWith('.sock') || name === path.basename(socketPath)) continue;
      try { fs.unlinkSync(path.join(PIPE_DIR, name)); } catch {}
    }
  } catch {}

  const server = net.createServer((conn) => {
    let buffer = Buffer.alloc(0);
    const send = (message) => { try { if (!conn.destroyed) conn.write(frame(message)); } catch {} };
    api.attachClient(send);
    const handle = async (message) => {
      if (!message || typeof message !== 'object' || message.method == null) return;
      if (message.params && typeof message.params.session_id === 'string') api.sessionId = message.params.session_id;
      if (message.id == null) {
        const fn = api[message.method];
        if (typeof fn === 'function') Promise.resolve().then(() => fn.call(api, message.params || {})).catch(() => {});
        return;
      }
      try {
        const fn = api[message.method];
        if (typeof fn !== 'function') throw new Error('No handler registered for method: ' + message.method);
        const result = await fn.call(api, message.params || {});
        send({ jsonrpc: '2.0', id: message.id, result: result === undefined ? {} : result });
        if (message.method === 'attach' && result && result.sessionId) {
          const tabId = Number(message.params && message.params.tabId);
          send({ jsonrpc: '2.0', method: 'onCDPEvent', params: {
            source: { tabId, sessionId: result.sessionId },
            method: 'Target.attachedToTarget',
            params: { sessionId: result.sessionId, targetInfo: result.targetInfo, waitingForDebugger: false },
          } });
        }
      } catch (err) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: 1, message: String(err && err.message || err) } });
      }
    };
    conn.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = readLength(buffer);
        if (length > 64 * 1024 * 1024) { conn.destroy(); return; }
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length).toString('utf8');
        buffer = buffer.subarray(4 + length);
        let message;
        try { message = JSON.parse(body); } catch { continue; }
        handle(message);
      }
    });
    conn.on('error', () => {});
    conn.on('close', () => { api.detachClient(send); });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      try { fs.chmodSync(socketPath, 0o600); } catch {}
      resolve({
        api,
        socketPath,
        close: () => new Promise((done) => {
          server.close(() => done());
          try { fs.unlinkSync(socketPath); } catch {}
        }),
      });
    });
  });
}

module.exports = { startKahinBrowserPipe, KahinBrowserApi };
