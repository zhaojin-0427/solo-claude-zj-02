/* node 自检：node test/estop_engine_test.js */
global.window = global;
require("../static/js/engine.js");
require("../static/js/estop-engine.js");
const E = global.E;
const ES = global.ES;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error("  ✗ " + msg); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

// ---------- 演示沙盘（与 estop-app.js 演示单同源）----------
function demoProj() {
  const s = E.stageDefaults();
  Object.assign(s, { totalTime: 60, passageY: 2.5 });
  const p = { stage: s, battens: [], cues: [], occupancies: [] };
  const b1 = E.newBatten(2.0, 1); b1.id = "b1"; b1.name = "幕杆";
  Object.assign(b1, { length: 2.5, lowLimit: 0.2, highLimit: 11, initialPos: 10.5 });
  b1.prop = { id: "p1", name: "大幕", kind: "curtain", width: 2.5, height: 7.5, weight: 120, hangingHeight: 10.5, clearance: 0.3 };
  const b2 = E.newBatten(4.5, 2); b2.id = "b2"; b2.name = "景杆";
  Object.assign(b2, { length: 6, lowLimit: 0.3, highLimit: 11, initialPos: 10.5 });
  b2.prop = { id: "p2", name: "景片", kind: "scenery", width: 6, height: 4, weight: 150, hangingHeight: 10.5, clearance: 0.4 };
  const b3 = E.newBatten(11.0, 3); b3.id = "b3"; b3.name = "灯杆";
  Object.assign(b3, { length: 5, lowLimit: 0.3, highLimit: 11.2, initialPos: 10.8 });
  b3.prop = { id: "p3", name: "灯排", kind: "light", width: 5, height: 0.8, weight: 80, hangingHeight: 10.8, clearance: 0.3 };
  p.battens.push(b1, b2, b3);
  p.occupancies.push(E.newOcc({ id: "o1", name: "通行", start: 4, duration: 12, x: 1.5, width: 7.5 }));
  p.cues.push(E.newCue({ id: "c1", battenId: "b1", start: 0, duration: 9, fromPos: 10.5, toPos: 3, linkGroup: "幕组" }));
  p.cues.push(E.newCue({ id: "c2", battenId: "b3", start: 0, duration: 7.8, fromPos: 10.8, toPos: 8.2, linkGroup: "幕组" }));
  p.cues.push(E.newCue({ id: "c3", battenId: "b2", start: 4, duration: 12, fromPos: 10.5, toPos: 0.2 }));
  return E.normalizeProject(p);
}
function demoDrill(trigger) {
  const d = ES.newDrill("测试");
  d.project = demoProj();
  d.trigger = trigger;
  d.params.responseDelay = 0.4;
  d.brakes = { b1: { delay: 0.2, decel: 1.0 }, b2: { delay: 0.3, decel: 0.8 }, b3: { delay: 0.6, decel: 1.5 } };
  return ES.normalize(d);
}

// ---------- 原曲线位置/速度：与运动曲线一致 ----------
{
  const proj = demoProj();
  const b1 = proj.battens[0];
  const st = ES.frozenState(proj, b1, 5, 5);
  const cue = proj.cues.find((c) => c.id === "c1");
  const pf = E.cueProfile(proj, cue);
  ok(approx(st.pos, pf.pos(5), 1e-6), "触发时刻位置=原曲线位置 " + st.pos.toFixed(3));
  ok(approx(st.vel, pf.vel(5), 1e-6), "触发时刻速度=原曲线速度 " + st.vel.toFixed(3));
  ok(approx(st.pos, 6.198, 0.01) && approx(st.vel, -1.104, 0.01),
    "幕杆 5s 位置≈6.20m 速度≈-1.10m/s，实际 " + st.pos.toFixed(3) + "/" + st.vel.toFixed(3));
}

// ---------- 急停后不启动新提示 ----------
{
  const proj = demoProj();
  proj.cues.push(E.newCue({ id: "c9", battenId: "b1", start: 10, duration: 4, fromPos: 3, toPos: 8 }));
  const proj2 = E.normalizeProject(proj);
  const b1 = proj2.battens[0];
  const st = ES.frozenState(proj2, b1, 12, 5);
  ok(approx(st.pos, 3, 1e-6) && st.vel === 0,
    "触发后新提示不启动：12s 仍停在 3m，实际 " + st.pos.toFixed(2));
  const normal = E.battenState(proj2, b1, 12);
  ok(normal.pos > 3.1, "对照：原计划 12s 已上升 " + normal.pos.toFixed(2));
}

