/* node 自检：node test/cw_engine_test.js */
global.window = global;
require("../static/js/cw-engine.js");
const CW = global.CW;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error("  ✗ " + msg); }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }

function baseSheet() {
  const s = CW.newSheet("测试单", "一幕→二幕");
  s.bricks = [{ id: "bk1", name: "铁砖", weight: 25, count: 20 }];
  return CW.normalize(s);
}
function line(o) {
  return Object.assign(CW.newLine(1, "bk1"), o);
}

// ---------- 目标砖数自动计算 ----------
{
  const s = baseSheet();
  const l = line({ pipeWeight: 40, propWeight: 110, arborCapacity: 300 });
  s.lines.push(l);
  ok(CW.targetBricks(s, CW.normalize(s).lines[0]) === 6, "自动目标砖数 150/25=6");
  const l2 = line({ pipeWeight: 40, propWeight: 500, arborCapacity: 100 });
  ok(CW.targetBricks(s, l2) === 4, "目标砖数受容量封顶 100/25=4");
}

// ---------- 编排：加减砖→复核→试运行，工位不重叠，同杆串行 ----------
{
  let s = baseSheet();
  const l1 = line({ id: "L1", name: "1杆", pipeWeight: 40, propWeight: 110, initialBricks: 2 });
  const l2 = line({ id: "L2", name: "2杆", pipeWeight: 50, propWeight: 100, initialBricks: 8 });
  s.lines.push(l1, l2);
  s = CW.normalize(s);
  const steps = CW.planSteps(s);
  const adds = steps.filter((x) => x.kind === "add" && x.lineId === "L1");
  const rems = steps.filter((x) => x.kind === "remove" && x.lineId === "L2");
  ok(adds.reduce((a, x) => a + x.count, 0) === 4, "L1 共加 4 块（2→6），实际 " + adds.reduce((a, x) => a + x.count, 0));
  ok(rems.reduce((a, x) => a + x.count, 0) === 2, "L2 共减 2 块（8→6）");
  ok(steps.some((x) => x.kind === "review") && steps.some((x) => x.kind === "test"), "含复核与试运行");
  // 每行：砖块步骤 < 复核 < 试运行
  for (const lid of ["L1", "L2"]) {
    const mine = steps.filter((x) => x.lineId === lid).sort((a, b) => a.start - b.start);
    const kinds = mine.map((x) => x.kind);
    const lastBrick = Math.max(...mine.filter((x) => x.kind === "add" || x.kind === "remove").map((x) => x.start));
    ok(mine.find((x) => x.kind === "review").start >= lastBrick, lid + " 复核在装卸之后");
    ok(mine.find((x) => x.kind === "test").start >= mine.find((x) => x.kind === "review").start, lid + " 试运行在复核之后");
    ok(kinds[0] === "add" || kinds[0] === "remove", lid + " 首步为装卸");
  }
  // 同工位不重叠
  for (let st = 1; st <= 2; st++) {
    const mine = steps.filter((x) => x.station === st).sort((a, b) => a.start - b.start);
    for (let i = 1; i < mine.length; i++)
      ok(mine[i].start >= mine[i - 1].start + mine[i - 1].duration - 1e-9,
        "工位 " + st + " 步骤不重叠");
  }
  // 同吊杆串行
  for (const lid of ["L1", "L2"]) {
    const mine = steps.filter((x) => x.lineId === lid).sort((a, b) => a.start - b.start);
    for (let i = 1; i < mine.length; i++)
      ok(mine[i].start >= mine[i - 1].start + mine[i - 1].duration - 1e-9,
        lid + " 步骤串行");
  }
}

// ---------- 库存压力：先卸后装 ----------
{
  let s = baseSheet();
  s.bricks[0].count = 12; // 总共 12 块：在装 6，计划加 8 > 余量 6 → 需先卸 2 释放
  const l1 = line({ id: "L1", pipeWeight: 40, propWeight: 60, initialBricks: 6 }); // 目标 4，减 2
  const l2 = line({ id: "L2", pipeWeight: 40, propWeight: 160, initialBricks: 0 }); // 目标 8，加 8
  s.lines.push(l1, l2);
  s = CW.normalize(s);
  const steps = CW.planSteps(s);
  const firstRem = steps.find((x) => x.kind === "remove");
  const firstAdd = steps.find((x) => x.kind === "add");
  ok(firstRem && firstAdd && firstRem.start <= firstAdd.start, "库存不足时先卸后装");
  const a = CW.simulate(Object.assign({}, s, { steps }));
  ok(!a.warnings.some((w) => w.type === "stock"), "先卸后装后不报库存不足");
}

