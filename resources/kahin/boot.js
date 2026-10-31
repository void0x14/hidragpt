// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// ChatGPT Desktop <-> Kahin/Mirage second-engine bridge (main process).
// Loaded from resources/kb.js, injected into .vite/build/early-bootstrap.js.
// Linux only: macOS is code-signed and enforces ASAR integrity.
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { KahinMcp } = require('./mcp-client.js');
const { startKahinBrowserPipe } = require('./browser-pipe.js');

const OVERLAY_SRC = fs.readFileSync(path.join(__dirname, 'overlay.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
const CONTROL_SOCKET = path.join(os.homedir(), '.kahin', 'chatgpt-bridge.sock');
const FROM_VIEW = 'codex_desktop:message-from-view';
const METRICS = 'codex_desktop:get-fast-mode-rollout-metrics';
const FOR_VIEW = 'codex_desktop:message-for-view';

const STATE = {
  mcp: null,
  windows: new Map(),   // ownerWebContents.id -> window state
  control: null,
  browserPipe: null,
  nextGuest: null,      // {hostId, route, expiresAt}
};

function injectUi(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(UI_SRC, true).catch((err) => log('ui', err));
}

function sendEngineState(owner, engine, error) {
  try {
    if (!owner || owner.isDestroyed()) return;
    const message = { type: '__kahin_state', engine };
    if (error) message.error = String(error);
    owner.send(FOR_VIEW, message);
  } catch {}
}

function log(scope, err) {
  try { console.error('[kahin:' + scope + ']', err && err.message || err); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function install() {
  wrapIpcMain();
  app.on('web-contents-created', onWebContentsCreated);
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('did-finish-load', () => injectUi(win));
    win.once('closed', () => {
      const w = STATE.windows.get(win.webContents.id);
      if (w) stopPump(w);
    });
  });
  app.whenReady().then(() => {
    for (const win of BrowserWindow.getAllWindows()) injectUi(win);
    startControlServer().catch((err) => log('control', err));
    startKahinBrowserPipe({
      ensureKahin,
      appSessionId: randomUUID(),
      buildFlavor: 'prod',
      version: app.getVersion(),
    }).then((pipe) => {
      STATE.browserPipe = pipe;
      log('pipe', 'listening ' + pipe.socketPath);
    }).catch((err) => log('pipe', err));
  }).catch((err) => log('ready', err));
}

// ---------------------------------------------------------------------------
// The app's own renderer channel is the only UI seam we need. We intercept
// browser-sidebar-command while Kahin is active and let everything else through
// untouched. Same handler registration point the app uses for all messages.
// ---------------------------------------------------------------------------
function wrapIpcMain() {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (channel === METRICS) {
      return original(channel, async (event, payload, ...rest) => {
        // Pull model: this is the one preload method that returns the invoke
        // result, so the renderer can fetch the single latest frame.
        if (payload && typeof payload === 'object' && payload.__kahin_frame_request === true && event && event.sender) {
          return stateFor(event.sender).latest || null;
        }
        return listener(event, payload, ...rest);
      });
    }
    if (channel !== FROM_VIEW) return original(channel, listener);
    return original(channel, async (event, message, ...rest) => {
      if (message && typeof message === 'object' && event && event.sender) {
        if (message.type === '__kahin_input') return onKahinInput(event.sender, message.payload || {});
        if (message.type === '__kahin_switch') {
          return switchEngine(message.engine, event.sender).catch((err) => {
            try { event.sender.send(FOR_VIEW, { type: '__kahin_state', engine: 'native', error: String(err && err.message || err) }); } catch {}
            throw err;
          });
        }
        const w = stateFor(event.sender);
        if (message.type === 'browser-sidebar-command' && w.engine === 'kahin') {
          return onKahinCommand(w, message);
        }
      }
      return listener(event, message, ...rest);
    });
  };
}

function stateFor(owner) {
  let w = STATE.windows.get(owner.id);
  if (!w) {
    w = {
      owner,
      route: null,
      guestId: null,
      guest: null,
      engine: 'native',
      overlay: false,
      pump: null,
      stateTimer: null,
      metaTimer: null,
      lastUrl: '',
      lastTitle: '',
      latest: null,        // {seq, data: Buffer, mimeType, width, height} — exactly one
      frameSeq: 0,
      kahinError: null,
    };
    STATE.windows.set(owner.id, w);
    owner.once('destroyed', () => {
      stopPump(w);
      if (w.stateTimer) clearInterval(w.stateTimer);
      if (w.metaTimer) clearInterval(w.metaTimer);
      STATE.windows.delete(owner.id);
    });
  }
  return w;
}

function onWebContentsCreated(_event, wc) {
  try {
    wc.on('will-attach-webview', (_ev, webPreferences, params) => {
      const preload = String(webPreferences && webPreferences.preload || '');
      if (!preload.includes('browser-page-preload.js')) return;
      const w = stateFor(wc);
      w.route = parsePartition(params && params.partition) || w.route;
      STATE.nextGuest = { hostId: wc.id, route: w.route, expiresAt: Date.now() + 15000 };
    });
    wc.on('did-attach-webview', (_ev, guest) => {
      const pending = STATE.nextGuest;
      if (!pending || pending.hostId !== wc.id || pending.expiresAt < Date.now()) return;
      if (!guest || guest.isDestroyed()) return;
      STATE.nextGuest = null;
      const w = stateFor(wc);
      w.guest = guest;
      w.guestId = guest.id;
      if (pending.route) w.route = pending.route;
      guest.once('destroyed', () => {
        if (w.guest === guest) { w.guest = null; w.guestId = null; }
        if (w.engine === 'kahin') switchEngine('native', wc).catch((err) => log('switch', err));
      });
      log('guest', 'attached ' + guest.id);
    });
  } catch (err) { log('wc', err); }
}

function parsePartition(partition) {
  const prefix = 'persist:codex-browser-app-route:';
  if (typeof partition !== 'string' || !partition.startsWith(prefix)) return null;
  try {
    const raw = decodeURIComponent(partition.slice(prefix.length));
    const cut = raw.indexOf('\0');
    if (cut < 0) return null;
    const conversationId = raw.slice(0, cut);
    const rest = raw.slice(cut + 1);
    const hostAt = rest.indexOf(':host:');
    const browserTabId = hostAt >= 0 ? rest.slice(0, hostAt) : rest;
    if (!conversationId || !browserTabId) return null;
    return { conversationId, browserTabId };
  } catch { return null; }
}

function guestFor(owner) {
  const w = STATE.windows.get(owner.id);
  return w && w.guest && !w.guest.isDestroyed() ? w.guest : null;
}

// The attach event can be missed (ordering, reload, app update). The webview
// element knows its guest id and route; ask the renderer instead of guessing.
async function resolveGuest(owner) {
  const known = guestFor(owner);
  if (known) return known;
  try {
    const info = await owner.executeJavaScript('(() => {' +
      '  const vis = (el) => { const b = el.getBoundingClientRect(); if (b.width < 2 || b.height < 2) return false;' +
      '    try { if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false; } catch {}' +
      '    if (el.getAttribute("data-kahin-hidden") === "1") return true;' +
      '    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity || 1) > 0; };' +
      '  const pool = Array.from(document.querySelectorAll("webview")).filter(e => e.hasAttribute("data-browser-sidebar-browser-tab-id"));' +
      '  const sized = pool.filter(e => { const b = e.getBoundingClientRect(); return b.width > 1 && b.height > 1; });' +
      '  const shown = sized.filter(vis);' +
      '  const pick = (shown.length ? shown : sized).sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); const oa = (ra.x > 0 || ra.y > 0) ? 1 : 0, ob = (rb.x > 0 || rb.y > 0) ? 1 : 0; if (oa !== ob) return ob - oa; return rb.width * rb.height - ra.width * ra.height; });' +
      '  const el = pick[0];' +
      '  if (!el) return null;' +
      '  let id = null; try { id = el.getWebContentsId(); } catch {}' +
      '  return { id, conversationId: el.getAttribute("data-browser-sidebar-conversation-id"), browserTabId: el.getAttribute("data-browser-sidebar-browser-tab-id") };' +
      '})()', true);
    if (!info || !info.id) return null;
    const guest = webContents.fromId(info.id);
    if (!guest || guest.isDestroyed()) return null;
    const w = stateFor(owner);
    w.guest = guest;
    w.guestId = guest.id;
    if (info.conversationId && info.browserTabId) {
      w.route = { conversationId: info.conversationId, browserTabId: info.browserTabId };
    }
    log('guest', 'resolved ' + guest.id);
    return guest;
  } catch { return null; }
}

function primaryOwner() {
  // The app creates hidden aux windows (pet, quick chat, overlays). Never send
  // RPC work to those; pick a visible main window, preferring one with a
  // browser sidebar guest already attached.
  const visible = BrowserWindow.getAllWindows().filter((b) => {
    if (b.isDestroyed() || !b.isVisible()) return false;
    const bounds = b.getContentBounds();
    return bounds.width >= 320 && bounds.height >= 240;
  });
  const focused = BrowserWindow.getFocusedWindow();
  const focusedVisible = focused && !focused.isDestroyed() && visible.includes(focused) ? focused : null;
  const withGuest = visible.find((b) => guestFor(b.webContents)) || (focusedVisible && guestFor(focusedVisible.webContents) ? focusedVisible : null);
  const main = visible.find((b) => { try { return String(b.webContents.getURL()).startsWith('app://'); } catch { return false; } });
  const win = withGuest || focusedVisible || main || visible[0] || null;
  return win ? win.webContents : null;
}

// ---------------------------------------------------------------------------
// Engine switch
// ---------------------------------------------------------------------------
async function switchEngine(engine, sender) {
  const target = engine === 'kahin' ? 'kahin' : 'native';
  const owner = sender && !sender.isDestroyed() ? sender : primaryOwner();
  if (!owner) throw new Error('no ChatGPT window');
  const w = stateFor(owner);

  if (target === 'kahin') {
    let guest = await resolveGuest(owner);
    if (!guest) { await setBrowserPanel(true); guest = await resolveGuest(owner); }
    if (!guest) throw new Error('in-app browser panel is not open');
    // The app syncs the native webview to the browser-sidebar-state snapshot.
    // While Kahin owns the panel that sync must not navigate the native page.
    if (!w.origLoadURL) {
      w.origLoadURL = guest.loadURL.bind(guest);
      guest.loadURL = (url, ...rest) => {
        if (w.engine === 'kahin') { log('nav-guard', 'blocked native load ' + url); return Promise.resolve(); }
        return w.origLoadURL(url, ...rest);
      };
    }
    let currentNative = '';
    try { currentNative = guest.getURL() || ''; } catch {}
    if (/^https?:/i.test(currentNative)) w.nativeUrl = currentNative;
    else if (w.nativeUrl == null) w.nativeUrl = currentNative || 'about:blank';
    await ensureKahin();
    // Blank-page guarantee: mirror the native tab, prove the load, then fall
    // back to example.com and finally a local dark landing page.
    const page = await ensureKahinPage(w);
    if (page.fallback) log('page', 'using ' + page.fallback + ' -> ' + (page.url || '?') + (page.error ? ' (' + page.error + ')' : ''));
    w.kahinError = page.ok ? null : page.error;
    if (!w.overlay) {
      try {
        const injected = await owner.executeJavaScript(OVERLAY_SRC, true);
        w.overlay = injected === 'ok' || injected === 'exists';
      } catch (err) { log('overlay', err); }
    }
    if (!w.overlay) throw new Error('overlay injection failed');
    await owner.executeJavaScript('window.__kahinOverlay.attach(' + Number(guest.id) + ')', true);
    const rect = await overlayRect(owner);
    if (!rect) throw new Error('browser panel has no visible bounds');
    await setViewport(rect.width, rect.height);
    startPump(w, rect.width, rect.height);
    w.engine = 'kahin';
    watchMeta(w);
    sendEngineState(owner, 'kahin', w.kahinError);
    pushKahinMeta(w).catch(() => {});
  } else {
    stopPump(w);
    w.kahinError = null;
    if (w.stateTimer) { clearInterval(w.stateTimer); w.stateTimer = null; }
    if (w.metaTimer) { clearInterval(w.metaTimer); w.metaTimer = null; }
    const native = await resolveGuest(owner);
    if (native && w.origLoadURL) { native.loadURL = w.origLoadURL; w.origLoadURL = null; }
    if (native && w.nativeUrl && native.getURL() !== w.nativeUrl) { try { native.loadURL(w.nativeUrl); } catch {} }
    if (w.overlay) {
      try { await owner.executeJavaScript('window.__kahinOverlay && window.__kahinOverlay.detach()', true); } catch {}
    }
    w.engine = 'native';
    sendNativeMeta(owner);
    const guest = await resolveGuest(owner);
    if (guest) guest.focus();
    // Minimal native restore: no browser-sidebar-state injection. The app's own
    // page state is left exactly as it was before the Kahin switch.
    // await pushNativeState(w);
    sendEngineState(owner, 'native');
  }
  return snapshot(w);
}

async function overlayRect(owner) {
  try {
    const rect = await owner.executeJavaScript('window.__kahinOverlay ? window.__kahinOverlay.rect() : null', true);
    if (!rect) return null;
    const zoom = owner.getZoomFactor();
    return {
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom),
    };
  } catch { return null; }
}