// ---------- 制动推演：制动距离 / 停止时刻 / 最终高度 ----------
{
  const d = demoDrill(5);
  const r = ES.simulate(d);
  const p1 = r.plans.find((p) => p.battenId === "b1");
  ok(approx(p1.brakeStart, 5.6, 1e-6), "制动介入=触发+响应+制动延迟 5.6s，实际 " + p1.brakeStart);
  // v=1.1045, a=1.0 → dist=v²/2a≈0.610, stop=5.6+v/a≈6.70
  ok(approx(p1.brakeDist, 0.610, 0.01), "幕杆制动距离≈0.61m，实际 " + p1.brakeDist.toFixed(3));
  ok(approx(p1.stopTime, 6.70, 0.01), "幕杆停止时刻≈6.70s，实际 " + p1.stopTime.toFixed(3));
  ok(approx(p1.finalPos, 4.925, 0.01), "幕杆最终高度≈4.93m，实际 " + p1.finalPos.toFixed(3));
  ok(approx(r.summary.allStopTime, 1.76, 0.01), "全部停止用时≈1.76s，实际 " + r.summary.allStopTime);
  ok(approx(r.summary.maxBrakeDist, 0.610, 0.01), "最大制动距离≈0.61m");
  // estopPos 分段：延迟期沿原曲线 / 制动中抛物线 / 停止后恒定
  const proj = E.normalizeProject(d.project);
  const b1 = proj.battens[0];
  const pl = r.plans.find((p) => p.battenId === "b1");
  ok(approx(ES.estopPos(proj, b1, pl, 5, 5.3), ES.frozenState(proj, b1, 5.3, 5).pos, 1e-6),
    "延迟期内位置=原曲线");
  const mid = 5.6 + 1.104 / 2; // 制动中点
  const expect = pl.posAtBrake + pl.velAtBrake * (mid - 5.6) - 0.5 * 1.0 * Math.pow(mid - 5.6, 2) * -1 * -1;
  ok(approx(ES.estopPos(proj, b1, pl, 5, mid), pl.posAtBrake + pl.velAtBrake * (mid - 5.6) + 0.5 * 1.0 * Math.pow(mid - 5.6, 2), 1e-6) ||
     approx(ES.estopPos(proj, b1, pl, 5, mid), expect, 1e-6),
    "制动中段为匀减速抛物线");
  ok(approx(ES.estopPos(proj, b1, pl, 5, 9), pl.finalPos, 1e-6), "停止后保持最终高度");
}

// ---------- 联动组不同步 ----------
{
  const r = ES.simulate(demoDrill(5));
  const w = r.warnings.find((x) => x.type === "link");
  ok(!!w, "幕组两杆制动参数不同 → 联动不同步告警");
  ok(w && w.severity === "medium" && w.message.indexOf("幕组") >= 0, "联动告警为中危且点名联动组");
  // 对照：两杆相同制动参数且同曲线 → 不同步消失
  const q = E.emptyProject();
  q.stage.height = 12;
  const m1 = E.newBatten(2, 1); m1.id = "m1"; m1.initialPos = 10.5; m1.length = 2;
  const m2 = E.newBatten(12, 2); m2.id = "m2"; m2.initialPos = 10.5; m2.length = 2;
  q.battens.push(m1, m2);
  q.cues.push(E.newCue({ id: "g1", battenId: "m1", start: 0, duration: 9, fromPos: 10.5, toPos: 3.5, linkGroup: "G" }));
  q.cues.push(E.newCue({ id: "g2", battenId: "m2", start: 0, duration: 9, fromPos: 10.5, toPos: 3.5, linkGroup: "G" }));
  const mk = (delay2) => {
    const d = ES.newDrill("t");
    d.project = E.normalizeProject(q);
    d.trigger = 4.5;
    d.params.responseDelay = 0;
    d.brakes = { m1: { delay: 0.2, decel: 1.0 }, m2: { delay: delay2, decel: 1.0 } };
    return ES.simulate(ES.normalize(d));
  };
  ok(mk(0.8).warnings.some((x) => x.type === "link"), "同曲线不同制动延迟 → 联动不同步");
  ok(!mk(0.2).warnings.some((x) => x.type === "link"), "同曲线同制动参数 → 无联动告警");
}

