/* node 引擎自检：node test/engine_test.js */
global.window = global;
require("../static/js/engine.js");
const E = global.E;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error("  ✗ " + msg); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

// ---------- 运动曲线 ----------
{
  // 梯形：10m @ v=1.2, a=0.5 -> T = 1.2/0.5 + 10/1.2 = 2.4+8.333=10.733s
  const T = E.minDuration(10, 1.2, 0.5);
  ok(approx(T, 2.4 + 10 / 1.2, 1e-3), "minDuration 梯形: " + T);
  const p = E.buildProfile(10, 0, 11, 1.2, 0.5);
  ok(p.feasible, "11s 可行");
  ok(approx(p.pos(0), 10) && approx(p.pos(11), 0), "端点 10->0");
  ok(p.pos(5) > p.pos(10), "单调下降");
  // 三角形：2m @ v=1.2,a=0.5：达速距离 v²/a=2.88 > 2 => 三角形
  const p2 = E.buildProfile(10, 8, 6, 1.2, 0.5); // 下降 2m / 6s
  ok(p2.kind === "triangle", "短行程退化为三角形");
  ok(approx(p2.pos(3), 9, 0.02), "三角形中点≈中点位置");
  // 不可行：距离太大时间太短
  const p3 = E.buildProfile(0, 10, 2, 1.2, 0.5);
  ok(!p3.feasible, "2s 升 10m 不可行");
  // 速度不超过 vmax
  let vmax = 0;
  for (let t = 0; t <= p.T; t += 0.05) vmax = Math.max(vmax, Math.abs(p.vel(t)));
  ok(vmax <= 1.2 + 1e-6, "峰值速度不超限");
}

// ---------- 演示数据（与前端 demo 对齐的最小复现）----------
function demo() {
  const p = E.emptyProject();
  Object.assign(p.stage, { depth: 14, height: 12, maxConcurrent: 2, totalTime: 60 });
  const b1 = E.newBatten(2, 1); b1.maxLoad = 250; b1.highLimit = 11; b1.initialPos = 10.5;
  b1.prop = { id: "p1", name: "大幕", kind: "curtain", width: 2.5, height: 7.5, weight: 120, hangingHeight: 10.5, clearance: 0.3 };
  const b2 = E.newBatten(7, 2); b2.maxLoad = 200; b2.initialPos = 10.5;
  b2.prop = { id: "p2", name: "景片", kind: "scenery", width: 6, height: 4, weight: 150, hangingHeight: 10.5, clearance: 0.4 };
  const b3 = E.newBatten(12, 3); b3.maxLoad = 70; b3.initialPos = 10.8; b3.highLimit = 11.2;
  b3.prop = { id: "p3", name: "灯排", kind: "light", width: 4, height: 0.8, weight: 80, hangingHeight: 10.8, clearance: 0.3 };
  p.battens.push(b1, b2, b3);
  p.occupancies.push(E.newOcc({ name: "通行", start: 4, duration: 12, x: 1.5, width: 7.5 }));
  p.cues.push(E.newCue({ battenId: b1.id, name: "大幕落", start: 0, duration: 8, fromPos: 10.5, toPos: 3 }));
  p.cues.push(E.newCue({ battenId: b2.id, name: "景落", start: 4, duration: 8, fromPos: 10.5, toPos: 4 }));
  p.cues.push(E.newCue({ battenId: b3.id, name: "灯落", start: 6, duration: 6, fromPos: 10.8, toPos: 8 }));
  return E.normalizeProject(p);
}

{
  const p = demo();
  const res = E.analyze(p);
  const types = {};
  for (const w of res.warnings) types[w.type] = (types[w.type] || 0) + 1;
  ok((types.overload || 0) >= 1, "检测到灯杆超载（80×1.15=92>70 且运行）: " + JSON.stringify(types));
  ok((types.passage || 0) >= 1, "检测到通行区未清空落景: " + JSON.stringify(types));
  // b2 落到底：prop 底部 0-4=-4，pos 0 < lowLimit 0.3 -> 越程
  ok((types.overtravel || 0) >= 1, "检测到越程: " + JSON.stringify(types));
  // 三个动作 6-8s 并发
  ok((types.concurrency || 0) >= 1, "检测到并发超限: " + JSON.stringify(types));
  console.log("  演示告警分布:", JSON.stringify(types));
}

