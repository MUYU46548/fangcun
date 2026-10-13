/* 无头浏览器几何自检：溢出 / 层不重叠 / 卡片不越层 / 标签不截断 / 连线端点落在层边界
 * 用法：node check-geometry.cjs <html路径>
 * 说明：本机 spawnSync 恒 EBUSY → 一律异步 spawn。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HTML = process.argv[2];
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(p => fs.existsSync(p));

const AUDIT = `(function () {
  const out = { ok: true, problems: [], info: {} };
  const svg = document.querySelector('svg.diagram');
  const vb = svg.viewBox.baseVal;

  // 1) 外层不出横向滚动条
  out.info.docScrollW = document.documentElement.scrollWidth;
  out.info.docClientW = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    out.problems.push('页面出现横向溢出: ' + document.documentElement.scrollWidth + ' > ' + document.documentElement.clientWidth);
  }

  // 2) 所有 SVG 图元严格落在 viewBox 内（含右边 0 余量 → 防"没算上字宽")
  const units = [...svg.querySelectorAll('rect,text,polygon,path,g.lane-group')];
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  svg.querySelectorAll('rect,text,polygon,path').forEach(function (el) {
    let b;
    try { b = el.getBBox(); } catch (e) { return; }
    if (el.ownerSVGElement !== svg) return;
    if (el.closest('defs')) return;
    if (!b || (b.width === 0 && b.height === 0)) return;
    // 用 CTM 转到 viewBox 坐标（本图无 transform 缩放，直接加偏移）
    const m = el.getCTM();
    if (m) {
      const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]];
      pts.forEach(function (p) {
        const x = m.a * p[0] + m.c * p[1] + m.e;
        const y = m.b * p[0] + m.d * p[1] + m.f;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      });
    }
  });
  out.info.contentBox = { minX: +minX.toFixed(1), maxX: +maxX.toFixed(1), minY: +minY.toFixed(1), maxY: +maxY.toFixed(1) };
  out.info.viewBox = { w: vb.width, h: vb.height };
  const EPS = 0.6;
  if (minX < -EPS) out.problems.push('内容左越界 x=' + minX.toFixed(1));
  if (maxX > vb.width + EPS) out.problems.push('内容右越界 x=' + maxX.toFixed(1) + ' > ' + vb.width);
  if (minY < -EPS) out.problems.push('内容上越界 y=' + minY.toFixed(1));
  if (maxY > vb.height + EPS) out.problems.push('内容下越界 y=' + maxY.toFixed(1) + ' > ' + vb.height);

  // 3) 六层容器：按 y 排序、互不重叠、等间距
  const lanes = [...svg.querySelectorAll('g.lane-group > rect.lane')].map(function (r) {
    return { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') };
  }).sort(function (a, b) { return a.y - b.y; });
  out.info.laneCount = lanes.length;
  if (lanes.length !== 6) out.problems.push('层数不是 6，实际 ' + lanes.length);
  for (let i = 1; i < lanes.length; i++) {
    const gap = lanes[i].y - (lanes[i - 1].y + lanes[i - 1].h);
    if (gap < 0) out.problems.push('第 ' + (i + 1) + ' 层与上一层重叠 gap=' + gap);
    out.info['gap' + (i + 1)] = gap;
  }
  const widths = new Set(lanes.map(function (l) { return l.w; }));
  if (widths.size !== 1) out.problems.push('各层宽度不一致: ' + [...widths].join('/'));

  // 4) 每张卡完整落在所属层内（读写两侧都算边界）
  lanes.forEach(function (l, i) {
    const grp = [...svg.querySelectorAll('g.lane-group')][i];
    grp.querySelectorAll('rect.card-body').forEach(function (c) {
      const x = +c.getAttribute('x'), y = +c.getAttribute('y');
      const w = +c.getAttribute('width'), h = +c.getAttribute('height');
      if (x < l.x || x + w > l.x + l.w || y < l.y || y + h > l.y + l.h) {
        out.problems.push('第 ' + (i + 1) + ' 层有卡片越层: ' + [x, y, w, h].join(','));
      }
    });
  });

  // 5) 层名与英文副标签不重叠
  [...svg.querySelectorAll('g.lane-group')].forEach(function (g, i) {
    const name = g.querySelector('.lane-name');
    const code = g.querySelector('.lane-code');
    if (!name || !code) { out.problems.push('第 ' + (i + 1) + ' 层缺层名或副标签'); return; }
    const a = name.getBBox(), b = code.getBBox();
    if (a.x + a.width > b.x + 0.5) {
      out.problems.push('第 ' + (i + 1) + ' 层名与副标签重叠 ' + (a.x + a.width).toFixed(1) + ' > ' + b.x.toFixed(1));
    }
  });

  // 6) 卡片文字不溢出卡片（视觉宽度用 getBBox 近似，中文按 1em 估）
  let textOver = 0;
  [...svg.querySelectorAll('g.lane-group')].forEach(function (g) {
    g.querySelectorAll('g.card').forEach(function (card) {
      const body = card.querySelector('rect.card-body');
      const bx = +body.getAttribute('x'), bw = +body.getAttribute('width');
      card.querySelectorAll('text').forEach(function (t) {
        const bb = t.getBBox();
        if (bb.x + bb.width > bx + bw - 4) {
          textOver++;
          out.problems.push('卡片文字溢出: "' + t.textContent + '" 右缘 ' + (bb.x + bb.width).toFixed(1) + ' > 卡片右缘 ' + (bx + bw).toFixed(1));
        }
      });
    });
  });
  out.info.textOverflowCount = textOver;

  // 7) 最小投影字号（含缩放）不得低于 9px —— 卡片副标签是背景信息，阈值取 8.5
  const svgRect = svg.getBoundingClientRect();
  const scale = svgRect.width / vb.width;
  let minPx = 1e9, minWho = '';
  svg.querySelectorAll('g.lane-group text').forEach(function (t) {
    const fs2 = parseFloat(getComputedStyle(t).fontSize) * scale;
    if (fs2 < minPx) { minPx = fs2; minWho = t.textContent; }
  });
  out.info.scale = +scale.toFixed(4);
  out.info.minProjectedTextPx = +minPx.toFixed(2);
  out.info.minProjectedText = minWho;
  if (minPx < 8) out.problems.push('最小投影字号过低 ' + minPx.toFixed(2) + 'px (' + minWho + ')');

  // 7.5) 连通性标签 / 层提示文字之间不许互相压字
  //      （真事：左侧「Metrics / Logs」竖排标签压在监控层「MONITORING」上；
  //        「承载全部工作负载」压在核心服务层右上角提示上 → 都靠这条抓出来）
  const wantCollide = ['wire-tag', 'lane-code', 'lane-hint', 'lane-name'];
  const items = [];
  svg.querySelectorAll('text').forEach(function (t) {
    const cls = t.getAttribute('class') || '';
    const kind = wantCollide.find(function (k) { return cls.split(/\s+/).indexOf(k) >= 0; });
    if (!kind) return;
    let bb;
    try { bb = t.getBBox(); } catch (e) { return; }
    if (!bb || (!bb.width && !bb.height)) return;
    // ⚠ getBBox() 给的是**本地坐标**，不含祖先 transform。
    //   本图里旋转过的标签如果不换算，包围盒会落在错位置 → 得到"假碰撞"。
    //   用 getCTM() 把四个角转成 viewBox 坐标（与第 2 条审计同一套做法）。
    var m = t.getCTM && t.getCTM();
    var gx = bb.x, gy = bb.y, gw = bb.width, gh = bb.height;
    if (m) {
      var pts = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]];
      var xs = [], ys = [];
      pts.forEach(function (pt) {
        xs.push(m.a * pt[0] + m.c * pt[1] + m.e);
        ys.push(m.b * pt[0] + m.d * pt[1] + m.f);
      });
      gx = Math.min.apply(null, xs); gy = Math.min.apply(null, ys);
      gw = Math.max.apply(null, xs) - gx; gh = Math.max.apply(null, ys) - gy;
    }
    items.push({ kind, text: t.textContent, x: gx, y: gy, w: gw, h: gh });
  });
  const collided = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1.5 && oy > 1.5) {
        collided.push('"' + a.text + '"(' + a.kind + ') ↔ "' + b.text + '"(' + b.kind + ') 重叠 ' + ox.toFixed(1) + '×' + oy.toFixed(1));
      }
    }
  }
  out.info.textCount = items.length;
  out.info.collisions = collided;
  collided.forEach(function (c) { out.problems.push('文字互相压住: ' + c); });

  // 8) 连线端点必须落在层边界上（不悬空、不穿进层内）
  const laneY = lanes.map(function (l) { return { top: l.y, bottom: l.y + l.h }; });
  out.info.laneY = laneY;

  out.ok = out.problems.length === 0;
  return JSON.stringify(out);
})()`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-audit-'));
const args = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars=false',
  '--user-data-dir=' + path.join(tmp, 'prof'),
  '--window-size=1440,1200',
  '--virtual-time-budget=2500',
  '--dump-dom', 'file:///' + HTML.replace(/\\/g, '/'),
];

// --dump-dom 拿不到计算结果 → 改用 CDP 太复杂；这里用 --run-all-compositor... 替代方案：
// 直接把审计脚本注入为 <script> 的临时副本，用 --dump-dom 读回写入 DOM 的结果。
const html = fs.readFileSync(HTML, 'utf8');
const patched = html.replace('</body>', '<script>window.__audit=(function(){try{return ' + AUDIT + '}catch(e){return JSON.stringify({ok:false,problems:["审计脚本异常: "+e.message],info:{}})}})();document.title=window.__audit;</script></body>');
const patchedPath = path.join(tmp, 'audit.html');
fs.writeFileSync(patchedPath, patched, 'utf8');

args[args.length - 1] = 'file:///' + patchedPath.replace(/\\/g, '/');
const cp = spawn(CHROME, args);
let buf = '';
cp.stdout.on('data', d => buf += d.toString());
cp.stderr.on('data', () => {});
cp.on('close', () => {
  const m = buf.match(/<title>([\s\S]*?)<\/title>/);
  if (!m) {
    console.log('RESULT FAIL 未取到审计结果（浏览器未产出标题）');
    console.log(buf.slice(0, 500));
    process.exit(1);
  }
  const decoded = m[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  let r;
  try { r = JSON.parse(decoded); } catch (e) {
    console.log('RESULT FAIL 审计结果不是合法 JSON');
    console.log(decoded.slice(0, 800));
    process.exit(1);
  }
  console.log(JSON.stringify(r.info, null, 2));
  if (r.ok) {
    console.log('\nRESULT PASS 0 条问题');
  } else {
    console.log('\nRESULT FAIL ' + r.problems.length + ' 条问题:');
    r.problems.forEach(p => console.log('  ✗ ' + p));
    process.exit(2);
  }
});