// ---------- 扫掠相交 ----------
{
  // 两杆同深度对向交汇：A 降 B 升，急停弱制动 → 扫掠相交
  const q = E.emptyProject();
  q.stage.height = 12;
  const A = E.newBatten(7, 1); A.id = "A"; A.initialPos = 10;
  A.prop = { id: "pa", name: "A", kind: "scenery", width: 8, height: 1, weight: 50, hangingHeight: 10, clearance: 0.2 };
  const B = E.newBatten(7.5, 2); B.id = "B"; B.initialPos = 2;
  B.prop = { id: "pb", name: "B", kind: "scenery", width: 8, height: 1, weight: 50, hangingHeight: 2, clearance: 0.2 };
  q.battens.push(A, B);
  q.cues.push(E.newCue({ id: "ca", battenId: "A", start: 0, duration: 9, fromPos: 10, toPos: 3 }));
  q.cues.push(E.newCue({ id: "cb", battenId: "B", start: 0, duration: 9, fromPos: 2, toPos: 9 }));
  const d = ES.newDrill("t");
  d.project = E.normalizeProject(q);
  d.trigger = 4.5;
  d.params.responseDelay = 0;
  d.brakes = { A: { delay: 0, decel: 0.4 }, B: { delay: 0, decel: 0.4 } };
  const r = ES.simulate(ES.normalize(d));
  ok(r.warnings.some((x) => x.type === "sweep"), "对向交汇两杆急停扫掠相交");
  // 对照：进深错开 → 不相交
  const q2 = E.normalizeProject(JSON.parse(JSON.stringify(q)));
  q2.battens[1].x = 13; q2.battens[1].prop.width = 2;
  const d2 = ES.normalize(Object.assign({}, d, { project: q2 }));
  ok(!ES.simulate(d2).warnings.some((x) => x.type === "sweep"), "进深错开后无扫掠告警");
}

// ---------- 侵入演员通行净空 ----------
{
  const r = ES.simulate(demoDrill(13));
  const w = r.warnings.filter((x) => x.type === "passage");
  ok(w.length >= 1, "通行时段急停 → 侵入净空告警，实际 " + w.length + " 条");
  ok(w.some((x) => (x.battenIds || []).indexOf("b2") >= 0), "景杆急停落入通行净空被点名");
  ok(w.every((x) => x.severity === "high"), "侵入净空为高危");
}

// ---------- 越程 ----------
{
  const r = ES.simulate(demoDrill(14.8));
  const w = r.warnings.find((x) => x.type === "overtravel");
  ok(!!w, "末端急停冲出下限位 → 越程告警");
  ok(w && (w.battenIds || []).indexOf("b2") >= 0, "越程点名景杆");
  const card = r.cards.find((c) => c.battenId === "b2");
  ok(card.limit === "low" && card.level === "danger", "检查卡标记越下限位且为高危");
}

// ---------- 扫描：排序与字段 ----------
{
  const d = demoDrill(5);
  const sc = ES.scan(d, 0, 16, 1);
  ok(sc.scanned === 17, "0..16 步长1 扫描 17 点，实际 " + sc.scanned);
  ok(sc.rows.every((r) => typeof r.t === "number" && typeof r.high === "number" &&
    typeof r.maxBrakeDist === "number" && typeof r.allStopTime === "number"),
    "每行含 触发时刻/高危数/最大制动距离/全部停止用时");
  let sorted = true;
  for (let i = 1; i < sc.rows.length; i++) {
    const a = sc.rows[i - 1], b = sc.rows[i];
    if (a.high < b.high ||
        (a.high === b.high && a.maxBrakeDist < b.maxBrakeDist - 1e-9) ||
        (a.high === b.high && approx(a.maxBrakeDist, b.maxBrakeDist) && a.allStopTime < b.allStopTime - 1e-9))
      sorted = false;
  }
  ok(sorted, "按 高危数→最大制动距离→全部停止用时 降序排列");
  ok(sc.rows[0].high >= 3, "最危险触发点高危≥3，实际 " + sc.rows[0].high);
  ok(sc.rows.some((r) => r.high === 0 || r.high < sc.rows[0].high), "存在相对安全的触发点");
}

