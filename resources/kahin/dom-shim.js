// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 void0x14 — https://github.com/void0x14
'use strict';
// Minimal CDP DOM/Runtime object shim for the Mirage adapter.
//
// Mirage's Runtime.evaluate ignores returnByValue:false and never returns an
// objectId, so Playwright-style locators cannot hold handles. This shim keeps a
// page-side registry (__kh) and synthesises kh-node-*/kh-obj-* objectIds that
// browser-service.mjs can pass back into Runtime.callFunctionOn / DOM.*.
const BOOTSTRAP = `(() => {
  if (globalThis.__kh) return 'ok';
  const nodes = new Map();
  const objects = new Map();
  const byNode = new WeakMap();
  let nodeSeq = 1;
  let objSeq = 1;
  const reg = (node) => {
    if (node == null) return 0;
    let id = byNode.get(node);
    if (!id) { id = nodeSeq++; byNode.set(node, id); nodes.set(id, node); }
    return id;
  };
  const put = (value) => { const id = 'kh-obj-' + (objSeq++); objects.set(id, value); return id; };
  const get = (id) => {
    if (typeof id !== 'string') return undefined;
    if (id.indexOf('kh-node-') === 0) return nodes.get(Number(id.slice(8)));
    return objects.get(id);
  };
  const attrs = (el) => {
    const out = [];
    if (el.attributes) for (const a of el.attributes) { out.push(a.name); out.push(String(a.value)); }
    return out;
  };
  const ser = (node, depth, cap) => {
    if (node == null || cap.n++ > cap.max) return null;
    const el = node.nodeType === 1;
    const out = {
      nodeId: reg(node),
      backendNodeId: reg(node),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      localName: el ? node.localName : '',
      nodeValue: node.nodeType === 3 ? String(node.nodeValue || '') : '',
      childNodeCount: node.childNodes ? node.childNodes.length : 0,
      attributes: el ? attrs(node) : [],
    };
    if (el) { out.shadowRoots = []; out.frameId = undefined; }
    if (depth !== 0 && node.childNodes && node.childNodes.length) {
      out.children = [];
      for (const child of node.childNodes) {
        const c = ser(child, depth < 0 ? -1 : depth - 1, cap);
        if (c) out.children.push(c);
      }
    }
    return out;
  };
  const fn = (decl) => (typeof decl === 'string' ? (0, eval)('(' + decl + ')') : decl);
  globalThis.__kh = { nodes, objects, reg, put, get, ser, fn };
  return 'ok';
})()`;

class DomShim {
  constructor(api) {
    this.api = api;
    this.scripts = new Map();   // tabId -> [{identifier, source}]
    this.generation = new Map();
  }

  async raw(tab, expression) {
    await this.api.activate(tab);
    const engine = await this.api.mcp();
    return engine.call('kahin_execute_cdp', {
      domain: 'Runtime',
      command: 'evaluate',
      parameters: { expression, returnByValue: true },
    }, 60000);
  }

  async ensure(tab) {
    const res = await this.raw(tab, BOOTSTRAP);
    if (res && res.error) throw new Error(String(res.error));
    return (res && res.result && res.result.value) === 'ok';
  }

  async evalWrapped(tab, expression, returnByValue, awaitPromise) {
    await this.ensure(tab);
    const wrapped = '(async () => { try { const __v = await (' + expression + '); ' +
      'if (__v && (__v.nodeType === 1 || __v.nodeType === 9 || __v.nodeType === 11)) return {__khNode: __kh.reg(__v)}; ' +
      'if (__v !== null && typeof __v === "object") return {__khObj: __kh.put(__v)}; ' +
      'return {__khValue: __v}; } catch (e) { return {__khError: String(e && e.stack || e)}; } })()';
    const res = await this.raw(tab, wrapped);
    return this.unwrap(res, returnByValue);
  }

  unwrap(res, returnByValue) {
    if (!res || res.error) return res;
    const value = res.result && res.result.value;
    if (value == null || typeof value !== 'object') return res;
    if ('__khError' in value) {
      return { result: { type: 'object', subtype: 'error', description: value.__khError }, exceptionDetails: { text: value.__khError } };
    }
    if ('__khNode' in value) {
      const id = 'kh-node-' + value.__khNode;
      return returnByValue === true ? { result: { type: 'object', subtype: 'node', value: null } } : { result: { type: 'object', subtype: 'node', objectId: id } };
    }
    if ('__khObj' in value) return { result: { type: 'object', objectId: value.__khObj } };
    if ('__khValue' in value) {
      const v = value.__khValue;
      const type = v === null ? 'object' : typeof v;
      return { result: v === undefined ? { type: 'undefined' } : { type, value: v } };
    }
    return res;
  }

  async callFunction(tab, params) {
    await this.ensure(tab);
    const objId = params.objectId;
    const decl = params.functionDeclaration;
    const args = (params.arguments || []).map((a) => {
      if (a.objectId) return { __khId: a.objectId };
      if ('unserializableValue' in a) return { value: a.unserializableValue };
      return { value: a.value };
    });
    const wrapped = '(async () => { try { ' +
      'const __this = __kh.get(' + JSON.stringify(objId) + '); ' +
      'const __fn = __kh.fn(' + JSON.stringify(decl) + '); ' +
      'const __args = ' + JSON.stringify(args) + '.map(a => ("__khId" in a) ? __kh.get(a.__khId) : a.value); ' +
      'const __v = await __fn.apply(__this, __args); ' +
      'if (__v && (__v.nodeType === 1 || __v.nodeType === 9 || __v.nodeType === 11)) return {__khNode: __kh.reg(__v)}; ' +
      'if (__v !== null && typeof __v === "object") return {__khObj: __kh.put(__v)}; ' +
      'return {__khValue: __v}; } catch (e) { return {__khError: String(e && e.stack || e)}; } })()';
    const res = await this.raw(tab, wrapped);
    return this.unwrap(res, params.returnByValue);
  }

