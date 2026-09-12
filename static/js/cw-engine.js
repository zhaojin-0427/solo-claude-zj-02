/* ============================================================
 * cw-engine.js —— 配重换装单纯计算引擎（无 DOM 依赖）
 *
 * 模型：每根手动吊杆一行（管身自重 + 当前吊物 = 舞台侧重量；
 * 已装砖块 × 砖重 = 配重侧重量）。步骤（加砖/减砖/复核/试运行）
 * 按时间轴推进，每步重算两侧重量、失衡量与配重架余量。
 * 编排器依据工位并发数、可用砖块与允许失衡范围生成步骤顺序。
 * ============================================================ */
(function (global) {
  "use strict";

  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let _uid = 0;
  const uid = (p) =>
    p + "_" + Date.now().toString(36) + "_" + (_uid++).toString(36);

  const KIND_LABEL = { add: "加砖", remove: "减砖", review: "复核", test: "试运行" };
  const STATUS_LABEL = { draft: "草稿", checked: "已核对", running: "执行中", done: "完成" };

  // ----------------------------------------------------------
  // 工厂与默认值
  // ----------------------------------------------------------
  function defaultParams() {
    return {
      stationCount: 2, // 装卸工位并发数
      maxImbalance: 25, // 允许失衡范围 kg
      loadingPos: 1.0, // 配重架装卸位高度 m
      posTolerance: 0.05, // 到位容差 m
      bricksPerStep: 2, // 每步最多装卸砖块数
      stepBase: 15, // 每步基础耗时 s
      stepPerBrick: 6, // 每块砖附加耗时 s
      reviewSeconds: 20, // 复核耗时 s
      testSeconds: 30, // 试运行耗时 s
    };
  }

  function newBrickSpec(i) {
    return { id: uid("bk"), name: "标准配重砖 " + i, weight: 25, count: 12 };
  }

  function newLine(i, brickId) {
    return {
      id: uid("ln"),
      name: i + " 号杆",
      battenId: "", // 引用换景沙盘吊杆
      cueId: "", // 引用升降提示
      pipeWeight: 40, // 管身自重 kg
      propName: "",
      propWeight: 0, // 当前吊物 kg
      propLocked: false, // 舞台监督锁定已挂吊物
      arborCapacity: 300, // 配重架容量 kg
      brickId: brickId || "",
      initialBricks: 0, // 当前已装砖块
      targetBricks: null, // 目标砖数（null=按平衡自动）
      bricksLocked: false, // 锁定已装砖块
      braked: true, // 吊杆制动
      arborPos: 1.0, // 配重架当前高度 m
    };
  }

  function newStep(o) {
    return Object.assign(
      {
        id: uid("st"),
        kind: "add", // add | remove | review | test
        lineId: "",
        count: 1,
        station: 1,
        start: 0,
        duration: 20,
        status: "pending", // pending | done
        auto: false,
      },
      o || {}
    );
  }

  function newSheet(name, scene) {
    const bk = newBrickSpec(1);
    return {
      scene: scene || "",
      projectId: null,
      projectName: "",
      params: defaultParams(),
      bricks: [bk],
      lines: [],
      steps: [],
      name: name || "未命名换装单",
    };
  }

  // ----------------------------------------------------------
  // 规范化
  // ----------------------------------------------------------
  function normalize(sheet) {
    if (!sheet || typeof sheet !== "object") sheet = {};
    const out = {
      scene: sheet.scene || "",
      projectId: sheet.projectId == null ? null : sheet.projectId,
      projectName: sheet.projectName || "",
      params: Object.assign(defaultParams(), sheet.params || {}),
      bricks: (sheet.bricks || []).map((b, i) => ({
        id: String(b.id || uid("bk")),
        name: b.name || "砖块 " + (i + 1),
        weight: Math.max(0.5, num(b.weight, 25)),
        count: Math.max(0, Math.round(num(b.count, 0))),
      })),
      lines: (sheet.lines || []).map((l, i) => ({
        id: String(l.id || uid("ln")),
        name: l.name || (i + 1) + " 号杆",
        battenId: l.battenId || "",
        cueId: l.cueId || "",
        pipeWeight: Math.max(0, num(l.pipeWeight, 40)),
        propName: l.propName || "",
        propWeight: Math.max(0, num(l.propWeight, 0)),
        propLocked: !!l.propLocked,
        arborCapacity: Math.max(0, num(l.arborCapacity, 300)),
        brickId: l.brickId || "",
        initialBricks: Math.max(0, Math.round(num(l.initialBricks, 0))),
        targetBricks:
          l.targetBricks == null ? null : Math.max(0, Math.round(num(l.targetBricks, 0))),
        bricksLocked: !!l.bricksLocked,
        braked: l.braked !== false,
        arborPos: num(l.arborPos, 1.0),
      })),
      steps: (sheet.steps || []).map((s) => ({
        id: String(s.id || uid("st")),
        kind: ["add", "remove", "review", "test"].indexOf(s.kind) >= 0 ? s.kind : "add",
        lineId: s.lineId || "",
        count: Math.max(1, Math.round(num(s.count, 1))),
        station: Math.max(1, Math.round(num(s.station, 1))),
        start: Math.max(0, num(s.start, 0)),
        duration: Math.max(1, num(s.duration, 20)),
        status: s.status === "done" ? "done" : "pending",
        doneAt: s.doneAt == null ? null : num(s.doneAt, null),
        auto: !!s.auto,
        seq: s.seq == null ? null : Math.round(num(s.seq, 0)),
      })),
      name: sheet.name || "未命名换装单",
    };
    for (const k of Object.keys(defaultParams()))
      out.params[k] = num(out.params[k], defaultParams()[k]);
    out.params.stationCount = Math.max(1, Math.round(out.params.stationCount));
    out.params.bricksPerStep = Math.max(1, Math.round(out.params.bricksPerStep));
    return out;
  }

  // ----------------------------------------------------------
  // 基础查询
  // ----------------------------------------------------------
  function brickOf(sheet, line) {
    return sheet.bricks.find((b) => b.id === line.brickId) || sheet.bricks[0] || null;
  }
  function lineOf(sheet, id) {
    return sheet.lines.find((l) => l.id === id) || null;
  }
  function stageWeight(line) {
    return line.pipeWeight + line.propWeight; // 舞台侧重量
  }
  function maxBricks(line, brick) {
    return brick && brick.weight > 0 ? Math.floor(line.arborCapacity / brick.weight + 1e-9) : 0;
  }
  function targetBricks(sheet, line) {
    const brick = brickOf(sheet, line);
    if (line.targetBricks != null) return line.targetBricks;
    if (!brick) return 0;
    return clamp(Math.round(stageWeight(line) / brick.weight), 0, maxBricks(line, brick));
  }
  // 步骤的规范时间序（开始时间 → 数组序）
  function orderedSteps(sheet) {
    return sheet.steps
      .map((s, i) => ({ s, i }))
      .sort((a, b) => a.s.start - b.s.start || a.i - b.i)
      .map((x) => x.s);
  }

  // ----------------------------------------------------------
  // 逐状态模拟：每步重算两侧重量 / 失衡 / 余量
  // ----------------------------------------------------------
  function simulate(sheet) {
    sheet = normalize(sheet);
    const p = sheet.params;
    const bricksNow = {}; // lineId -> 当前砖数
    const stepStates = {}; // stepId -> 该步完成后的行状态
    const initialStates = {};
    for (const l of sheet.lines) {
      bricksNow[l.id] = l.initialBricks;
      initialStates[l.id] = snapshot(sheet, l, l.initialBricks);
    }

    const warnings = [];
    let peakImbalance = 0;
    const trackPeak = (st) => {
      peakImbalance = Math.max(peakImbalance, st.imbalance);
    };
    for (const id of Object.keys(initialStates)) trackPeak(initialStates[id]);

    // 初始状态检查：超容量 / 库存不足 / 初始失衡超限
    for (const l of sheet.lines) {
      const brick = brickOf(sheet, l);
      const st = initialStates[l.id];
      if (brick && st.remain < -1e-9) {
        warnings.push({
          type: "capacity", severity: "high", lineId: l.id, stepId: null,
          start: 0, end: 0,
          message: l.name + " 初始已装 " + st.cwW + "kg 超出配重架容量 " + l.arborCapacity + "kg",
        });
      }
      if (st.imbalance > p.maxImbalance + 1e-9) {
        warnings.push({
          type: "imbalance", severity: "medium", lineId: l.id, stepId: null,
          start: 0, end: 0,
          message:
            l.name + " 初始失衡 " + st.imbalance.toFixed(0) + "kg 超出允许 ±" +
            p.maxImbalance + "kg",
        });
      }
    }
    checkStock(sheet, bricksNow, warnings, null, 0);

    for (const step of orderedSteps(sheet)) {
      const line = lineOf(sheet, step.lineId);
      if (!line) continue;
      const brick = brickOf(sheet, line);
      const w = brick ? brick.weight : 0;
      const end = step.start + step.duration;

      if (step.kind === "add" || step.kind === "remove") {
        const delta = step.kind === "add" ? step.count : -step.count;
        // 吊杆未制动
        if (!line.braked) {
          warnings.push({
            type: "brake", severity: "high", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message: line.name + " 装卸砖时吊杆未制动",
          });
        }
        // 配重架未到装卸位
        if (Math.abs(line.arborPos - p.loadingPos) > p.posTolerance + 1e-9) {
          warnings.push({
            type: "position", severity: "high", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message:
              line.name + " 配重架位于 " + line.arborPos.toFixed(2) + "m，未到装卸位 " +
              p.loadingPos.toFixed(2) + "m",
          });
        }
        bricksNow[line.id] += delta;
        // 已装砖块不足
        if (bricksNow[line.id] < 0) {
          warnings.push({
            type: "brick_short", severity: "high", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message: line.name + " 卸下砖块超过已装数量",
          });
          bricksNow[line.id] = Math.max(0, bricksNow[line.id]);
        }
        const st = snapshot(sheet, line, bricksNow[line.id]);
        stepStates[step.id] = st;
        trackPeak(st);
        // 超容量
        if (st.remain < -1e-9) {
          warnings.push({
            type: "capacity", severity: "high", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message:
              line.name + " 配重侧 " + st.cwW + "kg 超出配重架容量 " + line.arborCapacity + "kg",
          });
        }
        // 库存不足（按规格合并）
        checkStock(sheet, bricksNow, warnings, step, end);
        // 失衡超限（装卸/复核为中等提示）
        if (st.imbalance > p.maxImbalance + 1e-9) {
          warnings.push({
            type: "imbalance", severity: "medium", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message:
              line.name + " 失衡 " + st.imbalance.toFixed(0) + "kg 超出允许 ±" +
              p.maxImbalance + "kg",
          });
        }
      } else {
        const st = snapshot(sheet, line, bricksNow[line.id]);
        stepStates[step.id] = st;
        trackPeak(st);
        if (step.kind === "test" && st.imbalance > p.maxImbalance + 1e-9) {
          // 试运行需解除制动，失衡超限为高危
          warnings.push({
            type: "brake_release", severity: "high", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message:
              line.name + " 试运行解除制动时失衡 " + st.imbalance.toFixed(0) +
              "kg 超出允许 ±" + p.maxImbalance + "kg",
          });
        }
        if (step.kind === "review" && st.imbalance > p.maxImbalance + 1e-9) {
          warnings.push({
            type: "imbalance", severity: "medium", lineId: line.id, stepId: step.id,
            start: step.start, end,
            message:
              line.name + " 复核时失衡 " + st.imbalance.toFixed(0) + "kg 超出允许 ±" +
              p.maxImbalance + "kg",
          });
        }
      }
    }

    // 末态：配重目标核对
    const finalStates = {};
    for (const l of sheet.lines) {
      const st = snapshot(sheet, l, bricksNow[l.id]);
      finalStates[l.id] = st;
      const tgt = targetBricks(sheet, l);
      const brick = brickOf(sheet, l);
      if (brick && tgt * brick.weight > l.arborCapacity + 1e-9) {
        warnings.push({
          type: "capacity", severity: "high", lineId: l.id, stepId: null,
          start: 0, end: 0,
          message:
            l.name + " 目标配重 " + tgt * brick.weight + "kg 超出配重架容量 " +
            l.arborCapacity + "kg",
        });
      }
      if (!l.bricksLocked && bricksNow[l.id] !== tgt) {
        const end = sheet.steps.length
          ? Math.max(...sheet.steps.map((s) => s.start + s.duration))
          : 0;
        warnings.push({
          type: "target", severity: "medium", lineId: l.id, stepId: null,
          start: end, end,
          message:
            l.name + " 最终 " + bricksNow[l.id] + " 块，未达目标配重 " + tgt + " 块",
        });
      }
    }

    warnings.forEach((w, i) => (w.id = "w" + i));
    warnings.sort((a, b) => a.start - b.start || b.severity.localeCompare(a.severity));
    const completion = sheet.steps.length
      ? Math.max(...sheet.steps.map((s) => s.start + s.duration))
      : 0;
    return {
      warnings,
      stepStates,
      initialStates,
      finalStates,
      summary: {
        completion,
        steps: sheet.steps.length,
        doneSteps: sheet.steps.filter((s) => s.status === "done").length,
        total: warnings.length,
        high: warnings.filter((w) => w.severity === "high").length,
        medium: warnings.filter((w) => w.severity === "medium").length,
        peakImbalance: Math.round(peakImbalance * 10) / 10,
        byType: warnings.reduce((m, w) => ((m[w.type] = (m[w.type] || 0) + 1), m), {}),
      },
    };
  }

  function snapshot(sheet, line, bricks) {
    const brick = brickOf(sheet, line);
    const w = brick ? brick.weight : 0;
    const stageW = stageWeight(line);
    const cwW = Math.round(bricks * w * 10) / 10;
    return {
      lineId: line.id,
      bricks,
      stageW,
      cwW,
      imbalance: Math.round(Math.abs(stageW - cwW) * 10) / 10,
      remain: Math.round((line.arborCapacity - cwW) * 10) / 10, // 配重架余量
    };
  }

  // 库存检查：同规格砖块全场合计不超过可用数量（按规格合并告警）
  function checkStock(sheet, bricksNow, warnings, step, t) {
    const use = {};
    for (const l of sheet.lines) {
      const brick = brickOf(sheet, l);
      if (!brick) continue;
      use[brick.id] = (use[brick.id] || 0) + Math.max(0, bricksNow[l.id] || 0);
    }
    for (const b of sheet.bricks) {
      const need = use[b.id] || 0;
      if (need > b.count) {
        const exist = warnings.find((w) => w.type === "stock" && w.brickId === b.id);
        if (exist) {
          exist.end = Math.max(exist.end, t);
          exist.message =
            "「" + b.name + "」库存不足：需 " + need + " 块 / 可用 " + b.count + " 块";
        } else {
          warnings.push({
            type: "stock", severity: "high", brickId: b.id,
            lineId: step ? step.lineId : null, stepId: step ? step.id : null,
            start: step ? step.start : 0, end: t,
            message:
              "「" + b.name + "」库存不足：需 " + need + " 块 / 可用 " + b.count + " 块",
          });
        }
      }
    }
  }

  // ----------------------------------------------------------
  // 编排：依据工位并发数、可用砖块、允许失衡范围
  //       生成 加/减砖 → 复核 → 试运行 步骤序列
  // ----------------------------------------------------------
  function planSteps(sheet, opts) {
    opts = opts || {};
    sheet = normalize(sheet);
    const p = sheet.params;
    const keepDone = !!opts.keepDone;
    const doneSteps = keepDone
      ? orderedSteps(sheet).filter((s) => s.status === "done")
      : [];

    // 当前砖数（已完成步骤之后）
    const cur = {};
    for (const l of sheet.lines) cur[l.id] = l.initialBricks;
    for (const s of doneSteps) {
      if (s.kind === "add") cur[s.lineId] = (cur[s.lineId] || 0) + s.count;
      else if (s.kind === "remove") cur[s.lineId] = (cur[s.lineId] || 0) - s.count;
    }
    const t0 = doneSteps.length
      ? Math.max(...doneSteps.map((s) => s.start + s.duration))
      : 0;

    // 每行待执行的砖块操作（锁定行不动）
    const queues = [];
    for (const l of sheet.lines) {
      if (l.bricksLocked) continue;
      const brick = brickOf(sheet, l);
      if (!brick) continue;
      let delta = targetBricks(sheet, l) - (cur[l.id] || 0);
      const ops = [];
      while (delta !== 0) {
        const n = Math.min(Math.abs(delta), p.bricksPerStep);
        ops.push(delta > 0 ? n : -n);
        delta += delta > 0 ? -n : n;
      }
      if (ops.length) {
        queues.push({
          line: l,
          ops,
          imbalance0: Math.abs(stageWeight(l) - (cur[l.id] || 0) * brick.weight),
        });
      }
    }

    // 库存压力：该规格计划加砖超过当前余量时，先排减砖释放库存
    const pressure = new Set();
    for (const b of sheet.bricks) {
      let inUse = 0, adds = 0, removes = 0;
      for (const l of sheet.lines)
        if (brickOf(sheet, l).id === b.id) inUse += Math.max(0, cur[l.id] || 0);
      for (const q of queues)
        if (brickOf(sheet, q.line).id === b.id)
          for (const o of q.ops) o > 0 ? (adds += o) : (removes -= o);
      if (adds > b.count - inUse) pressure.add(b.id);
    }

    // 排序：有库存压力的规格先卸；其余按当前失衡量从大到小轮转，
    // 让失衡最大的吊杆优先回到允许范围内
    const ordered = [];
    for (const q of queues) {
      if (!pressure.has(brickOf(sheet, q.line).id)) continue;
      while (q.ops.length && q.ops[0] < 0) ordered.push({ line: q.line, count: q.ops.shift() });
    }
    const qs = queues.filter((q) => q.ops.length).sort((a, b) => b.imbalance0 - a.imbalance0);
    while (qs.length) {
      const q = qs.shift();
      ordered.push({ line: q.line, count: q.ops.shift() });
      if (q.ops.length) qs.push(q);
    }

    // 分工位与时刻：工位并发 + 同吊杆串行
    const stationAvail = new Array(p.stationCount).fill(t0);
    const lineAvail = {};
    const lastStation = {};
    const newSteps = [];
    const pickStation = (lineId) => {
      let best = 0, bestStart = Infinity;
      for (let i = 0; i < p.stationCount; i++) {
        const st = Math.max(stationAvail[i], lineAvail[lineId] || t0);
        if (st < bestStart - 1e-9) {
          bestStart = st;
          best = i;
        }
      }
      return { station: best, start: bestStart };
    };
    for (const op of ordered) {
      const dur = p.stepBase + p.stepPerBrick * Math.abs(op.count);
      const pick = pickStation(op.line.id);
      newSteps.push(
        newStep({
          kind: op.count > 0 ? "add" : "remove",
          lineId: op.line.id,
          count: Math.abs(op.count),
          station: pick.station + 1,
          start: round1(pick.start),
          duration: round1(dur),
          auto: true,
        })
      );
      stationAvail[pick.station] = pick.start + dur;
      lineAvail[op.line.id] = pick.start + dur;
      lastStation[op.line.id] = pick.station;
    }
    // 每行砖块操作完成后：复核 → 试运行
    const linesDone = queues
      .map((q) => q.line)
      .sort((a, b) => (lineAvail[a.id] || 0) - (lineAvail[b.id] || 0));
    for (const l of linesDone) {
      const stIdx = lastStation[l.id] != null ? lastStation[l.id] : 0;
      let t = Math.max(stationAvail[stIdx], lineAvail[l.id] || t0);
      newSteps.push(
        newStep({
          kind: "review", lineId: l.id, count: 1, station: stIdx + 1,
          start: round1(t), duration: p.reviewSeconds, auto: true,
        })
      );
      t += p.reviewSeconds;
      newSteps.push(
        newStep({
          kind: "test", lineId: l.id, count: 1, station: stIdx + 1,
          start: round1(t), duration: p.testSeconds, auto: true,
        })
      );
      t += p.testSeconds;
      stationAvail[stIdx] = t;
      lineAvail[l.id] = t;
    }

    const all = doneSteps.concat(newSteps);
    // 统一序号（按时间轴顺序）
    orderedSteps({ steps: all }).forEach((s, i) => (s.seq = i + 1));
    return all;
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  // ----------------------------------------------------------
  // 回放：t 时刻的各行状态（砖数按步骤进度插值）
  // ----------------------------------------------------------
  function replayState(sheet, t) {
    sheet = normalize(sheet);
    const bricks = {};
    for (const l of sheet.lines) bricks[l.id] = l.initialBricks;
    for (const s of orderedSteps(sheet)) {
      if (s.kind !== "add" && s.kind !== "remove") continue;
      const prog = clamp((t - s.start) / s.duration, 0, 1);
      if (prog <= 0) continue;
      bricks[s.lineId] =
        (bricks[s.lineId] || 0) + (s.kind === "add" ? s.count : -s.count) * prog;
    }
    const out = {};
    for (const l of sheet.lines) {
      const st = snapshot(sheet, l, Math.round(bricks[l.id] * 100) / 100);
      st.bricksExact = bricks[l.id];
      out[l.id] = st;
    }
    return out;
  }

  function metrics(sheet) {
    const a = simulate(sheet);
    return {
      completion: Math.round(a.summary.completion * 10) / 10,
      steps: a.summary.steps,
      doneSteps: a.summary.doneSteps,
      high: a.summary.high,
      medium: a.summary.medium,
      peakImbalance: a.summary.peakImbalance,
    };
  }

  global.CW = {
    KIND_LABEL,
    STATUS_LABEL,
    defaultParams,
    newBrickSpec,
    newLine,
    newStep,
    newSheet,
    normalize,
    brickOf,
    lineOf,
    stageWeight,
    maxBricks,
    targetBricks,
    orderedSteps,
    simulate,
    planSteps,
    replayState,
    metrics,
    uid,
    clamp,
  };
})(typeof window !== "undefined" ? window : globalThis);
