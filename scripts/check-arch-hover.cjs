/* 无头浏览器「纯 CSS 交互」真验证：用 CDP 强制 :hover / :focus-within，
 * 读回计算样式，证明交互真的生效（不是"写了 CSS 就当它生效"）。
 * 用法：node check-arch-hover.cjs <html路径>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HTML = path.resolve(process.argv[2]);
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

const PORT = 9333 + (process.pid % 500);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-hover-'));

const cp = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(tmp, 'prof'),
  '--window-size=1440,1200',
  'about:blank',
]);

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let b = '';
      r.on('data', d => b += d);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function waitTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await getJSON('http://127.0.0.1:' + PORT + '/json');
      const page = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('CDP target not found');
}

// 极简 WebSocket 客户端（避免依赖 ws 包）
function wsConnect(url) {
  const u = new URL(url);
  const key = Buffer.from(String(Math.random())).toString('base64');
  const net = require('net');
  return new Promise((resolve, reject) => {
    const sock = net.connect(+u.port, u.hostname, () => {
      sock.write(
        'GET ' + u.pathname + ' HTTP/1.1\r\n' +
        'Host: ' + u.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    let handshaked = false, buf = Buffer.alloc(0);
    const listeners = [];
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshaked) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        handshaked = true;
        buf = buf.subarray(idx + 4);
        resolve({ send, onMessage, close: () => sock.destroy() });
      }
      // 解析帧（只处理小文本帧 + 掩码）
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len).toString('utf8');
        buf = buf.subarray(off + len);
        listeners.forEach(fn => fn(payload));
      }
    });
    sock.on('error', reject);
    function send(obj) {
      const data = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = Buffer.from([1, 2, 3, 4]);
      let header;
      if (data.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81; header[1] = 0x80 | data.length;
        mask.copy(header, 2);
      } else {
        header = Buffer.alloc(8);
        header[0] = 0x81; header[1] = 0x80 | 126;
        header.writeUInt16BE(data.length, 2);
        mask.copy(header, 4);
      }
      const masked = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
      sock.write(Buffer.concat([header, masked]));
    }
    function onMessage(fn) { listeners.push(fn); }
    setTimeout(() => { if (!handshaked) reject(new Error('ws handshake timeout')); }, 8000);
  });
}

(async () => {
  let problems = [], info = {}, pass = [];
  let ws;
  try {
    const wsUrl = await waitTarget();
    ws = await wsConnect(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onMessage(txt => {
      let m; try { m = JSON.parse(txt); } catch (e) { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const cmd = (method, params) => new Promise(res => {
      const mid = ++id; pending.set(mid, res);
      ws.send({ id: mid, method, params: params || {} });
    });
    const evaluate = async (expr) => {
      const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
      return r.result && r.result.result ? r.result.result.value : undefined;
    };

    await cmd('Runtime.enable');
    await cmd('DOM.enable');
    await cmd('CSS.enable');

    // 连上后再导航（避免 --virtual-time-budget 抢跑导致 target 列表为空）
    await cmd('Page.enable');
    await cmd('Page.navigate', { url: 'file:///' + HTML.replace(/\\/g, '/') });
    await new Promise(r => setTimeout(r, 2200));

    // ---- 1) 悬停「核心服务层」：层填充/描边必须变化 ----
    // ⚠ 规则写作 `.lane-group:hover .lane`（后代选择器）→ forcePseudoState 必须作用在
    //   `g.lane-group` 本体上。作用在子元素 rect.lane 上会得到"点不动"的假红。
    const beforeLane = await evaluate(`(() => {
      const g = document.querySelectorAll('g.lane-group')[0];
      const r = g.querySelector('rect.lane');
      const cs = getComputedStyle(r);
      return { fill: cs.fill, strokeOpacity: cs.strokeOpacity };
    })()`);

    const laneDoc = await cmd('DOM.getDocument', { depth: -1 });
    const laneNode = await cmd('DOM.querySelector', {
      nodeId: laneDoc.result.root.nodeId,
      selector: 'g.lane-group',
    });
    await cmd('CSS.forcePseudoState', { nodeId: laneNode.result.nodeId, forcedPseudoClasses: ['hover'] });
    await new Promise(r => setTimeout(r, 350));

    const afterLane = await evaluate(`(() => {
      const g = document.querySelectorAll('g.lane-group')[0];
      const r = g.querySelector('rect.lane');
      const cs = getComputedStyle(r);
      return { fill: cs.fill, strokeOpacity: cs.strokeOpacity };
    })()`);

    info.laneFillBefore = beforeLane.fill;
    info.laneFillAfter = afterLane.fill;
    if (beforeLane.fill === afterLane.fill) {
      problems.push('悬停层容器：fill 没变化（CSS hover 未生效）');
    } else {
      pass.push('悬停层容器 → fill 变化 ' + beforeLane.fill + ' → ' + afterLane.fill);
    }
    if (parseFloat(afterLane.strokeOpacity) <= parseFloat(beforeLane.strokeOpacity)) {
      problems.push('悬停层容器：描边不透明度未提升');
    } else {
      pass.push('悬停层容器 → stroke-opacity ' + beforeLane.strokeOpacity + ' → ' + afterLane.strokeOpacity);
    }
    await cmd('CSS.forcePseudoState', { nodeId: laneNode.result.nodeId, forcedPseudoClasses: [] });

    // ---- 2) 悬停节点卡片：滤镜发光 + 描边变色 ----
    // 规则是 `.card:hover .card-body` → 同样必须作用在 g.card 本体
    const cardNode = await cmd('DOM.querySelector', {
      nodeId: laneDoc.result.root.nodeId,
      selector: 'g.lane-group g.card',
    });
    const beforeCard = await evaluate(`(() => {
      const c = document.querySelectorAll('g.lane-group')[0].querySelector('rect.card-body');
      const cs = getComputedStyle(c);
      return { stroke: cs.stroke, filter: cs.filter, fill: cs.fill };
    })()`);
    await cmd('CSS.forcePseudoState', { nodeId: cardNode.result.nodeId, forcedPseudoClasses: ['hover'] });
    await new Promise(r => setTimeout(r, 350));
    const afterCard = await evaluate(`(() => {
      const c = document.querySelectorAll('g.lane-group')[0].querySelector('rect.card-body');
      const cs = getComputedStyle(c);
      return { stroke: cs.stroke, filter: cs.filter, fill: cs.fill };
    })()`);
    info.cardBefore = beforeCard; info.cardAfter = afterCard;
    if (beforeCard.stroke === afterCard.stroke && beforeCard.filter === afterCard.filter) {
      problems.push('悬停节点：描边与滤镜都没变化（CSS hover 未生效）');
    } else {
      pass.push('悬停节点 → stroke ' + beforeCard.stroke + ' → ' + afterCard.stroke);
      pass.push('悬停节点 → filter ' + (afterCard.filter || 'none').slice(0, 60));
    }
    if (!afterCard.filter || afterCard.filter === 'none') {
      problems.push('悬停节点：未产生发光（filter 为空）');
    }
    await cmd('CSS.forcePseudoState', { nodeId: cardNode.result.nodeId, forcedPseudoClasses: [] });

    // ---- 3) 悬停连线：stroke-width 必须加粗 ----
    // 规则是 `.conn:hover .wire` → 作用在 g.conn 本体
    const wireNode = await cmd('DOM.querySelector', {
      nodeId: laneDoc.result.root.nodeId,
      selector: 'g.conn',
    });
    const wBefore = await evaluate(`getComputedStyle(document.querySelector('g.conn path.wire')).strokeWidth`);
    await cmd('CSS.forcePseudoState', { nodeId: wireNode.result.nodeId, forcedPseudoClasses: ['hover'] });
    await new Promise(r => setTimeout(r, 300));
    const wAfter = await evaluate(`getComputedStyle(document.querySelector('g.conn path.wire')).strokeWidth`);
    info.wireBefore = wBefore; info.wireAfter = wAfter;
    if (parseFloat(wAfter) <= parseFloat(wBefore)) {
      problems.push('悬停连线：stroke-width 未加粗 ' + wBefore + ' → ' + wAfter);
    } else {
      pass.push('悬停连线 → stroke-width ' + wBefore + ' → ' + wAfter);
    }
    await cmd('CSS.forcePseudoState', { nodeId: wireNode.result.nodeId, forcedPseudoClasses: [] });

    // ---- 4) 零 JS 纪律：文档里不许有 <script> ----
    const scriptCount = await evaluate(`document.querySelectorAll('script').length`);
    info.scriptCount = scriptCount;
    if (scriptCount !== 0) {
      problems.push('页面存在 ' + scriptCount + ' 个 <script>（要求零 JS）');
    } else {
      pass.push('零 JS 纪律 → 文档内 <script> 数量 = 0');
    }

    // ---- 5) 零外部依赖：不许有外链（含 @import / url() / a[href] 等全部可能拉外网的入口）----
    const external = await evaluate(`(() => {
      const out = [];
      // DOM 层：任何会发起网络请求的引用
      document.querySelectorAll('[href],[src],[data],[srcset],[poster]').forEach(e => {
        ['href','src','data','srcset','poster'].forEach(a => {
          const v = e.getAttribute && e.getAttribute(a);
          if (v && /^(https?:)?\\/\\//i.test(v.trim())) out.push(e.tagName + '[' + a + ']=' + v);
        });
      });
      // CSS 层：@import 与 url() 同样能拉外网
      for (const ss of document.styleSheets) {
        let rules = [];
        try { rules = [...ss.cssRules]; } catch (e) { continue; }
        for (const r of rules) {
          const txt = r.cssText || '';
          if (/@import/i.test(txt)) out.push('@import ' + txt.slice(0, 80));
          const urls = txt.match(/url\\(\\s*['"]?(https?:)?\\/\\/[^)'"]+/gi);
          if (urls) urls.forEach(u => out.push('url() ' + u.slice(0, 80)));
        }
      }
      return out;
    })()`);
    info.externalRefs = external;
    if (external.length) {
      problems.push('存在外部引用: ' + external.join(', '));
    } else {
      pass.push('零外部依赖 → DOM 引用 + CSS @import/url() 均无外网地址');
    }

    // ---- 6) 交互纯 CSS：CSS 里必须有 :hover 规则，且没有内联事件属性 ----
    const cssRules = await evaluate(`(() => {
      let n = 0;
      for (const ss of document.styleSheets) {
        try { for (const r of ss.cssRules) if (r.cssText && r.cssText.includes(':hover')) n++; } catch (e) {}
      }
      return n;
    })()`);
    const inlineHandlers = await evaluate(`document.querySelectorAll('[onclick],[onmouseover],[onload]').length`);
    info.hoverRuleCount = cssRules;
    info.inlineHandlers = inlineHandlers;
    if (cssRules < 3) problems.push(':hover 规则过少 ' + cssRules);
    else pass.push('纯 CSS 交互 → ' + cssRules + ' 条 :hover 规则，内联事件属性 ' + inlineHandlers + ' 处');
    if (inlineHandlers !== 0) problems.push('存在内联事件属性 ' + inlineHandlers + ' 处');
  } catch (e) {
    problems.push('执行异常: ' + e.message);
  } finally {
    if (ws) ws.close();
    cp.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(JSON.stringify(info, null, 2));
  console.log('');
  pass.forEach(p => console.log('  ✓ ' + p));
  if (problems.length === 0) {
    console.log('\nRESULT PASS ' + pass.length + ' 条通过 / 0 条问题');
  } else {
    console.log('');
    problems.forEach(p => console.log('  ✗ ' + p));
    console.log('\nRESULT FAIL ' + problems.length + ' 条问题');
    process.exit(2);
  }
})();
