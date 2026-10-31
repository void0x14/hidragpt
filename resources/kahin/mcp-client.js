// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// Minimal MCP stdio client for the Kahin server (`kahin` -> python -m kahin.oracle).
// Transport: newline-delimited JSON-RPC 2.0 (MCP stdio).
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Camoufox profile must survive app restarts so cookies/logins persist.
const KAHIN_PROFILE_DIR = process.env.KAHIN_PROFILE_DIR || path.join(os.homedir(), '.kahin', 'camoufox-profile');

// GUI launches do not inherit the shell PATH; prefer the venv python directly
// (skips the pnpm shim + setup probe), then the usual install locations.
function resolveKahin() {
  if (process.env.KAHIN_BIN) return { cmd: process.env.KAHIN_BIN, args: [] };
  const home = os.homedir();
  const kahinHome = process.env.KAHIN_HOME || path.join(home, '.local/share/kahin');
  const venvPython = process.platform === 'win32'
    ? path.join(kahinHome, 'venv', 'Scripts', 'python.exe')
    : path.join(kahinHome, 'venv', 'bin', 'python');
  try { if (fs.existsSync(venvPython)) return { cmd: venvPython, args: ['-m', 'kahin.oracle'] }; } catch {}
  const candidates = [
    path.join(home, '.local/share/pnpm/bin/kahin'),
    path.join(home, '.local/bin/kahin'),
    path.join(home, '.npm-global/bin/kahin'),
    '/usr/local/bin/kahin',
    '/usr/bin/kahin',
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return { cmd: candidate, args: [] }; } catch {}
  }
  return { cmd: 'kahin', args: [] };
}

class KahinMcp {
  constructor(cmd, args) {
    const resolved = cmd ? { cmd, args: args || [] } : resolveKahin();
    this.cmd = resolved.cmd;
    this.args = resolved.args || [];
    this.nextId = 1;
    this.pending = new Map();
    this.proc = null;
    this.starting = null;
    this.ready = false;
    this.toolNames = new Set();
    this.toolSchemas = new Map();
    this.lastError = null;
  }

  state() {
    return this.proc ? 'running' : 'stopped';
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      let child;
      try {
        try { fs.mkdirSync(KAHIN_PROFILE_DIR, { recursive: true, mode: 0o700 }); } catch {}
        child = spawn(this.cmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, KAHIN_PROFILE_DIR } });
      } catch (err) { reject(err); return; }
      this.proc = child;

      readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        if (/error|traceback|exception/i.test(text)) this.lastError = text.trim().slice(0, 800);
      });
      child.once('error', (err) => { this.failAll(err); reject(err); });
      child.once('exit', (code) => {
        this.proc = null;
        this.starting = null;
        this.ready = false;
        this.failAll(new Error('kahin exited with code ' + code));
      });

      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'chatgpt-kahin-bridge', version: '1.0.0' },
      }, 90000).then(async () => {
        this.notify('notifications/initialized', {});
        await this.loadTools();
        resolve();
      }).catch((err) => {
        this.starting = null;
        reject(err);
      });
    });
    return this.starting;
  }

  async loadTools() {
    try {
      const result = await this.request('tools/list', {}, 30000);
      for (const tool of (result && result.tools) || []) {
        this.toolNames.add(tool.name);
        this.toolSchemas.set(tool.name, tool);
      }
    } catch (err) {
      this.lastError = 'tools/list failed: ' + (err && err.message || err);
    }
  }

  has(name) { return this.toolNames.has(name); }

  pick(...names) { for (const name of names) if (this.toolNames.has(name)) return name; return names[names.length - 1]; }

  startArgs(identity) {
    const tool = this.toolSchemas.get('kahin_browser_start');
    const required = (tool && tool.inputSchema && tool.inputSchema.required) || [];
    const properties = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
    const args = {};
    if (properties.headless) args.headless = true; // never create an OS browser window
    if (properties.identity && identity) args.identity = String(identity);
    if (Array.isArray(required) && required.includes('mode')) args.mode = 'ağırbaş';
    return args;
  }

  onLine(line) {
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id == null) return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || 'kahin rpc error'));
    else entry.resolve(msg.result);
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin.writable) { reject(new Error('kahin is not running')); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('kahin rpc timeout: ' + method));
      }, timeoutMs || 120000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (!this.proc || !this.proc.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }

  async call(name, args, timeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args || {} }, timeoutMs || 120000);
    return unwrap(res);
  }

  failAll(err) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  close() {
    if (this.proc) { try { this.proc.kill(); } catch {} }
    this.proc = null;
    this.ready = false;
  }
}

function unwrap(res) {
  if (res == null) return null;
  if (res.isError) {
    const text = contentText(res);
    throw new Error(text || 'kahin tool error');
  }
  if (Array.isArray(res.content)) {
    const image = res.content.find((c) => c.type === 'image');
    if (image) return { image: image.data, mimeType: image.mimeType || 'image/png' };
    const text = contentText(res);
    if (text) {
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  if (res.structuredContent && typeof res.structuredContent === 'object') return res.structuredContent;
  return res;
}

function contentText(res) {
  if (!Array.isArray(res.content)) return '';
  return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

module.exports = { KahinMcp };
