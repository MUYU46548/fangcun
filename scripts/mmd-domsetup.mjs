// mermaid 直接 `import DOMPurify from 'dompurify'`（不读 global）。
// dompurify 的默认导出是**工厂**：未给 window 时是空壳（sanitize 不存在）。
// 解法：把 jsdom 的 window 挂成全局 window 后，再 import dompurify —— 它在模块顶层
// 就会用 globalThis.window 自建实例。所以 jsdom 必须最先建好。
// ESM 不认 NODE_PATH → 显式从 node 工作区解析依赖（可用 FC_NODE_MODULES 覆盖）
const NM = process.env.FC_NODE_MODULES || 'C:/Users/muyu/.workbuddy/binaries/node/workspace/node_modules';
// ⚠ 动态 import 不认 Windows 绝对路径，必须转成 file:// URL
const WORKSPACE = 'file:///' + NM.replace(/\\/g, '/');
const { JSDOM } = await import(WORKSPACE + '/jsdom/lib/api.js').catch(async () => await import(WORKSPACE + '/jsdom/lib/index.js'));

const win = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true }).window;
globalThis.window = win;
globalThis.document = win.document;
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
globalThis.HTMLElement = win.HTMLElement;
globalThis.SVGElement = win.SVGElement;
globalThis.Node = win.Node;
globalThis.Element = win.Element;
globalThis.DocumentFragment = win.DocumentFragment;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.CSSStyleSheet = win.CSSStyleSheet;
globalThis.StyleSheet = win.StyleSheet;
globalThis.DOMParser = win.DOMParser;
globalThis.XMLSerializer = win.XMLSerializer;
globalThis.location = win.location;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.trustedTypes = undefined;

// jsdom 没实现 SVG 的 getBBox / getComputedTextLength / getScreenCTM（渲染布局要用）
const SVGEl = win.SVGElement.prototype;
if (!SVGEl.getBBox) {
  SVGEl.getBBox = function () {
    const t = this.textContent || '';
    const fs = parseFloat((this.getAttribute && this.getAttribute('font-size')) || 14) || 14;
    const w = this.tagName === 'text' ? Math.max(t.length * fs * 0.62, fs) : 100;
    const h = this.tagName === 'text' ? fs * 1.2 : 20;
    return { x: 0, y: 0, width: w, height: h, top: 0, left: 0, right: w, bottom: h, toJSON() { return this; } };
  };
}
if (!SVGEl.getComputedTextLength) SVGEl.getComputedTextLength = function () { return (this.textContent || '').length * 7; };
if (!SVGEl.getSubStringLength) SVGEl.getSubStringLength = function () { return (this.textContent || '').length * 7; };
if (!SVGEl.getScreenCTM) SVGEl.getScreenCTM = function () { return { a:1,b:0,c:0,d:1,e:0,f:0, inverse(){return this;} }; };
if (!SVGEl.getCTM) SVGEl.getCTM = function () { return { a:1,b:0,c:0,d:1,e:0,f:0, inverse(){return this;} }; };
if (!win.SVGElement.prototype.getBoundingClientRect) {
  Object.defineProperty(SVGEl, 'getBoundingClientRect', {
    value: function () { return { x:0,y:0,width:100,height:20,top:0,left:0,right:100,bottom:20 }; },
    configurable: true, writable: true,
  });
}


// 现在 dompurify 才有 window 可用
const mod = await import(WORKSPACE + '/dompurify/dist/purify.cjs.js').catch(async () => await import(WORKSPACE + '/dompurify/dist/purify.es.mjs'));
const purifier = typeof mod.default === 'function' && !mod.default.sanitize
  ? mod.default(win)
  : mod.default;
globalThis.DOMPurify = purifier;
win.DOMPurify = purifier;
export const purify = purifier;