// ---------- 延迟期自然停止：触发时仍运动，但提示在制动介入前沿原曲线结束 ----------
{
  const p = E.emptyProject();
  Object.assign(p.stage, { depth: 14, height: 12, passageY: 2.5, totalTime: 60 });
  const b1 = E.newBatten(3, 1); b1.id = "b1"; b1.name = "景杆";
  Object.assign(b1, { lowLimit: 0.3, highLimit: 11, initialPos: 10.5 });
  b1.prop = { id: "p1", name: "景片", kind: "scenery", width: 6, height: 4, weight: 100, hangingHeight: 10.5, clearance: 0.3 };
  const b2 = E.newBatten(12, 2); b2.id = "b2"; b2.name = "静止杆";
  Object.assign(b2, { lowLimit: 0.3, highLimit: 11, initialPos: 10.5 });
  p.battens.push(b1, b2);
  // 通行时段覆盖延迟期；提示 8→11.6s 降到 6.453m（吊物底 2.453m ＜ 净空 2.5m）
  p.occupancies.push(E.newOcc({ id: "o1", name: "通行", start: 9, duration: 4, x: 1.5, width: 7.5 }));
  p.cues.push(E.newCue({ id: "c1", battenId: "b1", start: 8, duration: 3.6, fromPos: 8, toPos: 6.453 }));
  const d = ES.newDrill("t");
  d.project = E.normalizeProject(p);
  d.trigger = 11; // 制动介入 11+0.4+0.3=11.7，晚于提示结束 11.6 → 延迟期自然停止
  d.params.responseDelay = 0.4;
  d.brakes = { b1: { delay: 0.3, decel: 1.2 } };
  const r = ES.simulate(ES.normalize(d));
  const pl = r.plans.find((x) => x.battenId === "b1");
  ok(pl.velAtTrigger < 0, "触发时仍在运动，vel=" + pl.velAtTrigger.toFixed(3));
  ok(pl.moving === true && pl.braked === false,
    "延迟期运动但未制动：moving=true, braked=false");
  ok(approx(pl.stopTime, 11.6, 1e-6), "停止时刻=原曲线停稳 11.6s，实际 " + pl.stopTime);
  ok(pl.brakeDist === 0, "未触发应急制动，制动距离 0");
  ok(approx(pl.finalPos, 6.453, 1e-6), "最终高度=提示终点 6.453m");
  ok(approx(r.stoppedAt, 11.6, 1e-6), "stoppedAt=11.6s，实际 " + r.stoppedAt);
  ok(approx(r.summary.allStopTime, 0.6, 1e-6), "全部停止用时 0.6s（非 0），实际 " + r.summary.allStopTime);
  ok(r.summary.movingCount === 1, "运动吊杆计 1（静止杆不计），实际 " + r.summary.movingCount);
  const w = r.warnings.find((x) => x.type === "passage");
  ok(!!w && w.severity === "high", "延迟期吊物底侵入通行净空 → 高危告警");
  ok(w && (w.battenIds || []).indexOf("b1") >= 0, "告警点名运动杆");
  const card = r.cards.find((x) => x.battenId === "b1");
  ok(card.moving === true, "检查卡标记为运动（非静止）");
  ok(approx(card.stopAfter, 0.6, 1e-6), "检查卡停止用时 0.6s，实际 " + card.stopAfter);
  ok(card.level === "danger", "检查卡级别=高危");
  ok(approx(card.finalLowest, 2.453, 5e-3), "检查卡吊物底 2.453m（保留两位小数），实际 " + card.finalLowest);
  const card2 = r.cards.find((x) => x.battenId === "b2");
  ok(card2.moving === false && card2.stopAfter === 0, "无提示静止杆：moving=false，停止用时 0");
  // 停稳后的最终位置本身参与风险定位（采样窗口外延）
  ok(w && w.end >= 11.6 - 1e-6, "告警区间覆盖停稳时刻，实际止于 " + (w && w.end));
}

// ---------- 规范化 / 制动参数覆盖 / 指纹 ----------
{
  const d = ES.normalize(ES.newDrill("x"));
  ok(d.params.responseDelay === 0.4 && d.params.decel === 1.2, "默认参数 0.4s/1.2m/s²");
  ok(ES.brakeFor(d, "b1").delay === d.params.brakeDelay, "未覆盖时用默认制动延迟");
  d.brakes.b1 = { delay: 0.9, decel: 2.0 };
  const d2 = ES.normalize(d);
  ok(ES.brakeFor(d2, "b1").delay === 0.9 && ES.brakeFor(d2, "b1").decel === 2.0, "单杆覆盖生效");
  d2.brakes.b1 = { delay: 99, decel: 0.001 };
  const d3 = ES.normalize(d2);
  ok(ES.brakeFor(d3, "b1").delay === 10 && ES.brakeFor(d3, "b1").decel === 0.05, "越界参数被钳制");
  const f1 = ES.fingerprint({ a: 1, b: [2, 3], c: { x: 1, y: 2 } });
  const f2 = ES.fingerprint({ c: { y: 2, x: 1 }, b: [2, 3], a: 1 });
  const f3 = ES.fingerprint({ a: 1, b: [2, 3], c: { x: 1, y: 3 } });
  ok(f1 === f2, "指纹与键序无关");
  ok(f1 !== f3, "内容变化指纹变化");
}

// ---------- 指标与检查卡 ----------
{
  const m = ES.metrics(demoDrill(5));
  ok(m.trigger === 5 && m.high >= 1 && m.maxBrakeDist > 0, "指标含触发时刻/高危/最大制动距离");
  const r = ES.simulate(demoDrill(5));
  ok(r.cards.length === 3, "逐杆检查卡 3 张");
  const c1 = r.cards.find((c) => c.battenId === "b1");
  ok(c1.moving && c1.brakeDist > 0 && c1.stopAfter > 0, "运动杆卡片含制动数据");
  ok(c1.messages.length >= 1 && c1.level !== "ok", "有告警的杆卡片级别非正常");
  const m0 = ES.metrics(ES.newDrill("空"));
  ok(m0.high === 0 && m0.maxBrakeDist === 0, "无沙盘数据时指标为零");
}

console.log("\n通过 " + pass + "，失败 " + fail);
process.exit(fail ? 1 : 0);