function snapshot(w) {
  const guest = w ? guestFor(w.owner) : null;
  return {
    engine: w ? w.engine : 'native',
    windowId: w ? w.owner.id : null,
    route: w ? w.route : null,
    guestId: guest ? guest.id : null,
    kahin: STATE.mcp ? STATE.mcp.state() : 'stopped',
    overlay: w ? w.overlay : false,
    socket: CONTROL_SOCKET,
  };
}

// ---------------------------------------------------------------------------
// Frame pump: base64 MCP screencast -> binary frame -> renderer canvas.
// ---------------------------------------------------------------------------
function stopPump(w) {
  if (!w) return;
  if (w.pump) { w.pump.alive = false; w.pump = null; }
  w.latest = null;
}

function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

async function startScreencast(width, height) {
  try {
    await STATE.mcp.call('kahin_mirage_screencast_stop', {}, 8000).catch(() => {});
    const started = await STATE.mcp.call('kahin_mirage_screencast_start', {
      width: even(width), height: even(height), quality: 72,
    }, 30000);
    return (started && started.screencastId) || null;
  } catch (err) { log('screencast', err); return null; }
}

function startPump(w, width, height) {
  stopPump(w);
  const pump = { alive: true, screencastId: null, frames: 0, lastAt: 0, lastError: null, mode: 'screencast' };
  w.pump = pump;
  // Pull model: the pump only stores one frame; the overlay requests it.
  // shortcut: MCP relay tops out around 5 fps; move to a direct CDP screencast
  // socket or a native frame pipe when >10 fps is required.
  (async () => {
    pump.screencastId = await startScreencast(width, height);
    let fallbackAt = 0;
    while (pump.alive && !w.owner.isDestroyed()) {
      let res = null;
      try {
        res = pump.screencastId
          ? await STATE.mcp.call('kahin_mirage_screencast_frame', {
              timeout: 0.2, fresh: false, screencast_id: pump.screencastId,
            }, 15000)
          : null;
      } catch (err) {
        pump.lastError = String(err && err.message || err);
      }
      let frame = framePayload(res);
      if (!frame && Date.now() - fallbackAt > 1200) {
        // Screencast is damage-driven; a static page still needs a frame.
        fallbackAt = Date.now();
        pump.mode = 'screenshot';
        try { frame = framePayload(await STATE.mcp.call('kahin_screenshot', {}, 30000)); } catch (err) {
          pump.lastError = String(err && err.message || err);
        }
      }
      if (frame && pump.alive && w.pump === pump) {
        const bytes = Buffer.from(frame.data, 'base64');
        if (bytes.length) {
          pump.frames += 1;
          pump.lastAt = Date.now();
          pump.lastError = null;
          w.frameSeq += 1;
          // Exactly one frame per window. Never a queue or an array.
          w.latest = {
            seq: w.frameSeq,
            data: bytes,
            mimeType: frame.mimeType,
            width: frame.width,
            height: frame.height,
          };
        }
      }
      await sleep(200); // hard cap: 5 fps
    }
  })().catch((err) => log('pump', err));
}