// ---------- 逐步重算与五类检查 ----------
{
  let s = baseSheet();
  s.params.maxImbalance = 25;
  const l = line({
    id: "L1", pipeWeight: 40, propWeight: 200, initialBricks: 2,
    braked: false, arborPos: 2.0, arborCapacity: 100,
  });
  s.lines.push(l);
  s = CW.normalize(s);
  s.steps = [
    CW.newStep({ id: "s1", kind: "add", lineId: "L1", count: 2, start: 0, duration: 20 }),
    CW.newStep({ id: "s2", kind: "add", lineId: "L1", count: 2, start: 20, duration: 20 }),
    CW.newStep({ id: "s3", kind: "test", lineId: "L1", count: 1, start: 40, duration: 30 }),
  ];
  const a = CW.simulate(s);
  const st1 = a.stepStates.s1, st2 = a.stepStates.s2, st3 = a.stepStates.s3;
  ok(st1.bricks === 4 && st1.cwW === 100 && st1.stageW === 240, "第1步后 4 块/配重侧100/舞台侧240");
  ok(approx(st1.imbalance, 140), "第1步失衡 140");
  ok(st1.remain === 0, "第1步后配重架余量 0");
  ok(st2.remain === -50, "第2步后超容量 50（6块=150kg > 100kg）");
  ok(a.warnings.some((w) => w.type === "capacity" && w.stepId === "s2"), "报超容量");
  ok(a.warnings.filter((w) => w.type === "brake").length === 2, "两步装卸均报未制动");
  ok(a.warnings.filter((w) => w.type === "position").length === 2, "两步均报未到装卸位");
  ok(a.warnings.some((w) => w.type === "brake_release" && w.stepId === "s3"),
    "试运行失衡超限解除制动（失衡 " + st3.imbalance + "）");
  ok(a.summary.peakImbalance >= 140, "峰值失衡≥140");
}

// ---------- 库存不足 / 卸砖超已装 / 未达目标 ----------
{
  let s = baseSheet();
  s.bricks[0].count = 5;
  const l1 = line({ id: "L1", initialBricks: 3, pipeWeight: 40, propWeight: 10 });
  const l2 = line({ id: "L2", initialBricks: 3, pipeWeight: 40, propWeight: 10 });
  s.lines.push(l1, l2);
  s = CW.normalize(s);
  let a = CW.simulate(s);
  ok(a.warnings.some((w) => w.type === "stock"), "初始 3+3>5 报库存不足");
  ok(a.warnings.some((w) => w.type === "target"), "无步骤报未达目标");

  s.steps = [CW.newStep({ id: "s1", kind: "remove", lineId: "L1", count: 5, start: 0, duration: 10 })];
  a = CW.simulate(s);
  ok(a.warnings.some((w) => w.type === "brick_short" && w.stepId === "s1"), "卸下超过已装报砖块不足");
}

// ---------- 执行中仅重排未完成步骤 ----------
{
  let s = baseSheet();
  const l1 = line({ id: "L1", pipeWeight: 40, propWeight: 110, initialBricks: 0 });
  s.lines.push(l1);
  s = CW.normalize(s);
  let steps = CW.planSteps(s);
  // 确认第一步
  steps = CW.orderedSteps({ steps });
  steps[0].status = "done";
  steps[0].doneAt = 1;
  const doneId = steps[0].id, doneStart = steps[0].start, doneDur = steps[0].duration;
  const doneCount = steps[0].count;
  s.steps = steps;
  // 临时变更吊物：110 → 160（目标 6→8），仅重排未完成
  s.lines[0].propWeight = 160;
  const replanned = CW.planSteps(s, { keepDone: true });
  const kept = replanned.find((x) => x.id === doneId);
  ok(kept && kept.status === "done" && kept.start === doneStart && kept.duration === doneDur,
    "已完成步骤原样保留");
  const pend = replanned.filter((x) => x.status !== "done");
  ok(pend.every((x) => x.start >= doneStart + doneDur - 1e-9), "新步骤不早于已完成步骤结束");
  const addTotal = pend.filter((x) => x.kind === "add").reduce((a, x) => a + x.count, 0);
  ok(addTotal + doneCount === 8, "总加砖 = 新目标 8 块，实际 " + (addTotal + doneCount));
}

// ---------- 回放插值 ----------
{
  let s = baseSheet();
  const l1 = line({ id: "L1", pipeWeight: 40, propWeight: 110, initialBricks: 0 });
  s.lines.push(l1);
  s = CW.normalize(s);
  s.steps = [CW.newStep({ id: "s1", kind: "add", lineId: "L1", count: 2, start: 10, duration: 20 })];
  const mid = CW.replayState(s, 20).L1;
  ok(approx(mid.bricks, 1, 1e-6), "回放中点砖数插值=1，实际 " + mid.bricks);
  const after = CW.replayState(s, 30).L1;
  ok(after.bricks === 2 && after.cwW === 50, "回放结束 2 块/50kg");
  const before = CW.replayState(s, 5).L1;
  ok(before.bricks === 0, "回放开始前 0 块");
}

// ---------- 锁定行不参与编排 ----------
{
  let s = baseSheet();
  const l1 = line({ id: "L1", pipeWeight: 40, propWeight: 110, initialBricks: 0, bricksLocked: true });
  const l2 = line({ id: "L2", pipeWeight: 40, propWeight: 110, initialBricks: 0 });
  s.lines.push(l1, l2);
  s = CW.normalize(s);
  const steps = CW.planSteps(s);
  ok(!steps.some((x) => x.lineId === "L1"), "锁定已装砖块的行不编排步骤");
  ok(steps.some((x) => x.lineId === "L2"), "未锁定行正常编排");
}

console.log("\n通过 " + pass + "，失败 " + fail);
process.exit(fail ? 1 : 0);
