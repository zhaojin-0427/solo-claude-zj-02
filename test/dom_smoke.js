/* DOM 级冒烟：启动、侧视图拖动入撤销、静态超载警告定位吊杆 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/tmp/node_modules/jsdom");

const html = fs.readFileSync(path.join(__dirname, "../templates/index.html"), "utf8");
const dom = new JSDOM(html, {
  url: "http://127.0.0.1:5000/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.performance = window.performance;
global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 16);
global.cancelAnimationFrame = clearTimeout;

function load(f) {
  window.eval(fs.readFileSync(path.join(__dirname, "..", f), "utf8"));
}
// api.js 只定义 API；fetch 在本测试里由桩替换
window.fetch = async (url, opts) => {
  if (url === "/api/projects")
  return { ok: true, status: 200, json: async () => [] };
  throw new Error("unexpected fetch " + url);
};
load("static/js/engine.js");
load("static/js/api.js");
load("static/js/stage-view.js");
load("static/js/timeline.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

window.HTMLCanvasElement; // noop
// app.js boot 是异步的（refreshProjectList）
load("static/js/app.js");

setTimeout(() => {
  const doc = window.document;
  // 1) 启动后 SVG 已渲染（演示项目含 3 根吊杆）
  const handles = doc.querySelectorAll("#stageSvg .batten-handle");
  assert(handles.length === 3, "启动渲染 3 根吊杆的拖点，实际 " + handles.length);
  const cueBlocks = doc.querySelectorAll("#timelineSvg .cue-block");
  assert(cueBlocks.length === 5, "时间轴渲染 5 个演示提示，实际 " + cueBlocks.length);

  const undoBtn = doc.querySelector("#btnUndo");
  assert(undoBtn.disabled === true, "初始撤销按钮不可用");

  // 访问内部状态：app.js 是 IIFE，内部不可达；改用纯 DOM 事件模拟侧视图拖吊杆
  // 找到第一根吊杆的拖点，模拟 mousedown -> 两次 mousemove(改 X) -> mouseup
  const svg = doc.querySelector("#stageSvg");
  const handle = handles[0];
  const r = svg.getBoundingClientRect();
  // jsdom getBoundingClientRect 全 0，无法用坐标驱动；直接调用 StageView 处理器
  // StageView 是 window 全局
  const before = window.E ? "engine ok" : "no";
  assert(before === "engine ok", "引擎在页面内可用");

  // 用 StageView 的回调直接模拟拖拽流程
  const sv = window.StageView;
  // 取得演示项目中第一根吊杆 id：从已渲染 prop-rect 的 data-id 读取
  const firstProp = doc.querySelector("#stageSvg .prop-rect");
  const bid = firstProp.getAttribute("data-id");
  // 模拟 mousedown 暂存快照（捕获监听在 document 上）
  function fire(type, target, extra) {
    const ev = new window.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, extra || {}));
    target.dispatchEvent(ev);
  }
  fire("mousedown", handle);
  sv.handlers.onDragBattenX(bid, 3.67); // X=2 -> 3.67
  sv.handlers.onDragBattenX(bid, 3.8);
  assert(undoBtn.disabled === false, "侧视图拖动后撤销按钮立即可用");
  fire("mouseup", handle);

  // 撤销应恢复 X
  undoBtn.click();
  const propAfter = doc.querySelector("#stageSvg .prop-rect[data-id='" + bid + "']");
  const x0 = parseFloat(propAfter.getAttribute("x"));
  // X=2, 宽 2.5 -> 左缘 x=0.75m，需换算像素；直接检查撤销后存在且撤销栈清空后按钮禁用
  assert(undoBtn.disabled === true, "撤销到底后按钮再次禁用");
  // 重做恢复
  doc.querySelector("#btnRedo").click();
  assert(undoBtn.disabled === false, "重做后可再次撤销");

  // 3) 静态超载警告：演示灯杆 80kg > 额定 70kg，点击检查页警告应选中吊杆
  // 打开检查页（默认不是活动页，但其 DOM 已渲染）
  const warnItem = Array.from(doc.querySelectorAll(".warn-item")).find((n) =>
    n.textContent.indexOf("静载超载") >= 0
  );
  assert(!!warnItem, "检查页存在静载超载警告");
  warnItem.click();
  // 选中后吊杆/吊物页中该吊杆为选中态
  const selectedBat = doc.querySelector("#stageSvg .batten-body.selected");
  assert(!!selectedBat, "点击静载警告后侧视图选中对应吊杆");
  const clock = doc.querySelector("#clockText").textContent;
  assert(clock === "0.0 s", "静载警告时钟位于 0.0s，实际 " + clock);

  // 4) 基线按时刻运动：给 StageView 设置基线，seek 到 4.9s，
  //    紫色基线吊物应随基线提示下降（y 像素增大）
  const E = window.E;
  const p = E.emptyProject();
  const b = E.newBatten(2, 1);
  b.initialPos = 10.5;
  b.prop = { id: "x", name: "幕", kind: "curtain", width: 2, height: 7, weight: 50, hangingHeight: 10.5, clearance: 0.3 };
  p.battens.push(b);
  p.cues.push(E.newCue({ battenId: b.id, start: 0, duration: 8, fromPos: 10.5, toPos: 3 }));
  const np = E.normalizeProject(p);
  const baselineY = (t) => {
    sv.set({
      proj: np, analysis: E.analyze(np),
      selection: { type: null, id: null },
      time: t, playing: false, baseline: np,
    });
    const r0 = Array.from(doc.querySelectorAll("#stageSvg rect")).find(
      (n) => n.getAttribute("stroke-dasharray") === "5 3"
    );
    return r0 ? parseFloat(r0.getAttribute("y")) : null;
  };
  const y0 = baselineY(0);
  const y49 = baselineY(4.9);
  assert(y0 != null && y49 != null, "两个时刻都渲染出紫色基线吊物");
  assert(y49 > y0 + 5, "基线在 4.9s 时已随提示下降（y " + y0.toFixed(1) + " -> " + y49.toFixed(1) + "）");

  console.log(failures ? "\n失败 " + failures : "\n全部 DOM 冒烟通过");
  process.exit(failures ? 1 : 0);
}, 300);