function framePayload(res) {
  if (!res) return null;
  if (res.image) return { data: res.image, mimeType: res.mimeType || 'image/jpeg', width: null, height: null };
  const data = res.data || res.jpeg || res.base64 || res.screenshot;
  if (!data) return null;
  return {
    data,
    mimeType: res.mimeType || 'image/jpeg',
    width: res.deviceWidth || res.width || null,
    height: res.deviceHeight || res.height || null,
  };
}

// ---------------------------------------------------------------------------
// Kahin engine
// ---------------------------------------------------------------------------
async function ensureKahinIdentity() {
  try {
    const list = await STATE.mcp.call('kahin_identity_list', {}, 30000);
    const names = ((list && list.identities) || []).map((x) => x && x.name).filter(Boolean);
    if (!names.includes('hydragpt')) {
      await STATE.mcp.call('kahin_identity_new', { name: 'hydragpt', os_target: 'linux' }, 60000);
      log('identity', 'created hydragpt');
    }
    return 'hydragpt';
  } catch (err) {
    log('identity', err);
    return null;
  }
}

async function ensureKahin() {
  if (!STATE.mcp) STATE.mcp = new KahinMcp();
  await STATE.mcp.start();
  if (!STATE.mcp.ready) {
    const identity = await ensureKahinIdentity();
    await STATE.mcp.call('kahin_browser_start', STATE.mcp.startArgs(identity), 180000);
    const tabs = await STATE.mcp.call('kahin_mirage_tab_list', {}, 30000);
    if (!Array.isArray(tabs) || tabs.length === 0) {
      await STATE.mcp.call('kahin_mirage_tab_new', { url: 'about:blank' }, 60000);
    }
    STATE.mcp.ready = true;
  }
}

