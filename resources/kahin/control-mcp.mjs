#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
// MCP stdio front-end for the ChatGPT Desktop <-> Kahin bridge.
// Forwards tool calls to the bridge's unix socket (~/.kahin/chatgpt-bridge.sock).
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SOCKET = process.env.KAHIN_BRIDGE_SOCK || path.join(os.homedir(), '.kahin', 'chatgpt-bridge.sock');

const TOOLS = [
  {
    name: 'browser_switch',
    description: 'Switch the embedded ChatGPT browser panel between the native Electron engine and Kahin/Mirage.',
    inputSchema: {
      type: 'object',
      properties: { engine: { type: 'string', enum: ['native', 'kahin'] } },
      required: ['engine'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_action',
    description: 'Execute a browser action against the embedded browser (native or kahin).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['active', 'native', 'kahin'], default: 'active' },
        payload: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['navigate', 'eval', 'snapshot', 'click', 'type', 'key', 'scroll'] },
            url: { type: 'string' },
            expression: { type: 'string' },
            x: { type: 'number' }, y: { type: 'number' },
            dx: { type: 'number' }, dy: { type: 'number' },
            text: { type: 'string' },
            key: { type: 'string' }, code: { type: 'string' }, keyCode: { type: 'number' },
            button: { type: 'number' }, maxNodes: { type: 'number' },
          },
          required: ['action'],
          additionalProperties: true,
        },
      },
      required: ['payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_state',
    description: 'Report which engine is active, panel bounds, native guest id and Kahin MCP state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

let nextId = 1;
let buffer = '';
let socket = null;

function connect() {
  return new Promise((resolve, reject) => {
    if (socket && !socket.destroyed) return resolve(socket);
    socket = net.createConnection(SOCKET);
    socket.once('connect', () => {
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          const entry = pending.get(message.id);
          if (!entry) continue;
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message || 'bridge error'));
          else entry.resolve(message.result);
        }
      });
      socket.on('error', (err) => { for (const e of pending.values()) e.reject(err); pending.clear(); });
      socket.on('close', () => { socket = null; });
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

const pending = new Map();

async function rpc(method, params) {
  const conn = await connect();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge timeout: ' + method)); }, 120000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kahin-chatgpt-bridge', version: '1.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      let result;
      if (name === 'browser_switch') result = await rpc('browser.switch', { engine: args.engine });
      else if (name === 'browser_action') result = await rpc('browser.action', { target: args.target || 'active', payload: args.payload || {} });
      else if (name === 'browser_state') result = await rpc('browser.state', {});
      else throw new Error('unknown tool: ' + name);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(err && err.message || err) }] } });
    }
    return;
  }
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try { request = JSON.parse(trimmed); } catch { return; }
  handle(request).catch(() => {});
});
