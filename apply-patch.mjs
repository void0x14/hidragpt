#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
// Linux only: macOS code signature + asar integrity validation make byte patching invalid.
// Patches app.asar in place-of-copy by overwriting the sourceMappingURL
// comment at the end of .vite/build/early-bootstrap.js. No header/offset rewrite,
// no repack. Login/network are untouched; only the main entry gains one require.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_SOURCE = '/usr/lib/chatgpt/resources/app.asar';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const RESOURCES = path.join(ROOT, 'resources');
const INJECT = ';require(process.resourcesPath+"/kb")';
const TARGET = ['.vite', 'build', 'early-bootstrap.js'];

function usage(code = 0) {
  console.log(`usage: node apply-patch.mjs [--source <app.asar>] [--out <dir>] [--force] [--check]
  default --source ${DEFAULT_SOURCE}
  default --out    ${path.join(ROOT, 'build')}`);
  process.exit(code);
}

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
if (args.includes('--help')) usage(0);
const SOURCE = path.resolve(arg('--source', DEFAULT_SOURCE));
const OUT_DIR = path.resolve(arg('--out', path.join(ROOT, 'build')));
const FORCE = args.includes('--force');
const CHECK = args.includes('--check');

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const bufferSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  fs.readSync(fd, json, 0, jsonSize, 16);
  return { base: 8 + bufferSize, json: JSON.parse(json.toString('utf8')) };
}

function entryFor(header) {
  let node = header.json.files;
  for (const key of TARGET) {
    node = node && node[key];
    if (!node) return null;
    if ('files' in node) node = node.files;
  }
  return node && typeof node.offset !== 'undefined' ? node : null;
}

const COMMENT = '//# sourceMappingURL=early-bootstrap.js.map';
const SLOT = Buffer.byteLength(COMMENT);

function patchOffset(entry, base) {
  return base + Number(entry.offset) + Number(entry.size) - SLOT;
}

const srcFd = fs.openSync(SOURCE, 'r');
const header = readHeader(srcFd);
const entry = entryFor(header);
if (!entry) { console.error('early-bootstrap.js not found in asar header'); process.exit(1); }
const offset = patchOffset(entry, header.base);
const tail = Buffer.alloc(SLOT);
fs.readSync(srcFd, tail, 0, SLOT, offset);
const tailText = tail.toString('latin1');
const already = tailText.startsWith(';require');
if (!already && tailText !== COMMENT) {
  console.error('unexpected entry tail, refusing to patch:', JSON.stringify(tailText));
  process.exit(1);
}
fs.closeSync(srcFd);

if (CHECK) {
  console.log(JSON.stringify({ source: SOURCE, patched: already, offset, entrySize: entry.size, base: header.base }, null, 2));
  process.exit(already ? 0 : 1);
}
if (already) { console.error('source is already patched'); process.exit(1); }

const payload = Buffer.from(INJECT + ' '.repeat(SLOT - INJECT.length), 'latin1');
if (payload.length !== SLOT) { console.error('injection length mismatch'); process.exit(1); }

fs.mkdirSync(OUT_DIR, { recursive: true });
const outAsar = path.join(OUT_DIR, 'app.asar');
if (fs.existsSync(outAsar) && !FORCE) { console.error(outAsar + ' exists; pass --force'); process.exit(1); }

fs.copyFileSync(SOURCE, outAsar);
const outFd = fs.openSync(outAsar, 'r+');
fs.writeSync(outFd, payload, 0, SLOT, offset);

const verify = Buffer.alloc(SLOT);
fs.readSync(outFd, verify, 0, SLOT, offset);
if (verify.toString('latin1') !== payload.toString('latin1')) { console.error('readback verification failed'); process.exit(1); }
fs.closeSync(outFd);

const outResources = path.join(OUT_DIR, 'resources');
fs.rmSync(outResources, { recursive: true, force: true });
fs.cpSync(RESOURCES, outResources, { recursive: true });
const digest = crypto.createHash('sha256').update(fs.readFileSync(outAsar)).digest('hex');
const before = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex');

console.log(JSON.stringify({
  source: SOURCE,
  output: outAsar,
  sourceSha256: before,
  patchedSha256: digest,
  injectedAt: offset,
  copied: fs.readdirSync(path.join(OUT_DIR, 'resources')),
}, null, 2));
console.log(`
install (keeps a backup):
  sudo cp ${SOURCE} ${SOURCE}.bak-kahin
  sudo cp ${outAsar} ${SOURCE}
  sudo cp -r ${path.join(OUT_DIR, 'resources')}/* ${path.dirname(SOURCE)}/
  sudo chown root:root ${SOURCE} ${path.join(path.dirname(SOURCE), 'kb.js')}
`);