// ---------------------------------------------------------------------------
// Blank-page guarantee: mirror, prove, fall back, and never show an empty page.
// ---------------------------------------------------------------------------
const LANDING_HTML = [
  '<!doctype html><meta charset="utf-8"><title>HYDRAGPT ENGINE READY</title>',
  '<style>html,body{margin:0;height:100%;background:#0b0d10;color:#e6edf3;',
  'font:600 30px/1.4 system-ui,sans-serif;display:flex;align-items:center;',
  'justify-content:center;flex-direction:column;gap:14px}h1{margin:0;font-size:34px;',
  'letter-spacing:.08em}p{margin:0;font:400 13px/1.5 ui-monospace,monospace;',
  'color:#8b949e;max-width:660px;text-align:center}</style>',
  '<h1>HYDRAGPT ENGINE READY</h1>',
  '<p>Page mirror unavailable. Kahin/Mirage is running; use the address bar or agent tools.</p>',
].join('');

const LANDING_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(LANDING_HTML);

async function kahinPageInfo() {
  try {
    const page = await kahinEval('({ href: String(location.href || ""), readyState: String(document.readyState || ""), title: String(document.title || ""), text: String((document.body && document.body.innerText) || "").slice(0, 160) })');
    if (page && typeof page === 'object') return page;
  } catch {}
  return null;
}

function pageIsLive(page) {
  const href = String(page && page.href || '');
  const ready = String(page && page.readyState || '');
  return !!href && !!ready && !/^about:/i.test(href);
}