// ---------- 扫掠相交 ----------
{
  const p = E.emptyProject();
  p.stage.depth = 14;
  const b1 = E.newBatten(7, 1); b1.prop = { id: "a", name: "A", kind: "scenery", width: 8, height: 3, weight: 50, hangingHeight: 10, clearance: 0.3 };
  const b2 = E.newBatten(8, 2); b2.prop = { id: "b", name: "B", kind: "scenery", width: 8, height: 3, weight: 50, hangingHeight: 10, clearance: 0.3 };
  p.battens.push(b1, b2);
  p.cues.push(E.newCue({ battenId: b1.id, start: 0, duration: 6, fromPos: 10.5, toPos: 2 }));
  p.cues.push(E.newCue({ battenId: b2.id, start: 0, duration: 6, fromPos: 10.5, toPos: 2 }));
  const np = E.normalizeProject(p);
  const res = E.analyze(np);
  ok(res.warnings.some((w) => w.type === "sweep"), "同深度双杆同步下降应扫掠相交");
  // 前后完全错开的吊杆不应报
  const q = E.emptyProject();
  const c1 = E.newBatten(2, 1); c1.length = 2;
  const c2 = E.newBatten(12, 2); c2.length = 2;
  q.battens.push(c1, c2);
  q.cues.push(E.newCue({ battenId: c1.id, start: 0, duration: 4, fromPos: 10, toPos: 1 }));
  q.cues.push(E.newCue({ battenId: c2.id, start: 0, duration: 4, fromPos: 10, toPos: 1 }));
  const res2 = E.analyze(E.normalizeProject(q));
  ok(!res2.warnings.some((w) => w.type === "sweep"), "进深错开不报扫掠");
}

// ---------- 自动排程 ----------
{
  const p = demo();
  // 锁定大幕
  p.cues[0].locked = true;
  const plans = E.planVariants(p);
  ok(plans.length === 4, "生成 4 个方案");
  ok(plans.some((pl) => pl.best), "有推荐方案");
  for (const pl of plans) {
    // 锁定提示起止不变
    const lockedCue = pl.data.cues.find((c) => c.id === p.cues[0].id);
    ok(lockedCue.start === 0 && lockedCue.duration === 8, pl.label + " 锁定提示不动");
    // 通行冲突应被消除（排程器强制）
    ok(!pl.metrics.byType || !pl.metrics.byType.passage, pl.label + " 无通行冲突");
  }
  const best = plans.find((pl) => pl.best);
  console.log("  推荐方案:", best.label, JSON.stringify(best.metrics));
  // 场景：总时限足够时，推荐方案应在时限内
  ok(best.metrics.withinDeadline, "推荐方案在 60s 时限内");
}

// ---------- 排程并发不超限 ----------
{
  const p = E.emptyProject();
  p.stage.maxConcurrent = 1;
  p.stage.totalTime = 120;
  const bs = [];
  for (let i = 0; i < 4; i++) {
    const b = E.newBatten(2 + i * 3, i + 1); b.length = 1.5; b.initialPos = 10.5;
    p.battens.push(b); bs.push(b);
  }
  bs.forEach((b) => p.cues.push(E.newCue({
    battenId: b.id, start: 0, duration: 4, fromPos: 10.5, toPos: 5,
  })));
  const plans = E.planVariants(E.normalizeProject(p));
  const best = plans.find((pl) => pl.best);
  ok(best.metrics.peakParallel <= 1, "maxConcurrent=1 排程后峰值并行≤1, 实际 " + best.metrics.peakParallel);
}

console.log("\n通过 " + pass + "，失败 " + fail);
process.exit(fail ? 1 : 0);
