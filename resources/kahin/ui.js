// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// Persistent engine switch button in the app's own title bar (after Help).
// Injected into every main window; survives re-renders by polling for Help.
(function () {
  if (window.__kahinButton) return 'exists';
  const api = window.electronBridge;
  if (!api || typeof api.sendMessageFromView !== 'function') return 'no-bridge';

  const state = { engine: 'native', pending: false, error: null, lastAt: 0 };
  let button = null;
  let toast = null;
  let toastTimer = null;
  const chrome = {
    engine: 'native', url: '', title: '',
    inputNative: null, inputEl: null,
    tabNative: null, tabAria: null, tabEl: null, applied: false,
  };

  function helpButton() {
    return Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Help') || null;
  }

  function ensureButton() {
    if (button && document.documentElement.contains(button)) return button;
    button = document.createElement('button');
    button.id = '__kahin_engine_switch';
    button.type = 'button';
    button.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'display:flex', 'align-items:center',
      'justify-content:center', 'height:24px', 'padding:0 12px', 'border:0',
      'border-radius:6px', 'font:600 11px/1 system-ui,sans-serif', 'color:#fff',
      'letter-spacing:.04em', 'cursor:pointer', '-webkit-app-region:no-drag',
      'box-shadow:0 1px 4px rgba(0,0,0,.35)', 'transition:background .15s,opacity .15s',
    ].join(';');
    button.addEventListener('click', () => toggle());
    (document.body || document.documentElement).appendChild(button);
    return button;
  }

  function ensureToast() {
    if (toast && document.documentElement.contains(toast)) return toast;
    toast = document.createElement('div');
    toast.id = '__kahin_engine_toast';
    toast.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'pointer-events:none',
      'padding:5px 10px', 'border-radius:6px', 'background:#111', 'color:#eee',
      'font:500 11px/1.2 system-ui,sans-serif', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      'opacity:0', 'transition:opacity .18s',
    ].join(';');
    (document.body || document.documentElement).appendChild(toast);
    return toast;
  }

  function showToast(text, isError) {
    ensureToast();
    toast.textContent = text;
    toast.style.color = isError ? '#fca5a5' : '#eee';
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toast) toast.style.opacity = '0'; }, 2200);
  }

  function render() {
    const btn = ensureButton();
    const kahin = state.engine === 'kahin';
    btn.textContent = state.pending ? '…' : (kahin ? 'HIDRAGPT' : 'NATIVE');
    btn.style.background = state.pending ? '#6b7280' : (kahin ? '#dc2626' : '#2563eb');
    btn.style.opacity = state.pending ? '0.7' : '1';
    btn.title = state.error
      ? 'Switch failed: ' + state.error
      : (kahin ? 'Active engine: HidraGPT (click for Native)' : 'Active engine: Native (click for HidraGPT)');
    place();
  }

  function place() {
    const help = helpButton();
    if (!button || !document.documentElement.contains(button)) ensureButton();
    if (!button) return;
    if (!help) { button.style.display = 'none'; return; }
    const r = help.getBoundingClientRect();
    if (r.width < 2) { button.style.display = 'none'; return; }
    button.style.display = 'flex';
    button.style.left = Math.round(r.right + 16) + 'px';
    button.style.top = Math.round(r.top) + 'px';
    if (toast) {
      toast.style.left = Math.round(r.right + 16) + 'px';
      toast.style.top = Math.round(r.bottom + 6) + 'px';
    }
  }

  function addressInput() {
    const list = Array.from(document.querySelectorAll(
      'input[placeholder*="Search or enter a URL"], input[aria-label*="Search or enter a URL"], input[data-browser-sidebar-address-input="true"]'
    ));
    return list.find((el) => el.offsetWidth > 1 && el.offsetHeight > 1) || list[0] || null;
  }

  function setInputValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(value == null ? '' : value));
  }

  function tabLabel(tab) {
    return tab.querySelector('span[dir="auto"].text-start') || tab.querySelector('span[dir="auto"]') || null;
  }

  function setTabLabel(tab, text) {
    const span = tabLabel(tab);
    if (span) span.textContent = text;
    else {
      const node = Array.from(tab.childNodes).find((n) => n.nodeType === 3 && (n.nodeValue || '').trim());
      if (node) node.nodeValue = text;
    }
    tab.setAttribute('aria-label', text);
  }

  function applyChrome() {
    const input = addressInput();
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (chrome.engine !== 'kahin') {
      if (chrome.applied) {
        if (input && chrome.inputNative !== null) setInputValue(input, chrome.inputNative);
        if (tab && chrome.tabNative !== null) {
          setTabLabel(tab, chrome.tabNative);
          if (chrome.tabAria !== null) tab.setAttribute('aria-label', chrome.tabAria);
        } else if (tab && chrome.tabAria !== null) {
          tab.setAttribute('aria-label', chrome.tabAria);
        }
        chrome.applied = false;
        chrome.inputEl = null;
        chrome.tabEl = null;
      }
      // Track native values so the next Kahin switch restores the right ones.
      if (input) chrome.inputNative = input.value;
      if (tab) {
        const span = tabLabel(tab);
        chrome.tabNative = span ? span.textContent : (tab.textContent || '').trim();
        chrome.tabAria = tab.getAttribute('aria-label');
      }
      return;
    }
    enableNavButtons(true);
    if (input) {
      if (chrome.inputNative === null) chrome.inputNative = input.value;
      chrome.inputEl = input;
      // Do not fight the user while the address bar is focused.
      if (document.activeElement !== input && input.value !== chrome.url) setInputValue(input, chrome.url);
    }
    if (tab && (chrome.url || chrome.title)) {
      chrome.tabEl = tab;
      const label = ('HidraGPT · ' + (chrome.title || chrome.url)).slice(0, 60);
      const span = tabLabel(tab);
      if (!chrome.tabNative && span) chrome.tabNative = span.textContent;
      if (!chrome.tabAria) chrome.tabAria = tab.getAttribute('aria-label');
      if (!span || span.textContent !== label) setTabLabel(tab, label);
      chrome.applied = true;
    }
  }

  function sendInput(payload) {
    try { const p = api.sendMessageFromView({ type: '__kahin_input', payload }); if (p && p.catch) p.catch(() => {}); } catch {}
  }

  // The app's nav buttons are driven by the native webview history, which is
  // empty while Kahin owns the panel. Enable them and forward the clicks.
  document.addEventListener('click', (event) => {
    if (state.engine !== 'kahin' || !event.target || !event.target.closest) return;
    const btn = event.target.closest('button[aria-label], [role="button"][aria-label]');
    if (!btn) return;
    const label = String(btn.getAttribute('aria-label') || '');
    const map = { Back: 'back', Forward: 'forward', Reload: 'reload', Refresh: 'reload', Stop: 'stop' };
    const action = map[label];
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendInput({ type: action });
  }, true);

  function enableNavButtons(active) {
    if (!active) return;
    for (const label of ['Back', 'Forward', 'Reload', 'Refresh']) {
      const btn = document.querySelector('button[aria-label="' + label + '"]');
      if (!btn) continue;
      if (btn.disabled) btn.disabled = false;
      if (btn.getAttribute('aria-disabled') === 'true') btn.removeAttribute('aria-disabled');
    }
  }

  function toggle() {
    if (state.pending) return;
    const next = state.engine === 'kahin' ? 'native' : 'kahin';
    state.pending = true;
    state.error = null;
    render();
    try {
      const p = api.sendMessageFromView({ type: '__kahin_switch', engine: next });
      if (p && p.catch) p.catch(() => {});
    } catch (err) {
      state.pending = false;
      state.error = String(err && err.message || err);
      render();
      showToast('Switch failed', true);
    }
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== '__kahin_state') return;
    state.engine = data.engine === 'kahin' ? 'kahin' : 'native';
    state.pending = false;
    state.error = data.error ? String(data.error) : null;
    state.lastAt = Date.now();
    render();
    if (state.error) showToast('HidraGPT: ' + state.error, true);
    else showToast(state.engine === 'kahin' ? 'HidraGPT active' : 'Native active', false);
  });
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== '__kahin_meta') return;
    chrome.engine = data.engine === 'kahin' ? 'kahin' : 'native';
    if (chrome.engine === 'kahin') {
      chrome.url = String(data.url || '');
      chrome.title = String(data.title || '');
    }
    applyChrome();
  });

  setInterval(() => { place(); applyChrome(); }, 1000);
  render();
  window.__kahinButton = { state: () => ({ ...state }) };
  return 'ok';
})();