async function ensureKahinPage(w) {
  const tried = [];
  const mirror = String(w.nativeUrl || '');
  if (/^https?:/i.test(mirror)) {
    try {
      const current = await kahinPageInfo();
      if (pageIsLive(current) && current.href === mirror) return { ok: true, mirrored: true, url: current.href };
      await STATE.mcp.call('kahin_navigate', { url: mirror, wait_until: 'domcontentloaded' }, 20000);
      const page = await kahinPageInfo();
      if (pageIsLive(page)) return { ok: true, mirrored: true, url: page.href };
      tried.push('mirror ' + mirror + ' -> ' + JSON.stringify(page));
    } catch (err) { tried.push('mirror ' + mirror + ': ' + (err && err.message || err)); }
  } else {
    tried.push('native url: ' + (mirror || 'empty'));
  }

  // Proof page: a deterministic, always-reachable document beats a blank panel.
  try {
    await STATE.mcp.call('kahin_navigate', { url: 'https://example.com', wait_until: 'domcontentloaded' }, 20000);
    const page = await kahinPageInfo();
    if (pageIsLive(page)) return { ok: true, proof: true, url: page.href };
    tried.push('example.com -> ' + JSON.stringify(page));
  } catch (err) { tried.push('example.com: ' + (err && err.message || err)); }

  // Last resort: paint the landing page into the engine document itself.
  try {
    await STATE.mcp.call('kahin_navigate', { url: LANDING_URL, wait_until: 'domcontentloaded' }, 20000);
  } catch (err) { tried.push('landing nav: ' + (err && err.message || err)); }
  let page = await kahinPageInfo();
  if (!page || !String(page.text || '').includes('HYDRAGPT ENGINE READY')) {
    try {
      await kahinEval('(() => { document.open(); document.write(' + JSON.stringify(LANDING_HTML) + '); document.close(); return true; })()');
    } catch (err) { tried.push('landing write: ' + (err && err.message || err)); }
    page = await kahinPageInfo();
  }
  const landed = !!(page && String(page.text || '').includes('HYDRAGPT ENGINE READY'));
  return {
    ok: landed,
    fallback: 'landing',
    url: page ? String(page.href || '') : '',
    error: (landed ? 'page mirror unavailable; painted HYDRAGPT ENGINE READY' : 'page mirror and landing page failed') + ': ' + tried.join(' | '),
  };
}

async function setViewport(width, height) {
  if (!STATE.mcp) return;
  try {
    await STATE.mcp.call('kahin_mirage_set_viewport', { width: Math.round(width), height: Math.round(height) }, 20000);
  } catch (err) { log('viewport', err); }
}

async function kahinCdp(domain, command, parameters) {
  return STATE.mcp.call('kahin_execute_cdp', { domain, command, parameters: parameters || {} }, 60000);
}