  async getProperties(tab, params) {
    await this.ensure(tab);
    const wrapped = '(() => { const v = __kh.get(' + JSON.stringify(params.objectId) + '); ' +
      'if (v == null) return []; const out = []; ' +
      'for (const k of Object.getOwnPropertyNames(v).slice(0, 200)) { let val; try { val = v[k]; } catch (e) { continue; } ' +
      'const t = val === null ? "object" : typeof val; ' +
      'out.push({ name: k, enumerable: true, configurable: true, writable: true, value: ' +
      ' (val !== null && typeof val === "object") ? { type: "object", objectId: __kh.put(val) } : (val === undefined ? { type: "undefined" } : { type: t, value: val }) }); } ' +
      'return out; })()';
    const res = await this.raw(tab, wrapped);
    const value = res && res.result && res.result.value;
    return { result: Array.isArray(value) ? value : [] };
  }

  async dom(tab, method, params) {
    await this.ensure(tab);
    const p = params || {};
    switch (method) {
      case 'DOM.getDocument': {
        const depth = Number.isFinite(p.depth) ? p.depth : -1;
        const expr = '(() => ({ root: __kh.ser(document, ' + depth + ', { n: 0, max: 4000 }) }))()';
        const res = await this.raw(tab, expr);
        const value = res && res.result && res.result.value;
        return { root: value && value.root };
      }
      case 'DOM.describeNode': {
        const ref = p.backendNodeId != null ? 'kh-node-' + p.backendNodeId : p.objectId;
        const depth = Number.isFinite(p.depth) ? p.depth : 0;
        const expr = '(() => { const n = __kh.get(' + JSON.stringify(ref) + '); ' +
          'if (!n) throw new Error("Node is gone"); return { node: __kh.ser(n, ' + depth + ', { n: 0, max: 500 }) }; })()';
        const res = await this.raw(tab, expr);
        const value = res && res.result && res.result.value;
        return { node: value && value.node };
      }
      case 'DOM.resolveNode':
        return { object: { objectId: 'kh-node-' + p.backendNodeId } };
      case 'DOM.getBoxModel':
      case 'DOM.getContentQuads': {
        const ref = p.backendNodeId != null ? 'kh-node-' + p.backendNodeId : p.objectId;
        const expr = '(() => { const el = __kh.get(' + JSON.stringify(ref) + '); ' +
          'if (!el || el.nodeType !== 1) throw new Error("Not an element"); ' +
          'const r = el.getBoundingClientRect(); const x = r.left + scrollX, y = r.top + scrollY; ' +
          'const q = [x, y, x + r.width, y, x + r.width, y + r.height, x, y + r.height]; ' +
          'return { content: q, padding: q, border: q, margin: q, width: Math.round(r.width), height: Math.round(r.height) }; })()';
        const res = await this.raw(tab, expr);
        if (method === 'DOM.getContentQuads') {
          const model = res && res.result && res.result.value;
          return { quads: model && model.content ? [model.content] : [] };
        }
        return { model: res && res.result && res.result.value };
      }
      case 'DOM.getNodeForLocation': {
        const expr = '(() => { const el = document.elementFromPoint(' + Number(p.x || 0) + ',' + Number(p.y || 0) + '); ' +
          'return el ? { backendNodeId: __kh.reg(el), nodeId: __kh.reg(el) } : {}; })()';
        const res = await this.raw(tab, expr);
        return (res && res.result && res.result.value) || {};
      }
      case 'DOM.scrollIntoViewIfNeeded': {
        const ref = p.backendNodeId != null ? 'kh-node-' + p.backendNodeId : p.objectId;
        const expr = '(() => { const el = __kh.get(' + JSON.stringify(ref) + '); if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "center" }); return {}; })()';
        return this.raw(tab, expr);
      }
      case 'DOM.getFrameOwner':
        throw new Error('DOM.getFrameOwner is not supported by the Kahin backend');
      default:
        return null;
    }
  }

  async handle(tab, method, params) {
    if (method === 'Runtime.evaluate') {
      const p = params || {};
      if (p.returnByValue === true) return null; // raw forward keeps statements/expressions intact
      return this.evalWrapped(tab, String(p.expression || ''), false, p.awaitPromise === true);
    }
    if (method === 'Runtime.callFunctionOn') return this.callFunction(tab, params || {});
    if (method === 'Runtime.getProperties') return this.getProperties(tab, params || {});
    if (method === 'Runtime.releaseObject') return {};
    if (method.startsWith('DOM.')) return this.dom(tab, method, params);
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      const tabId = tab.id;
      const list = this.scripts.get(tabId) || [];
      const identifier = String(list.length + 1);
      list.push({ identifier, source: String((params && params.source) || '') });
      this.scripts.set(tabId, list);
      await this.raw(tab, String((params && params.source) || '')).catch(() => {});
      return { identifier };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Page.setLifecycleEventsEnabled') return {};
    return null;
  }

  async onNavigated(tab) {
    const scripts = this.scripts.get(tab.id) || [];
    for (const script of scripts) await this.raw(tab, script.source).catch(() => {});
  }
}

module.exports = { DomShim };
