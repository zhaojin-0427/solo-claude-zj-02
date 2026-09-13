/* 紧急停车演练单 DOM 冒烟：演示单渲染、拖动触发线、扫描、告警定位、确认冻结 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/tmp/node_modules/jsdom");

const html = fs.readFileSync(path.join(__dirname, "../templates/estop.html"), "utf8");
const dom = new JSDOM(html, {
  url: "http://127.0.0.1:5000/estop",
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

// ---- 内存假库：模拟服务端（含确认冻结快照）----
const db = { drills: [], nextId: 1 };
// 来源沙盘项目（可原地改写，模拟“来源版本变化”）
const srcProj = {
  stage: { depth: 14, height: 12, passageY: 2.5, totalTime: 60 },
  battens: [{
    id: "sb1", name: "源杆1", x: 3, length: 6, maxLoad: 200, vmax: 1.2, amax: 0.5,
    lowLimit: 0.3, highLimit: 11, initialPos: 10.5, prop: null,
  }],
  cues: [{
    id: "sc1", battenId: "sb1", name: "降", start: 0, duration: 8,
    fromPos: 10.5, toPos: 3, linkGroup: "", locked: false, dwell: false,
  }],
  occupancies: [],
};
const jsonRes = (obj, status) => {
  const st = status || 200;
  return { ok: st < 400, status: st, json: async () => obj };
};
window.fetch = async (url, opts) => {
  const m = (opts && opts.method) || "GET";
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  if (url === "/api/projects")
    return jsonRes([{ id: 7, name: "剧目A", updatedAt: 1 }]);
  if (url === "/api/projects/7" && m === "GET")
    return jsonRes({ id: 7, name: "剧目A", data: JSON.parse(JSON.stringify(srcProj)), createdAt: 1, updatedAt: Date.now() });
  if (url === "/api/projects/7/versions") return jsonRes([]);
  if (url === "/api/estop/drills" && m === "GET")
    return jsonRes(db.drills.map((d) => ({
      id: d.id, name: d.name, status: d.status, projectId: d.projectId,
      versionId: d.versionId, metrics: d.metrics, updatedAt: d.updatedAt,
    })));
  if (url === "/api/estop/drills" && m === "POST") {
    const row = {
      id: db.nextId++, name: body.name, status: "draft",
      projectId: body.projectId || null, versionId: body.versionId || null,
      data: body.data || {}, metrics: body.metrics || {}, updatedAt: Date.now(),
    };
    db.drills.push(row);
    return jsonRes({ id: row.id, name: row.name, status: "draft" });
  }
  const mm = url.match(/^\/api\/estop\/drills\/(\d+)$/);
  if (mm) {
    const row = db.drills.find((d) => d.id === Number(mm[1]));
    if (!row) return jsonRes({ error: "演练单不存在" }, 404);
    if (m === "GET")
      return jsonRes({
        id: row.id, name: row.name, status: row.status, projectId: row.projectId,
        versionId: row.versionId, data: row.data, metrics: row.metrics,
        createdAt: row.updatedAt, updatedAt: row.updatedAt,
      });
    if (m === "PUT") {
      if (row.status === "done") return jsonRes({ error: "演练单已确认冻结，不可改写" }, 409);
      if (body.data) row.data = body.data;
      if (body.name) row.name = body.name;
      if (body.metrics) row.metrics = body.metrics;
      if (body.status === "done") {
        if (!row.data.project) return jsonRes({ error: "缺少沙盘数据，不能确认冻结" }, 400);
        row.status = "done";
        row.data.snapshot = {
          frozenAt: Date.now(), trigger: row.data.trigger,
          versionId: row.data.versionId, versionLabel: row.data.versionLabel,
          fingerprint: row.data.fingerprint, params: row.data.params, brakes: row.data.brakes,
        };
      }
      row.updatedAt = Date.now();
      return jsonRes({ ok: true, status: row.status, updatedAt: row.updatedAt });
    }
    if (m === "DELETE") {
      db.drills = db.drills.filter((d) => d !== row);
      return jsonRes({ ok: true });
    }
  }
  throw new Error("unexpected fetch " + url + " " + m);
};

load("static/js/engine.js");
load("static/js/api.js");
load("static/js/estop-engine.js");
load("static/js/estop-view.js");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

load("static/js/estop-app.js");

setTimeout(async () => {
  const doc = window.document;
  const $ = (s) => doc.querySelector(s);
  const $$ = (s) => Array.from(doc.querySelectorAll(s));

  // 1) 演示演练单渲染：正常+急停轨迹曲线、触发线、状态草稿
  const normalCurves = $$("#esChartSvg .es-curve-normal");
  const estopCurves = $$("#esChartSvg .es-curve-estop");
  assert(normalCurves.length === 3, "轨迹图渲染 3 条原计划曲线，实际 " + normalCurves.length);
  assert(estopCurves.length === 3, "轨迹图渲染 3 条急停曲线，实际 " + estopCurves.length);
  assert(!!$("#esChartSvg .es-trigger-line"), "触发线已渲染");
  assert($("#statusPill").textContent === "草稿", "初始状态为草稿");
  assert($$("#pageTrigger .brake-row").length === 3, "3 行各杆制动参数");

  // 2) 演示单在 5s 触发：扫掠+侵入净空+联动不同步告警
  const warns0 = $$("#pageCheck .warn-item");
  assert(warns0.length >= 3, "5s 触发告警≥3（扫掠/净空/联动），实际 " + warns0.length);
  const pillHigh0 = $("#pageCheck .summary-pills .pill b").textContent;

  // 3) 拖动触发线到 13s：告警集合变化，工具栏同步
  window.ESChart.handlers.onTrigger(13);
  assert(Number($("#triggerNum").value) === 13, "拖动后触发时刻输入框=13");
  const warns1 = $$("#pageCheck .warn-item");
  assert(warns1.length >= 3, "13s 触发告警≥3（双杆侵入净空+扫掠），实际 " + warns1.length);
  assert($("#cursorClock").textContent.indexOf("急停 13.0 s") >= 0, "时钟显示急停 13.0s");

  // 4) 点选告警 → 跳到吊杆与风险时刻
  const firstWarn = $("#pageCheck .warn-item");
  firstWarn.click();
  const clock = $("#cursorClock").textContent;
  assert(/游标 13\.0 s/.test(clock), "点选告警后游标跳到风险时刻，时钟：" + clock);
  assert(!!$("#pageTrigger .brake-row.selected"), "相关吊杆行被选中");

  // 5) 扫描：生成按危险度排列的触发点列表
  $("#btnScan").click();
  const scanItems = $$("#pageScan .scan-item");
  assert(scanItems.length >= 5, "扫描生成危险触发点列表，实际 " + scanItems.length + " 行");
  const firstScanText = scanItems[0] ? scanItems[0].textContent : "";
  assert(/高危/.test(firstScanText), "首行含高危计数：" + firstScanText.trim());
  // 采用扫描点
  const t0 = scanItems[0].getAttribute("data-scan-t");
  scanItems[0].click();
  assert(Number($("#triggerNum").value) === Number(t0), "点击扫描行采用该触发时刻 " + t0);

  // 6) 来源版本读取与过期标记：读取 → 来源变化只标记过期 → 重新读取消除
  $("#srcProject").value = "7";
  $("#btnReadSource").click();
  await new Promise((r) => setTimeout(r, 80));
  assert($("#pageTrigger").textContent.indexOf("剧目A") >= 0, "已读取来源项目「剧目A」");
  assert($("#staleBadge").style.display === "none", "读取后来源未过期");
  srcProj.battens[0].x = 9; // 模拟来源版本内容变化
  $("#btnCheckStale").click();
  await new Promise((r) => setTimeout(r, 80));
  assert($("#staleBadge").style.display !== "none", "来源变化后标记过期徽章");
  assert($("#staleBar").style.display === "flex", "过期提示条出现");
  $("#btnRecapture").click();
  await new Promise((r) => setTimeout(r, 80));
  assert($("#staleBadge").style.display === "none", "重新读取后来源不再过期");

  // 回到演示单（内存草稿）继续确认流程
  $("#drillSelect").value = "";
  $("#drillSelect").dispatchEvent(new window.Event("change"));
  await new Promise((r) => setTimeout(r, 80));
  assert($$("#pageTrigger .brake-row").length === 3, "已切回演示单（3 杆）");

  // 7) 保存 → 确认冻结 → 只读 + 快照 + 检查卡
  $("#btnSave").click();
  await new Promise((r) => setTimeout(r, 60));
  assert(db.drills.length === 1, "保存后入库 1 张演练单");
  $("#btnConfirm").click();
  await new Promise((r) => setTimeout(r, 120));
  assert($("#statusPill").textContent === "已确认", "确认后状态为已确认");
  assert($("#readonlyBar").style.display !== "none", "只读横幅出现");
  assert($("#triggerNum").disabled === true, "触发时刻输入被锁定");
  assert(db.drills[0].data.snapshot && db.drills[0].data.snapshot.trigger != null,
    "服务端冻结输入快照（含触发时刻）");
  const cards = $$("#pageCards .estop-card");
  assert(cards.length === 3, "生成 3 张逐杆停车检查卡，实际 " + cards.length);
  assert(cards.some((c) => c.textContent.indexOf("制动距离") >= 0), "检查卡含制动距离");

  // 8) 冻结后拖触发线被拒绝（状态不变）
  window.ESChart.handlers.onTrigger(3);
  assert(Number($("#triggerNum").value) !== 3, "冻结后触发线不可拖动修改");

  // 9) 历史演练单列表可回放对照
  const hist = $$("#pageReplay .history-item");
  assert(hist.length === 1, "历史演练单列表 1 条");
  assert(!!$("#pageReplay #btnPlay"), "回放按钮存在（历史单可回放）");

  console.log(failures ? "\n失败 " + failures : "\n紧急停车演练单 DOM 冒烟全部通过");
  process.exit(failures ? 1 : 0);
}, 400);