async function kahinEval(expression) {
  try {
    const res = await STATE.mcp.call('kahin_mirage_eval', { expression }, 30000);
    const box = res && typeof res === 'object' ? res : {};
    const value = box.result && typeof box.result === 'object' && 'value' in box.result
      ? box.result.value
      : ('value' in box ? box.value : res);
    if (value !== undefined && value !== null) return value;
  } catch {}
  try {
    const res = await kahinCdp('Runtime', 'evaluate', { expression, returnByValue: true });
    return res && res.result ? res.result.value : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Input from the overlay
// ---------------------------------------------------------------------------
async function onKahinInput(owner, p) {
  const w = stateFor(owner);
  if (p.type === 'resize') {
    if (p.route && !w.route) w.route = p.route;
    if (w.engine !== 'kahin') return { ok: true };
    const rect = await overlayRect(owner);
    if (!rect) return { ok: true };
    await setViewport(rect.width, rect.height);
    if (w.pump) startPump(w, rect.width, rect.height);
    return { ok: true };
  }
  if (w.engine !== 'kahin' || !STATE.mcp) return { ok: true };
  const call = (name, args) => STATE.mcp.call(name, args, 15000);
  switch (p.type) {
    case 'click': return call('kahin_mirage_mouse_click', { x: p.x, y: p.y, button: p.button || 0 });
    case 'move': return call('kahin_mirage_mouse_move', { x: p.x, y: p.y });
    case 'wheel': return call('kahin_mirage_scroll', { x: p.x, y: p.y, delta_x: p.dx || 0, delta_y: p.dy || 0 });
    case 'text': return call('kahin_mirage_key_text', { text: String(p.text || '') });
    case 'key': return call('kahin_mirage_key_press', { key: p.key, code: p.code || 'Unidentified', key_code: p.keyCode || 0, text: p.text || null });
    case 'back': return call('kahin_mirage_go_back', {});
    case 'forward': return call('kahin_mirage_go_forward', {});
    case 'reload': return call('kahin_mirage_reload', {});
    case 'stop': return call('kahin_mirage_stop', {});
    default: return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// The app's own navbar commands -> Kahin
// ---------------------------------------------------------------------------
async function onKahinCommand(w, message) {
  if (!STATE.mcp) await ensureKahin();
  const command = (message && message.command) || {};
  const call = (name, args, timeout) => STATE.mcp.call(name, args || {}, timeout || 90000);
  switch (command.type) {
    case 'navigate': {
      const url = String(command.url || '');
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new Error('invalid navigation url');
      await call('kahin_navigate', { url, wait_until: 'domcontentloaded' });
      pushKahinMeta(w).catch(() => {});
      pushKahinTitle(w).catch(() => {});
      break;
    }
    case 'go-back': await call('kahin_mirage_go_back', {}); break;
    case 'go-forward': await call('kahin_mirage_go_forward', {}); break;
    case 'reload': await call('kahin_mirage_reload', {}); break;
    case 'stop': await call('kahin_mirage_stop', {}); break;
    case 'capture-screenshot': {
      const shot = await call('kahin_screenshot', { full_page: false }, 60000);
      const b64 = shot && (shot.image || shot.screenshot || shot.data);
      if (b64) {
        const { nativeImage, clipboard } = require('electron');
        clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(b64, 'base64')));
      }
      break;
    }
    default: return { ignored: true };
  }
  await pushKahinMeta(w);
  return { ok: true };
}

function normalizeUrl(raw) {
  const url = String(raw || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return 'https://' + url;
}

// ---------------------------------------------------------------------------
// App state messages: the existing URL bar / tab strip consume these as-is.
// ---------------------------------------------------------------------------
function sendMeta(owner, message) {
  try {
    if (!owner || owner.isDestroyed()) return;
    owner.send(FOR_VIEW, message);
  } catch {}
}

function sendNativeMeta(owner) {
  sendMeta(owner, { type: '__kahin_meta', engine: 'native' });
}

// The app's address bar and app-shell tab label are renderer state. Keep them
// in sync from the DOM side; never send browser-sidebar-state (it navigates the
// hidden native webview and breaks the page component).
async function pushKahinMeta(w) {
  if (!STATE.mcp || !w || w.owner.isDestroyed()) return;
  let page = null;
  try { page = await kahinEval('({ url: String(location.href || ""), title: String(document.title || "") })'); } catch {}
  if (!page || typeof page !== 'object') return;
  const url = String(page.url || '');
  const title = String(page.title || '');
  w.lastMetaUrl = url;
  w.lastMetaTitle = title;
  sendMeta(w.owner, { type: '__kahin_meta', engine: 'kahin', url, title });
}

function watchMeta(w) {
  if (w.metaTimer) clearInterval(w.metaTimer);
  w.metaTimer = setInterval(() => {
    if (w.engine !== 'kahin' || w.owner.isDestroyed()) return;
    pushKahinMeta(w).catch(() => {});
  }, 2000);
  w.metaTimer.unref?.();
}

function sendState(w, snapshot) {
  if (!w || w.owner.isDestroyed() || !w.route) return;
  w.sent = (w.sent || 0) + 1;
  w.lastSentAt = Date.now();
  w.owner.send(FOR_VIEW, {
    type: 'browser-sidebar-state',
    conversationId: w.route.conversationId,
    browserTabId: w.route.browserTabId,
    snapshot,
  });
}

async function pushKahinTitle(w) {
  if (!STATE.mcp || !w.route) return;
  try {
    const page = await kahinEval('({ url: location.href, title: document.title })');
    const title = page && page.title ? String(page.title) : (page && page.url ? String(page.url) : '');
    if (!title) return;
    const guest = await resolveGuest(w.owner);
    if (guest) guest.emit('page-title-updated', { preventDefault() {} }, title, false);
  } catch {}
}

async function pushKahinState(w) {
  if (!STATE.mcp || !w.route) return;
  let page = null;
  let navigation = null;
  try { page = await kahinEval('({ url: location.href, title: document.title })'); } catch {}
  try { navigation = await kahinCdp('Page', 'getNavigationHistory', {}); } catch {}
  const url = page && page.url ? String(page.url) : '';
  const title = page && page.title ? String(page.title) : url;
  // The app's native page controller acts on snapshot.url. Sending the Kahin
  // URL would navigate the hidden native webview (and break it on switch back),
  // so the snapshot stays at about:blank; the title carries the Kahin page.
  const snapshot = {
    faviconUrl: null,
    navigation: toNavigation(null, 'about:blank', title),
    runtime: 'electron-webview',
    title,
    updatedAt: Date.now(),
    url: 'about:blank',
  };
  w.lastUrl = url;
  w.lastTitle = title;
  sendState(w, snapshot);
  // The tab strip listens to the guest's page-title-updated, not the state
  // message. Emitting it makes the tab label follow the Kahin page title.
  const guest = await resolveGuest(w.owner);
  if (guest) { try { guest.emit('page-title-updated', { preventDefault() {} }, title, false); } catch {} }
}

function toNavigation(navigation, url, title) {
  if (navigation && Array.isArray(navigation.entries) && navigation.entries.length > 0) {
    const entries = navigation.entries.slice(-50).map((entry) => ({
      title: String(entry.title || entry.url || ''),
      url: String(entry.url || ''),
    }));
    const index = typeof navigation.currentIndex === 'number' ? navigation.currentIndex : entries.length - 1;
    return { currentIndex: Math.max(0, Math.min(index, entries.length - 1)), entries };
  }
  if (!url) return { currentIndex: null, entries: [] };
  return { currentIndex: 0, entries: [{ title, url }] };
}

async function pushNativeState(w) {
  const guest = await resolveGuest(w.owner);
  if (!guest) return;
  const url = guest.getURL() || '';
  const title = guest.getTitle() || url;
  let navigation = null;
  try {
    const history = guest.navigationHistory;
    if (history && typeof history.getAllEntries === 'function') {
      navigation = {
        currentIndex: typeof history.getActiveIndex === 'function' ? history.getActiveIndex() : null,
        entries: history.getAllEntries().slice(-50).map((entry) => ({ title: entry.title || entry.url, url: entry.url })),
      };
    }
  } catch {}
  sendState(w, {
    faviconUrl: null,
    navigation: toNavigation(navigation, url, title),
    runtime: 'electron-webview',
    title,
    updatedAt: Date.now(),
    url,
  });
}

function watchState(w) {
  if (w.stateTimer) clearInterval(w.stateTimer);
  w.stateTimer = setInterval(async () => {
    if (w.engine !== 'kahin' || w.owner.isDestroyed()) return;
    try {
      const page = await kahinEval('({ url: location.href, title: document.title })');
      if (page && (page.url !== w.lastUrl || page.title !== w.lastTitle)) await pushKahinState(w);
    } catch {}
  }, 1200);
  w.stateTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Unified action router
// ---------------------------------------------------------------------------
async function executeBrowserAction(target, payload) {
  const t = target === 'active' ? (STATE.windows.get(primaryOwner()?.id)?.engine || 'native') : target;
  if (t === 'kahin') return kahinAction(payload || {});
  return nativeAction(payload || {});
}

async function kahinAction(p) {
  await ensureKahin();
  const call = (name, args) => STATE.mcp.call(name, args, 120000);
  switch (p.action) {
    case 'navigate': { const r = await call('kahin_navigate', { url: normalizeUrl(p.url), wait_until: p.waitUntil || 'domcontentloaded' }); const w = stateFor(primaryOwner()); if (w.pump) { const b = await overlayRect(w.owner); if (b) startPump(w, b.width, b.height); } pushKahinMeta(w).catch(() => {}); return r; }
    case 'eval': return call(STATE.mcp.pick('kahin_eval', 'kahin_mirage_eval'), { expression: String(p.expression || '') });
    case 'snapshot': return call('kahin_mirage_dom_snapshot', { max_nodes: p.maxNodes || 800 });
    case 'click': return call('kahin_mirage_mouse_click', { x: p.x, y: p.y, button: p.button || 0 });
    case 'type': return call('kahin_mirage_key_text', { text: String(p.text || '') });
    case 'key': return call('kahin_mirage_key_press', { key: p.key, code: p.code || 'Unidentified', key_code: p.keyCode || 0, text: p.text || null });
    case 'scroll': return call('kahin_mirage_scroll', { x: p.x, y: p.y, delta_x: p.dx || 0, delta_y: p.dy || 0 });
    case 'back': return call('kahin_mirage_go_back', {});
    case 'forward': return call('kahin_mirage_go_forward', {});
    case 'reload': return call('kahin_mirage_reload', {});
    case 'stop': return call('kahin_mirage_stop', {});
    default: throw new Error('unsupported kahin action: ' + p.action);
  }
}

const DOM_SNAPSHOT = `(() => {
  const out = [];
  const all = document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]');
  let i = 0;
  for (const el of all) {
    if (i++ > 800) break;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ i: out.length, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null,
      name: (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || (el.textContent || '').trim().slice(0, 80)) || null,
      type: el.getAttribute('type') || null, href: el.getAttribute('href') || null,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return { url: location.href, title: document.title, nodes: out };
})()`;

async function nativeAction(p) {
  const owner = primaryOwner();
  const wc = owner && await resolveGuest(owner);
  if (!wc) throw new Error('native in-app browser is not attached');
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const send = (method, params) => wc.debugger.sendCommand(method, params || {});
  switch (p.action) {
    case 'navigate': await wc.loadURL(normalizeUrl(p.url)); return { ok: true, url: wc.getURL() };
    case 'eval': return send('Runtime.evaluate', { expression: String(p.expression || ''), returnByValue: true, awaitPromise: true });
    case 'snapshot': return send('Runtime.evaluate', { expression: DOM_SNAPSHOT, returnByValue: true });
    case 'click': {
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      const button = p.button === 2 ? 'right' : p.button === 1 ? 'middle' : 'left';
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: 1 });
      return { ok: true };
    }
    case 'type': await send('Input.insertText', { text: String(p.text || '') }); return { ok: true };
    case 'key': {
      const base = { key: p.key, code: p.code || 'Unidentified', windowsVirtualKeyCode: p.keyCode || 0, nativeVirtualKeyCode: p.keyCode || 0 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: p.text || undefined });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return { ok: true };
    }
    case 'scroll': await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: p.dx || 0, deltaY: p.dy || 0 }); return { ok: true };
    case 'back': wc.goBack(); return { ok: true };
    case 'forward': wc.goForward(); return { ok: true };
    case 'reload': wc.reload(); return { ok: true };
    case 'stop': wc.stop(); return { ok: true };
    default: throw new Error('unsupported native action: ' + p.action);
  }
}

