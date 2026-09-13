/* ============================================================
 * estop-engine.js —— 紧急停车演练单纯计算引擎（无 DOM 依赖）
 *
 * 模型：舞台监督在换景时间轴上选定急停触发时刻 T。
 * 触发后各吊杆先按原运动曲线继续运行「总控响应延迟 + 各杆制动延迟」，
 * 随后以应急减速度制动至停止。引擎推演制动距离、停止时刻与最终高度，
 * 定位越程、扫掠相交、侵入演员通行净空与联动组不同步。
 * 急停触发后控制台冻结：不再启动任何新提示。
 * 单位：长度 m，时间 s，速度 m/s，减速度 m/s²
 * ============================================================ */
(function (global) {
  "use strict";

  const EPS = 1e-9;
  const DT = 0.05; // 急停推演采样步长

  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round2 = (v) => Math.round(v * 100) / 100;

  const TYPE_LABEL = {
    overtravel: "越程",
    sweep: "扫掠相交",
    passage: "侵入通行净空",
    link: "联动不同步",
  };
  const STATUS_LABEL = { draft: "草稿", done: "已确认" };

  // ----------------------------------------------------------
  // 工厂与默认值
  // ----------------------------------------------------------
  function defaultParams() {
    return {
      responseDelay: 0.4, // 总控响应延迟 s（触发到制动指令下达）
      brakeDelay: 0.3, // 默认制动延迟 s（各杆可单独覆盖）
      decel: 1.2, // 默认应急减速度 m/s²
      scanFrom: 0, // 扫描时段起点 s
      scanTo: 0, // 扫描时段终点 s（0 = 自动：末条提示结束）
      scanStep: 0.5, // 扫描步长 s
      linkTimeTol: 0.15, // 联动停止时刻不同步容差 s
      linkPosTol: 0.1, // 联动终高偏差容差 m
    };
  }

  function newDrill(name) {
    return {
      name: name || "未命名演练单",
      projectId: null, // 来源沙盘项目
      projectName: "",
      versionId: null, // 来源版本（null = 项目当前数据）
      versionLabel: "",
      fingerprint: "", // 抓取来源时的数据指纹（来源变化后用于标记过期）
      project: null, // 抓取到的沙盘数据副本（确认后随单据冻结）
      trigger: 5, // 急停触发时刻 s
      params: defaultParams(),
      brakes: {}, // battenId -> {delay, decel} 各杆制动参数（缺省用 params）
      snapshot: null, // 确认时由服务端冻结的输入快照
    };
  }

  function normalize(drill) {
    if (!drill || typeof drill !== "object") drill = {};
    const out = {
      name: drill.name || "未命名演练单",
      projectId: drill.projectId == null ? null : drill.projectId,
      projectName: drill.projectName || "",
      versionId: drill.versionId == null ? null : drill.versionId,
      versionLabel: drill.versionLabel || "",
      fingerprint: drill.fingerprint || "",
      project: drill.project && typeof drill.project === "object" ? drill.project : null,
      trigger: Math.max(0, num(drill.trigger, 0)),
      params: Object.assign(defaultParams(), drill.params || {}),
      brakes: {},
      snapshot:
        drill.snapshot && typeof drill.snapshot === "object" ? drill.snapshot : null,
    };
    for (const k of Object.keys(defaultParams()))
      out.params[k] = num(out.params[k], defaultParams()[k]);
    out.params.responseDelay = clamp(out.params.responseDelay, 0, 10);
    out.params.brakeDelay = clamp(out.params.brakeDelay, 0, 10);
    out.params.decel = clamp(out.params.decel, 0.05, 10);
    out.params.scanStep = clamp(out.params.scanStep, 0.1, 5);
    const brakes = drill.brakes && typeof drill.brakes === "object" ? drill.brakes : {};
    for (const bid of Object.keys(brakes)) {
      const b = brakes[bid] || {};
      out.brakes[bid] = {
        delay: clamp(num(b.delay, out.params.brakeDelay), 0, 10),
        decel: clamp(num(b.decel, out.params.decel), 0.05, 10),
      };
    }
    return out;
  }

  // 某根吊杆的制动参数（未单独设置时用全局默认）
  function brakeFor(drill, battenId) {
    const b = drill.brakes && drill.brakes[battenId];
    return {
      delay: b ? b.delay : drill.params.brakeDelay,
      decel: b ? b.decel : drill.params.decel,
    };
  }

  // 来源数据指纹：规范化后按键序序列化，djb2 散列（来源变化只用于标记过期）
  function fingerprint(obj) {
    const s = JSON.stringify(obj, (k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.keys(v).sort().reduce((m, kk) => ((m[kk] = v[kk]), m), {})
        : v
    );
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  // ----------------------------------------------------------
  // 运动学：急停后的吊杆轨迹
  // ----------------------------------------------------------
  // 原曲线在 t 时刻的位置/速度；急停后（t > T）不再启动新提示
  function frozenState(proj, batten, t, T) {
    const E = global.E;
    const list = proj.cues
      .filter((c) => c.battenId === batten.id && c.start <= T + EPS)
      .sort((a, b) => a.start - b.start);
    let pos = batten.initialPos;
    for (const c of list) {
      const e = c.start + c.duration;
      if (t < c.start) break;
      if (t <= e + EPS) {
        if (c.dwell) {
          return { pos: c.fromPos == null ? pos : c.fromPos, vel: 0, cue: c };
        }
        const pf = E.cueProfile(proj, c);
        return { pos: pf.pos(t - c.start), vel: pf.vel(t - c.start), cue: c };
      }
      pos = c.dwell ? (c.fromPos == null ? pos : c.fromPos) : c.toPos;
    }
    return { pos, vel: 0, cue: null };
  }

  // 单杆停车方案：延迟期沿原曲线 → 应急减速至停止
  function stopPlan(proj, batten, T, responseDelay, brake) {
    const brakeStart = T + responseDelay + brake.delay;
    const atT = frozenState(proj, batten, T, T);
    const atB = frozenState(proj, batten, brakeStart, T);
    const a = Math.max(0.05, brake.decel);
    const v = atB.vel;
    const base = {
      battenId: batten.id,
      name: batten.name,
      brakeDelay: brake.delay,
      decel: a,
      brakeStart,
      posAtTrigger: atT.pos,
      velAtTrigger: atT.vel,
      posAtBrake: atB.pos,
      velAtBrake: v,
    };
    if (Math.abs(v) < 1e-6) {
      return Object.assign(base, {
        moving: false, stopTime: brakeStart, brakeDist: 0, finalPos: atB.pos,
      });
    }
    const dt = Math.abs(v) / a;
    const dist = (v * v) / (2 * a);
    return Object.assign(base, {
      moving: true,
      stopTime: brakeStart + dt,
      brakeDist: dist,
      finalPos: atB.pos + Math.sign(v) * dist,
    });
  }

  // 急停轨迹：t ≥ T 时吊杆位置
  function estopPos(proj, batten, plan, T, t) {
    if (t <= plan.brakeStart) return frozenState(proj, batten, t, T).pos;
    if (!plan.moving) return plan.finalPos;
    const tau = t - plan.brakeStart;
    const v0 = plan.velAtBrake;
    const a = plan.decel;
    if (tau >= Math.abs(v0) / a - EPS) return plan.finalPos;
    return plan.posAtBrake + v0 * tau - Math.sign(v0) * 0.5 * a * tau * tau;
  }

  // ----------------------------------------------------------
  // 推演与风险定位
  // ----------------------------------------------------------
  function simulate(drill, opts) {
    opts = opts || {};
    const E = global.E;
    drill = normalize(drill);
    if (!drill.project) return null;
    const proj = E.normalizeProject(drill.project);
    const p = drill.params;
    const T = clamp(drill.trigger, 0, E.horizon(proj));
    const battens = proj.battens;
    const bmap = {};
    for (const b of battens) bmap[b.id] = b;

    // ---- 各杆停车方案 ----
    const plans = battens.map((b) =>
      stopPlan(proj, b, T, p.responseDelay, brakeFor(drill, b.id))
    );
    const planOf = {};
    for (const pl of plans) planOf[pl.battenId] = pl;

    const moving = plans.filter((pl) => pl.moving);
    const stoppedAt = moving.length ? Math.max(...moving.map((pl) => pl.stopTime)) : T;
    const maxBrakeDist = moving.length ? Math.max(...moving.map((pl) => pl.brakeDist)) : 0;

    // ---- 采样定位：越程 / 扫掠相交 / 侵入通行净空 ----
    const warnings = [];
    const flush = {};
    function add(type, severity, key, t, battenIds, message, extra) {
      const holder = flush[type + "|" + key];
      if (holder && t <= holder.end + DT * 1.5) {
        holder.end = t;
        return;
      }
      const w = Object.assign(
        { type, severity, battenIds: battenIds || [], start: t, end: t, message },
        extra || {}
      );
      warnings.push(w);
      flush[type + "|" + key] = w;
    }

    const depthOf = (b) => [
      b.x - (b.prop ? b.prop.width : b.length) / 2,
      b.x + (b.prop ? b.prop.width : b.length) / 2,
    ];
    const pairs = [];
    for (let i = 0; i < battens.length; i++)
      for (let j = i + 1; j < battens.length; j++) {
        const [a0, a1] = depthOf(battens[i]);
        const [b0, b1] = depthOf(battens[j]);
        if (a0 < b1 && b0 < a1) pairs.push([battens[i], battens[j]]);
      }

    for (let t = T; t <= stoppedAt + DT * 0.5 + EPS; t += DT) {
      const posOf = {};
      for (const b of battens) posOf[b.id] = estopPos(proj, b, planOf[b.id], T, t);

      // 越程（急停推演轨迹超出行程限位）
      for (const b of battens) {
        const pos = posOf[b.id];
        if (pos < b.lowLimit - 0.01) {
          add("overtravel", "high", b.id + "|low", t, [b.id],
            b.name + " 急停越下限位（" + pos.toFixed(2) + "m ＜ " + b.lowLimit + "m）");
        } else if (pos > b.highLimit + 0.01) {
          add("overtravel", "high", b.id + "|high", t, [b.id],
            b.name + " 急停越上限位（" + pos.toFixed(2) + "m ＞ " + b.highLimit + "m）");
        }
      }

      // 扫掠相交（含安全净距）
      for (const [A, B] of pairs) {
        const ha = A.prop ? A.prop.height : 0, hb = B.prop ? B.prop.height : 0;
        const ca = A.prop ? A.prop.clearance : 0, cb = B.prop ? B.prop.clearance : 0;
        const a0 = posOf[A.id] - ha - ca, a1 = posOf[A.id] + ca;
        const b0 = posOf[B.id] - hb - cb, b1 = posOf[B.id] + cb;
        if (a0 < b1 && b0 < a1) {
          add("sweep", "high", A.id + "|" + B.id, t, [A.id, B.id],
            A.name + " 与 " + B.name + " 急停过程扫掠相交（含安全净距）");
        }
      }

      // 侵入演员通行净空（通行时段内吊物底进入净空高度以下）
      for (const occ of proj.occupancies) {
        if (t < occ.start - EPS || t > occ.start + occ.duration + EPS) continue;
        for (const b of battens) {
          if (!b.prop) continue;
          const [d0, d1] = depthOf(b);
          if (!(d0 < occ.x + occ.width && occ.x < d1)) continue;
          const bottom = posOf[b.id] - b.prop.height;
          if (bottom < proj.stage.passageY - 0.01) {
            add("passage", "high", b.id + "|" + occ.id, t, [b.id],
              b.name + " 急停后侵入「" + occ.name + "」通行净空（吊物底 " +
                bottom.toFixed(2) + "m ＜ " + proj.stage.passageY + "m）",
              { occId: occ.id });
          }
        }
      }
    }

    // ---- 联动组不同步（解析法：停止时刻差 / 终高偏差）----
    const groups = {};
    for (const c of proj.cues) {
      if (!c.linkGroup || c.start > T + EPS) continue;
      (groups[c.linkGroup] = groups[c.linkGroup] || {})[c.battenId] = true;
    }
    for (const g of Object.keys(groups)) {
      const parts = Object.keys(groups[g])
        .map((id) => planOf[id])
        .filter((pl) => pl && Math.abs(pl.velAtTrigger) > 1e-6);
      if (parts.length < 2) continue;
      const stopTimes = parts.map((pl) => pl.stopTime);
      const spreadT = Math.max(...stopTimes) - Math.min(...stopTimes);
      let spreadH = 0;
      for (let i = 0; i < parts.length; i++)
        for (let j = i + 1; j < parts.length; j++) {
          const d0 = parts[i].posAtTrigger - parts[j].posAtTrigger;
          const d1 = parts[i].finalPos - parts[j].finalPos;
          spreadH = Math.max(spreadH, Math.abs(d1 - d0));
        }
      if (spreadT > p.linkTimeTol + 1e-6 || spreadH > p.linkPosTol + 1e-6) {
        warnings.push({
          type: "link",
          severity: "medium",
          linkGroup: g,
          battenIds: parts.map((pl) => pl.battenId),
          start: Math.min(...stopTimes),
          end: Math.max(...stopTimes),
          message:
            "联动组「" + g + "」急停后不同步：停止时刻差 " + spreadT.toFixed(2) +
            "s，终高偏差 " + spreadH.toFixed(2) + "m",
        });
      }
    }

    warnings.forEach((w, i) => (w.id = "w" + i));
    warnings.sort((a, b) => a.start - b.start || b.severity.localeCompare(a.severity));

    // ---- 逐杆停车检查卡 ----
    const cards = plans.map((pl) => {
      const b = bmap[pl.battenId];
      const warns = warnings.filter(
        (w) => (w.battenIds || []).indexOf(pl.battenId) >= 0
      );
      const limit =
        pl.finalPos < b.lowLimit - 0.01 ? "low"
        : pl.finalPos > b.highLimit + 0.01 ? "high"
        : null;
      return {
        battenId: pl.battenId,
        name: b.name,
        propName: b.prop ? b.prop.name : "",
        moving: pl.moving,
        posAtTrigger: round2(pl.posAtTrigger),
        velAtTrigger: round2(pl.velAtTrigger),
        brakeDelay: pl.brakeDelay,
        decel: pl.decel,
        brakeStart: round2(pl.brakeStart),
        stopTime: round2(pl.stopTime),
        stopAfter: round2(pl.stopTime - T),
        brakeDist: round2(pl.brakeDist),
        finalPos: round2(pl.finalPos),
        finalLowest: round2(pl.finalPos - (b.prop ? b.prop.height : 0)),
        limit,
        level: warns.some((w) => w.severity === "high") ? "danger" : warns.length ? "warn" : "ok",
        messages: warns.map((w) => w.message),
      };
    });

    // ---- 轨迹曲线（视图叠加用；lite 模式跳过）----
    let curves = null;
    if (!opts.lite) {
      const chartEnd = Math.max(E.horizon(proj), stoppedAt + 1.5);
      const normal = {}, estop = {};
      for (const b of battens) {
        const nPts = [];
        for (let t = 0; t <= chartEnd + EPS; t += 0.1)
          nPts.push([round2(t), round2(E.battenState(proj, b, t).pos)]);
        normal[b.id] = nPts;
        const ePts = [];
        for (let t = T; t <= planOf[b.id].stopTime + 0.2 + EPS; t += DT)
          ePts.push([round2(t), round2(estopPos(proj, b, planOf[b.id], T, t))]);
        estop[b.id] = ePts;
      }
      curves = { t0: 0, t1: round2(chartEnd), normal, estop };
    }

    return {
      trigger: T,
      responseDelay: p.responseDelay,
      plans,
      cards,
      warnings,
      curves,
      stoppedAt: round2(stoppedAt),
      summary: {
        total: warnings.length,
        high: warnings.filter((w) => w.severity === "high").length,
        medium: warnings.filter((w) => w.severity === "medium").length,
        maxBrakeDist: round2(maxBrakeDist),
        allStopTime: round2(stoppedAt - T),
        stoppedAt: round2(stoppedAt),
        movingCount: moving.length,
        byType: warnings.reduce((m, w) => ((m[w.type] = (m[w.type] || 0) + 1), m), {}),
      },
    };
  }

  // ----------------------------------------------------------
  // 扫描：时段内逐点试触发，按 高危冲突数 → 最大制动距离 → 全部停止用时 排列
  // ----------------------------------------------------------
  function scan(drill, from, to, step) {
    const E = global.E;
    drill = normalize(drill);
    if (!drill.project) return { rows: [], scanned: 0 };
    const proj = E.normalizeProject(drill.project);
    const lastEnd = Math.max(0, ...proj.cues.map((c) => c.start + c.duration));
    const lo = Math.max(0, num(from, drill.params.scanFrom));
    let hi = num(to, 0);
    if (!(hi > lo)) hi = drill.params.scanTo > lo ? drill.params.scanTo : lastEnd;
    let st = clamp(num(step, drill.params.scanStep), 0.1, 5);
    if ((hi - lo) / st > 400) st = (hi - lo) / 400; // 计算量兜底
    const rows = [];
    for (let t = lo; t <= hi + EPS; t += st) {
      const d = Object.assign({}, drill, { trigger: round2(t) });
      const r = simulate(d, { lite: true });
      rows.push({
        t: round2(t),
        high: r.summary.high,
        medium: r.summary.medium,
        total: r.summary.total,
        maxBrakeDist: r.summary.maxBrakeDist,
        allStopTime: r.summary.allStopTime,
      });
    }
    const ranked = rows
      .slice()
      .sort(
        (a, b) =>
          b.high - a.high || b.maxBrakeDist - a.maxBrakeDist || b.allStopTime - a.allStopTime
      );
    return { rows: ranked, scanned: rows.length, from: lo, to: hi, step: round2(st) };
  }

  function metrics(drill) {
    const r = simulate(drill, { lite: true });
    if (!r)
      return { trigger: 0, high: 0, medium: 0, maxBrakeDist: 0, allStopTime: 0 };
    return {
      trigger: r.trigger,
      high: r.summary.high,
      medium: r.summary.medium,
      maxBrakeDist: r.summary.maxBrakeDist,
      allStopTime: r.summary.allStopTime,
    };
  }

  global.ES = {
    DT,
    TYPE_LABEL,
    STATUS_LABEL,
    defaultParams,
    newDrill,
    normalize,
    brakeFor,
    fingerprint,
    frozenState,
    stopPlan,
    estopPos,
    simulate,
    scan,
    metrics,
    num,
    clamp,
    round2,
  };
})(typeof window !== "undefined" ? window : globalThis);
