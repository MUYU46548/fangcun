/* Mermaid 源码真校验：语法解析 + 真渲染 + 源码↔产物双向对账
 * 用法：node scripts/check-mmd-syntax.mjs <file.mmd>
 * 依赖：mermaid / jsdom / dompurify（装在 node 工作区）
 *   NODE_PATH=C:/Users/muyu/.workbuddy/binaries/node/workspace/node_modules
 */
import fs from 'fs';

// ⚠ 先建 DOMPurify，再 import mermaid —— 顺序错就报 "DOMPurify.sanitize is not a function"
const { purify } = await import('./mmd-domsetup.mjs');
if (typeof purify.sanitize !== 'function' || typeof purify.addHook !== 'function') {
  console.log('RESULT FAIL DOMPurify 实例缺少 sanitize/addHook');
  process.exit(2);
}

// mermaid 同样显式解析（ESM 不认 NODE_PATH）
const NM = process.env.FC_NODE_MODULES || 'C:/Users/muyu/.workbuddy/binaries/node/workspace/node_modules';
// ⚠ 动态 import 不认 Windows 绝对路径，必须转成 file:// URL
const WORKSPACE = 'file:///' + NM.replace(/\\/g, '/');
const mermaid = (await import(WORKSPACE + '/mermaid/dist/mermaid.esm.mjs')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

const src = fs.readFileSync(process.argv[2], 'utf8');
const problems = [];
let svgLen = 0, nodeCount = 0, edgeCount = 0, clusterCount = 0;

try {
  await mermaid.parse(src);
} catch (e) {
  problems.push('语法解析失败: ' + String(e.message).split('\n').slice(0, 5).join(' | '));
}

if (!problems.length) {
  try {
    const { svg } = await mermaid.render('g1', src);
    svgLen = svg.length;
    // mermaid 给节点挂 class="node default ..."，连线挂 class="edgePaths" / 路径 class="... edge-thickness-normal"
    nodeCount = (svg.match(/class="[^"]*\bnode\b[^"]*"/g) || []).length;
    edgeCount = (svg.match(/<path[^>]*class="[^"]*(?:flowchart-link|edge-thickness)[^"]*"/g) || []).length;
    // mermaid 每个 subgraph 会输出 <g class="cluster ..."> 与 <g class="cluster-label">，只数前者
    clusterCount = (svg.match(/class="cluster(?![\w-])[^"]*"/g) || []).length;
  } catch (e) {
    problems.push('渲染失败: ' + String(e.message).split('\n').slice(0, 5).join(' | '));
  }
}

console.log(JSON.stringify({ bytes: src.length, svgLen, nodeCount, edgeCount, clusterCount }, null, 2));
if (problems.length) {
  problems.forEach(x => console.log('  ✗ ' + x));
  console.log('\nRESULT FAIL ' + problems.length + ' 条问题');
  process.exit(2);
}
if (svgLen < 2000) {
  console.log('  ✗ 产出 SVG 过小，疑似空图');
  console.log('\nRESULT FAIL 1 条问题');
  process.exit(2);
}
// ---------- 结构断言：源码 ↔ 渲染产物 双向对账 ----------
// 1) 声明侧：所有 <id>[ 定义 与 所有 <id> 出现在连线上 的集合
const declNodes = new Set([...src.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*[\[(]/gm)].map(m => m[1]));
const declSubs  = (src.match(/subgraph\s/g) || []).length;
// 2) 连线侧：先把标签 |...| 、引号内文字、subgraph 名统统剥掉，只留 id 与箭头
const subIds = new Set([...src.matchAll(/^\s*subgraph\s+([A-Za-z_][\w]*)/gm)].map(m => m[1]));
const edgeIds = new Set();
src.split('\n').forEach(L => {
  let t = L.trim();
  if (!t || t.startsWith('%%') || /^subgraph\b/.test(t) || /^end\b/.test(t)) return;
  if (/^(classDef|class|style|linkStyle|direction|flowchart)\b/.test(t)) return;
  // 剥掉 |标签|（含中英数斜杠空格）
  t = t.replace(/\|[^|]*\|/g, ' ');
  // 剥掉方括号/圆括号/花括号里的节点文字
  t = t.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\{[^}]*\}/g, ' ');
  // 剥掉内联 class/样式
  t = t.replace(/:::?[\w-]+/g, ' ');
  [...t.matchAll(/\b([A-Z][A-Z0-9_]*(?:\d[\w]*)?)\b/g)].forEach(m => {
    const id = m[1];
    if (subIds.has(id)) return;
    if (/^(TB|TD|BT|LR|RL|AMP|EOF)$/.test(id)) return;
    edgeIds.add(id);
  });
});
const dangling = [...edgeIds].filter(id => !declNodes.has(id));
console.log('\n  源码声明: ' + declNodes.size + ' 个节点 / ' + declSubs + ' 个子图 / ' + edgeIds.size + ' 个被连线引用');

// ⚠ 悬空 id 是**静默失败**：mermaid 会把它自动建成节点，不报错、不警告。
//   本断言就是抓这一类"看起来成功了"。
if (dangling.length) {
  console.log('  \u2717 连线引用了未声明的节点 id: ' + dangling.join(', '));
  process.exit(2);
}
if (nodeCount === 0) { console.log('  \u2717 渲染出的 SVG 里一个节点都没有'); process.exit(2); }
if (clusterCount !== declSubs) { console.log('  \u2717 子图数对不上: 渲染 ' + clusterCount + ' vs 声明 ' + declSubs); process.exit(2); }
if (nodeCount !== declNodes.size) { console.log('  \u2717 节点数不相等: 渲染 ' + nodeCount + ' vs 声明 ' + declNodes.size); process.exit(2); }
console.log('\nRESULT PASS Mermaid 语法通过 + 真渲染出 SVG（' + svgLen + ' 字节 / ' + nodeCount + ' 节点 / ' + clusterCount + ' 子图 / ' + edgeCount + ' 连线）');