// ---------------------------------------------------------------------------
// Programmatic control (unix socket, 0600)
// ---------------------------------------------------------------------------
async function startControlServer() {
  fs.mkdirSync(path.dirname(CONTROL_SOCKET), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(CONTROL_SOCKET); } catch {}
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        handleRpc(req)
          .then((result) => conn.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n'))
          .catch((err) => conn.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 1, message: String(err && err.message || err) } }) + '\n'));
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CONTROL_SOCKET, () => { server.off('error', reject); resolve(); });
  });
  try { fs.chmodSync(CONTROL_SOCKET, 0o600); } catch {}
  STATE.control = server;
  log('control', 'listening ' + CONTROL_SOCKET);
}

async function routeFromDom(owner) {
  try {
    return await owner.executeJavaScript('(() => { const e = document.querySelector("webview[data-browser-sidebar-browser-tab-id]"); return e ? { conversationId: e.getAttribute("data-browser-sidebar-conversation-id"), browserTabId: e.getAttribute("data-browser-sidebar-browser-tab-id") } : null; })()', true);
  } catch { return null; }
}

async function setBrowserPanel(open) {
  const owner = primaryOwner();
  if (!owner) throw new Error('no ChatGPT window');
  const w = stateFor(owner);
  const route = w.route || await routeFromDom(owner);
  // The app's own toggle payload carries the route; without it the panel opens
  // empty and the webview stays hidden.
  owner.send(FOR_VIEW, {
    type: 'toggle-browser-panel',
    open: !!open,
    ...(route && route.browserTabId ? { browserTabId: route.browserTabId } : {}),
    ...(route && route.conversationId ? { conversationId: route.conversationId } : {}),
    url: 'about:blank',
    source: 'manual',
    initiator: 'window_open',
  });
  if (!open) return { open: false };
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(700);
    const guest = await resolveGuest(owner);
    if (guest) return { open: true, attempts: attempt, guestId: guest.id, route: w.route };
  }
  return { open: !!open, attempts: 6, guestId: null, route: w.route };
}

