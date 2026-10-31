// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// Injected into the ChatGPT renderer (main world). No extra renderer process:
// the canvas lives in the window that already exists, over the browser panel.
(function () {
  if (window.__kahinOverlay) return 'exists';
  const api = window.electronBridge;
  if (!api || typeof api.sendMessageFromView !== 'function' || typeof api.getFastModeRolloutMetrics !== 'function') return 'no-bridge';

  const state = {
    guestId: 0,
    visible: false,
    root: null,
    canvas: null,
    ctx: null,
    timer: null,
    webview: null,
    remoteW: 0,
    remoteH: 0,
    decoding: false,
    pending: null,
    lastMove: 0,
    frameSeq: 0,
    polling: false,
  };

  function routeOf(el) {
    if (!el || !el.getAttribute) return null;
    const conversationId = el.getAttribute('data-browser-sidebar-conversation-id') || el.getAttribute('data-conversation-id');
    const browserTabId = el.getAttribute('data-browser-sidebar-browser-tab-id');
    return conversationId && browserTabId ? { conversationId, browserTabId } : null;
  }

  function visible(el) {
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return false;
    try { if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false; } catch {}
    const s = getComputedStyle(el);
    if (el.getAttribute('data-kahin-hidden') === '1') return true;
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  }

  function findWebview(guestId) {
    const all = Array.from(document.querySelectorAll('webview'));
    const sidebar = all.filter((el) => el.hasAttribute('data-browser-sidebar-browser-tab-id'));
    const pool = sidebar.length ? sidebar : all;
    if (guestId) {
      const exact = pool.find((el) => { try { return el.getWebContentsId() === guestId && visible(el); } catch { return false; } });
      if (exact) return exact;
    }
    const sized = pool.filter((el) => { const b = el.getBoundingClientRect(); return b.width > 1 && b.height > 1; });
    const shown = sized.filter(visible);
    const pick = (shown.length ? shown : sized).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      // Prefer the panel rect over a 0,0 prewarmed tab, then the larger area.
      const oa = (ra.x > 0 || ra.y > 0) ? 1 : 0, ob = (rb.x > 0 || rb.y > 0) ? 1 : 0;
      if (oa !== ob) return ob - oa;
      return rb.width * rb.height - ra.width * ra.height;
    });
    return pick[0] || null;
  }

  function ensureRoot() {
    if (state.root && document.documentElement.contains(state.root)) return state.root;
    const root = document.createElement('div');
    root.id = '__kahin_overlay';
    root.style.cssText = [
      'position:fixed', 'pointer-events:auto', 'background:#000', 'overflow:hidden',
      'z-index:2147483000', 'display:none', 'contain:strict', 'border-radius:0',
    ].join(';');
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.style.cssText = 'width:100%;height:100%;display:block;outline:none;cursor:default';
    root.appendChild(canvas);
    (document.body || document.documentElement).appendChild(root);
    state.root = root;
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d', { alpha: false });
    bind(canvas);
    return root;
  }

  function place() {
    if (!state.visible) return;
    if (!state.root || !document.documentElement.contains(state.root)) ensureRoot();
    const el = state.webview && document.documentElement.contains(state.webview)
      ? state.webview
      : findWebview(state.guestId);
    if (!el) { if (state.root) state.root.style.display = 'none'; return; }
    state.webview = el;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) { state.root.style.display = 'none'; return; }
    // Do not hide the native webview: the app watches its visibility and breaks
    // its page component when it disappears. The opaque canvas covers it instead.
    const root = state.root;
    root.style.display = 'block';
    root.style.left = Math.round(b.left) + 'px';
    root.style.top = Math.round(b.top) + 'px';
    root.style.width = Math.round(b.width) + 'px';
    root.style.height = Math.round(b.height) + 'px';
    // Keep a correctly sized (black) surface until the first frame arrives.
    if (state.canvas.width < 2 || state.canvas.height < 2) {
      state.canvas.width = Math.max(2, Math.round(b.width));
      state.canvas.height = Math.max(2, Math.round(b.height));
    }
  }

  function draw(frame) {
    state.pending = frame;
    if (state.decoding) return;
    state.decoding = true;
    (async () => {
      while (state.pending) {
        const next = state.pending;
        state.pending = null;
        try {
          const bytes = next.data instanceof Uint8Array ? next.data : new Uint8Array(next.data);
          const blob = new Blob([bytes], { type: next.mimeType || 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          if (state.canvas.width !== bitmap.width || state.canvas.height !== bitmap.height) {
            state.canvas.width = bitmap.width;
            state.canvas.height = bitmap.height;
          }
          state.ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          state.remoteW = next.width || bitmap.width;
          state.remoteH = next.height || bitmap.height;
        } catch {}
      }
      state.decoding = false;
    })();
  }

  // Pull model: ask main for the single latest frame at ~5 fps. Nothing is
  // pushed over the app's message bus, so the app retains no frame data.
  async function pollFrame() {
    if (!state.visible || state.polling) return;
    state.polling = true;
    try {
      const frame = await api.getFastModeRolloutMetrics({ __kahin_frame_request: true });
      if (frame && frame.data && frame.seq && frame.seq !== state.frameSeq) {
        state.frameSeq = frame.seq;
        draw(frame);
      }
    } catch {}
    finally { state.polling = false; }
  }

  function point(event) {
    const b = state.canvas.getBoundingClientRect();
    const w = state.remoteW || state.canvas.width || b.width;
    const h = state.remoteH || state.canvas.height || b.height;
    return {
      x: Math.max(0, Math.round((event.clientX - b.left) / b.width * w)),
      y: Math.max(0, Math.round((event.clientY - b.top) / b.height * h)),
    };
  }

  function send(payload) {
    try { const p = api.sendMessageFromView({ type: '__kahin_input', payload }); if (p && p.catch) p.catch(() => {}); } catch {}
  }

  function bind(canvas) {
    canvas.addEventListener('mousedown', (e) => {
      canvas.focus();
      const p = point(e);
      send({ type: 'click', x: p.x, y: p.y, button: e.button === 2 ? 2 : e.button === 1 ? 1 : 0 });
      e.preventDefault();
    });
    canvas.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - state.lastMove < 40) return;
      state.lastMove = now;
      const p = point(e);
      send({ type: 'move', x: p.x, y: p.y });
    });
    canvas.addEventListener('wheel', (e) => {
      const p = point(e);
      send({ type: 'wheel', x: p.x, y: p.y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey) return;
      if (e.key.length === 1) send({ type: 'text', text: e.key });
      else send({ type: 'key', key: e.key, code: e.code, keyCode: e.keyCode });
      e.preventDefault();
    });
  }

  function attach(guestId) {
    state.guestId = Number(guestId) || 0;
    state.visible = true;
    state.webview = findWebview(state.guestId);
    if (state.webview && !state.webview.__kahinOrigLoadURL) {
      const wv = state.webview;
      // Native toolbar actions must drive Kahin, not the hidden native page.
      wv.__kahinOrigLoadURL = wv.loadURL;
      wv.loadURL = (url) => { send({ type: 'navigate', url: String(url || '') }); return Promise.resolve(); };
      wv.__kahinOrigNav = { goBack: wv.goBack, goForward: wv.goForward, reload: wv.reload, stop: wv.stop, canGoBack: wv.canGoBack, canGoForward: wv.canGoForward };
      wv.goBack = () => { send({ type: 'back' }); return Promise.resolve(); };
      wv.goForward = () => { send({ type: 'forward' }); return Promise.resolve(); };
      wv.reload = () => { send({ type: 'reload' }); return Promise.resolve(); };
      wv.stop = () => { send({ type: 'stop' }); return Promise.resolve(); };
      wv.canGoBack = () => true;
      wv.canGoForward = () => true;
    }
    ensureRoot();
    place();
    if (state.timer) clearInterval(state.timer);
    state.frameSeq = 0;
    state.timer = setInterval(() => { place(); pollFrame(); }, 200);
    const b = state.root.getBoundingClientRect();
    if (state.canvas.width < 2 || state.canvas.height < 2) {
      state.canvas.width = Math.max(2, Math.round(b.width));
      state.canvas.height = Math.max(2, Math.round(b.height));
    }
    send({ type: 'resize', width: Math.round(b.width), height: Math.round(b.height), route: routeOf(state.webview) });
    if (state.canvas) state.canvas.focus();
    return true;
  }

  function detach() {
    state.visible = false;
    state.frameSeq = 0;
    state.polling = false;
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.root) state.root.style.display = 'none';
    if (state.webview) {
      try {
        if (state.webview.__kahinOrigLoadURL) { state.webview.loadURL = state.webview.__kahinOrigLoadURL; delete state.webview.__kahinOrigLoadURL; }
        if (state.webview.__kahinOrigNav) { Object.assign(state.webview, state.webview.__kahinOrigNav); delete state.webview.__kahinOrigNav; }
      } catch {}
    }
    return true;
  }

  function rect() {
    const el = state.webview || findWebview(state.guestId);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.width > 1 && b.height > 1 ? { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) } : null;
  }

  window.__kahinOverlay = { attach, detach, rect };
  // The future switch button (and the user console) call this. Backend does the work.
  window.__kahinEngine = {
    switch(engine) {
      try { const p = api.sendMessageFromView({ type: '__kahin_switch', engine: engine === 'kahin' ? 'kahin' : 'native' }); if (p && p.catch) p.catch(() => {}); } catch {}
    },
    state() { return { attached: state.visible, guestId: state.guestId }; },
  };
  return 'ok';
})();
