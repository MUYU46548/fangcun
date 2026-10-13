/* 悬停态截图：用 CDP 强制 :hover 后截图，产物留档供肉眼复核
 * 用法：node scripts/shot-arch-hover.cjs <html> <outDir>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const HTML = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
fs.mkdirSync(OUT, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));
const PORT = 9500 + (process.pid % 400);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-hover-'));

const cp = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(tmp, 'p'),
  '--window-size=1440,1500', 'about:blank',
]);

const getJSON = u => new Promise((res, rej) =>
  http.get(u, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

const wsConnect = url => new Promise((resolve, reject) => {
  const u = new URL(url);
  const key = Buffer.from('k' + Math.random()).toString('base64');
  const sock = net.connect(+u.port, u.hostname, () => sock.write(
    'GET ' + u.pathname + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\n' +
    'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'));
  let hs = false, buf = Buffer.alloc(0); const L = [];
  sock.on('data', c => {
    buf = Buffer.concat([buf, c]);
    if (!hs) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; hs = true; buf = buf.subarray(i + 4); resolve({ send, on: f => L.push(f), close: () => sock.destroy() }); }
    while (buf.length >= 2) {
      const b1 = buf[1]; let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      const pl = buf.subarray(off, off + len).toString(); buf = buf.subarray(off + len);
      L.forEach(f => f(pl));
    }
  });
  sock.on('error', reject);
  function send(o) {
    const d = Buffer.from(JSON.stringify(o)); const m = Buffer.from([1, 2, 3, 4]); let h;
    if (d.length < 126) { h = Buffer.alloc(6); h[0] = 0x81; h[1] = 0x80 | d.length; m.copy(h, 2); }
    else { h = Buffer.alloc(8); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(d.length, 2); m.copy(h, 4); }
    const mk = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) mk[i] = d[i] ^ m[i % 4];
    sock.write(Buffer.concat([h, mk]));
  }
  setTimeout(() => { if (!hs) reject(new Error('ws timeout')); }, 8000);
});

(async () => {
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try { const t = await getJSON('http://127.0.0.1:' + PORT + '/json'); const p = t.find(x => x.type === 'page' && x.webSocketDebuggerUrl); if (p) { wsUrl = p.webSocketDebuggerUrl; break; } } catch (e) { }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!wsUrl) { console.log('RESULT FAIL CDP 目标未找到'); cp.kill(); process.exit(1); }

  const sock = await wsConnect(wsUrl);
  let id = 0; const P = new Map();
  sock.on(t => { let m; try { m = JSON.parse(t); } catch (e) { return; } if (m.id && P.has(m.id)) { P.get(m.id)(m); P.delete(m.id); } });
  const cmd = (me, pa) => new Promise(r => { const i = ++id; P.set(i, r); sock.send({ id: i, method: me, params: pa || {} }); });

  await cmd('Runtime.enable'); await cmd('DOM.enable'); await cmd('CSS.enable'); await cmd('Page.enable');
  await cmd('Page.navigate', { url: 'file:///' + HTML.replace(/\\/g, '/') });
  await new Promise(r => setTimeout(r, 2500));

  const doc = await cmd('DOM.getDocument', { depth: -1 });
  const root = doc.result.root.nodeId;

  async function shoot(name, selector, index) {
    const q = await cmd('DOM.querySelectorAll', { nodeId: root, selector });
    const nodeId = q.result.nodeIds[index || 0];
    if (!nodeId) { console.log('  ! 选择器无命中: ' + selector); return; }
    await cmd('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
    await new Promise(r => setTimeout(r, 450));
    const r = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('  ✓ ' + file);
    await cmd('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('强制 :hover 后截图：');
  await shoot('hover-lane-core', 'g.lane-group', 2);
  await shoot('hover-card-webapp', 'g.lane-group g.card', 0);
  await shoot('hover-conn-client', 'g.conn', 0);

  sock.close(); cp.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  console.log('\nRESULT PASS 悬停态截图已产出');
})();