async function domEval(expression) {
  const owner = primaryOwner();
  if (!owner) throw new Error('no ChatGPT window');
  return owner.executeJavaScript(String(expression || ''), true);
}

async function handleRpc(req) {
  const method = req && req.method;
  const params = (req && req.params) || {};
  if (method === 'browser.state') { const owner = primaryOwner(); return snapshot(owner ? stateFor(owner) : null); }
  if (method === 'browser.switch') return switchEngine(params.engine, primaryOwner());
  if (method === 'browser.action') return executeBrowserAction(params.target || 'active', params.payload || {});
  if (method === 'ui.browserPanel') return setBrowserPanel(params.open !== false);
  if (method === 'dom.eval') return domEval(params.expression);
  if (method === 'browser.debug') { const w = stateFor(primaryOwner()); return w ? { engine: w.engine, route: w.route, sent: w.sent || 0, lastSentAt: w.lastSentAt || 0, lastUrl: w.lastUrl, lastTitle: w.lastTitle, kahinError: w.kahinError || null, frameSeq: w.frameSeq, latest: w.latest ? { seq: w.latest.seq, bytes: w.latest.data.length, mimeType: w.latest.mimeType } : null, pump: w.pump ? { frames: w.pump.frames, mode: w.pump.mode, lastError: w.pump.lastError } : null } : null; }
  if (method === 'ui.openTab') { const owner = primaryOwner(); const w = stateFor(owner); const conversationId = params.conversationId || (w.route && w.route.conversationId) || 'client-new-thread:' + randomUUID(); const browserTabId = params.browserTabId || randomUUID(); owner.send(FOR_VIEW, { type: 'open-browser-tab', active: true, browserTabId, conversationId, initialUrl: params.url || 'about:blank', source: 'manual', initiator: 'window_open' }); return { sent: true, conversationId, browserTabId }; }
  if (method === 'ui.closeTab') { const owner = primaryOwner(); const w = stateFor(owner); owner.send(FOR_VIEW, { type: 'close-browser-tab', conversationId: params.conversationId || (w.route && w.route.conversationId), browserTabId: params.browserTabId }); return { sent: true }; }
  if (method === 'ui.emitTitle') { const owner = primaryOwner(); const guest = await resolveGuest(owner); if (!guest) throw new Error('no guest'); const title = String(params.title || 'HYDRAGPT'); guest.emit('page-title-updated', { preventDefault() {} }, title, false); return { emitted: true, title, guestId: guest.id }; }
  if (method === 'ui.state') { const w = stateFor(primaryOwner()); const title = String(params.title || 'HYDRAGPT TEST'); const url = String(params.url || 'https://example.com/'); const conversationId = params.conversationId || (w.route && w.route.conversationId); const browserTabId = params.browserTabId || (w.route && w.route.browserTabId); const snapshot = { faviconUrl: null, navigation: { currentIndex: 0, entries: [{ title, url }] }, runtime: 'electron-webview', title, updatedAt: Date.now(), url }; w.owner.send(FOR_VIEW, { type: 'browser-sidebar-state', conversationId, browserTabId, snapshot }); w.sent = (w.sent || 0) + 1; return { sent: true, conversationId, browserTabId }; }
  if (method === 'browser.pump') { const w = stateFor(primaryOwner()); return w && w.pump ? { frames: w.pump.frames, lastAt: w.pump.lastAt, lastError: w.pump.lastError, mode: w.pump.mode, screencastId: w.pump.screencastId, frameSeq: w.frameSeq, latestSeq: w.latest ? w.latest.seq : 0, latestBytes: w.latest ? w.latest.data.length : 0 } : null; }
  if (method === 'kahin.tool') return ensureKahin().then(() => STATE.mcp.call(params.name, params.args || {}, params.timeoutMs || 60000));
  throw new Error('unknown method: ' + method);
}

module.exports = { install, executeBrowserAction, switchEngine, snapshot };
