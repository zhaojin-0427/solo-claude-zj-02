/* 配重换装单 DOM 冒烟：演示单渲染、编排、告警定位、状态按钮 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/tmp/node_modules/jsdom");

const html = fs.readFileSync(path.join(__dirname, "../templates/counterweight.html"), "utf8");
const dom = new JSDOM(html, {
  url: "http://127.0.0.1:5000/cw",
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
window.fetch = async (url, opts) => {
  if (url === "/api/projects") return { ok: true, status: 200, json: async () => [] };
  if (url === "/api/cw/sheets" && (!opts || !opts.method))
    return { ok: true, status: 200, json: async () => [] };
  throw new Error("unexpected fetch " + url + " " + (opts && opts.method));
};
load("static/js/engine.js");
load("static/js/api.js");
load("static/js/cw-engine.js");
load("static/js/cw-view.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

load("static/js/cw-app.js");

setTimeout(() => {
  const doc = window.document;
  const CW = window.CW;

  // 1) 演示换装单渲染：3 列配重架 + 状态草稿
  const cols = doc.querySelectorAll("#arborSvg .cw-col");
  assert(cols.length === 3, "配重架视图渲染 3 根吊杆列，实际 " + cols.length);
  assert(doc.querySelector("#statusPill").textContent === "草稿", "初始状态为草稿");

  // 2) 演示单已编排步骤：时间轴出现步骤块
  const steps0 = doc.querySelectorAll("#cwTimelineSvg .cw-step");
  assert(steps0.length === 10, "演示单预编排 10 个步骤（4装卸+3复核+3试运行），实际 " + steps0.length);
  const kinds = {};
  steps0.forEach((s) => {
    const cls = s.getAttribute("class");
    ["add", "remove", "review", "test"].forEach((k) => {
      if (cls.indexOf("cw-step-" + k) >= 0) kinds[k] = (kinds[k] || 0) + 1;
    });
  });
  assert(kinds.add === 3 && kinds.remove === 1 && kinds.review === 3 && kinds.test === 3,
    "步骤类型分布 加3/减1/复核3/试运行3：" + JSON.stringify(kinds));

  // 3) 检查页有失衡告警，点击可定位到吊杆行
  const warnItems = doc.querySelectorAll("#pageCheck .warn-item");
  assert(warnItems.length > 0, "检查页存在告警（演示初始失衡），实际 " + warnItems.length);
  warnItems[0].click();
  const selCol = doc.querySelector("#arborSvg .cw-col-selected");
  assert(!!selCol, "点击告警后配重架视图选中对应列");

  // 4) 重新编排按钮可用且步骤数稳定
  doc.querySelector("#btnPlan").click();
  const steps1 = doc.querySelectorAll("#cwTimelineSvg .cw-step");
  assert(steps1.length === 10, "重新编排后仍为 10 步，实际 " + steps1.length);

  // 5) 点选时间轴步骤 → 吊杆行页出现步骤详情
  const firstStep = doc.querySelector("#cwTimelineSvg .cw-step");
  firstStep.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(doc.querySelector("#pageLines").textContent.indexOf("步骤 #") >= 0, "步骤详情面板出现");

  // 6) 回放：进入回放并 seek，配重架砖数随时间变化
  doc.querySelector("#btnReplayToggle").click();
  const CWAppTimeline = window.CWTimeline;
  CWAppTimeline.handlers.onSeek(0);
  const bricksAt = (t) => {
    CWAppTimeline.handlers.onSeek(t);
    // 取第一列配重架砖块填充高度
    const col = doc.querySelectorAll("#arborSvg .cw-col")[1]; // 布景杆 A：5→8 块
    const fill = col.querySelector(".cw-bricks");
    return parseFloat(fill.getAttribute("height"));
  };
  const h0 = bricksAt(0);
  // 找到布景杆 A 第一个加砖步中点：演示编排中其加砖步在 0s 或相近
  const hMid = bricksAt(15);
  assert(hMid !== h0, "回放中砖块填充高度随时间变化（" + h0 + " → " + hMid + "）");

  // 7) 状态机按钮：草稿态只有“提交核对”
  const acts = Array.from(doc.querySelectorAll("#statusActions button")).map((b) => b.textContent);
  assert(acts.length === 1 && acts[0].indexOf("提交核对") >= 0, "草稿态仅显示提交核对按钮");

  console.log(failures ? "\n失败 " + failures : "\n配重换装单 DOM 冒烟全部通过");
  process.exit(failures ? 1 : 0);
}, 400);
