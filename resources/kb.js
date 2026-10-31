// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// Injected entry. Must never throw: the 44-byte sourceMappingURL slot is the only
// space we get inside app.asar, so there is no room for a try/catch at the call site.
try {
  console.log('%c ChatGPT × Kahin — by void0x14 ', 'background:#111;color:#dc2626;font-weight:700;padding:2px 6px;border-radius:4px');
  require('./kahin/boot.js').install();
} catch (err) {
  try { console.error('[kahin] boot failed:', err && err.stack || err); } catch {}
}
