/* ============================================================
 * engine.js —— 纯计算引擎（无 DOM 依赖）
 * 单位：长度 m，时间 s，速度 m/s，加速度 m/s²
 *
 * 运动模型：梯形/三角形速度曲线。
 * 给定起止位置、时长、最大速度 v 与最大加速度 a 时，
 * 优先用“固定加速度 a + 巡航”，巡航达不到 v 时退化为
 * 对称三角形（更小加速度）。时长不足则标记不可行。
 * ============================================================ */
(function (global) {
  "use strict";

  const DT = 0.1; // 分析采样步长

  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let _uidCounter = 0;
  const uid = (p) =>
    p + "_" + Date.now().toString(36) + "_" + (_uidCounter++).toString(36);

  // ----------------------------------------------------------
  // 默认数据 / 工厂
  // ----------------------------------------------------------
  function stageDefaults() {
    return {
      depth: 14, // 舞台进深（前后方向，m）
      height: 12, // 栅顶高度（m）
      prosceniumX: 1.5, // 台口距舞台前缘起
      maxConcurrent: 2, // 可同时操作吊杆数
      totalTime: 90, // 总换景时限（s）
      defaultVmax: 1.2, // 默认最大升降速度
      defaultAmax: 0.5, // 默认加速度
      passageY: 2.5, // 通行净空高度（m）
    };
  }

  function newBatten(x, i) {
    return {
      id: uid("b"),
      name: "吊杆 " + i,
      x: num(x, 3), // 吊杆在进深方向的中心位置
      length: 10, // 吊杆长度（横向，侧视图表现为前后覆盖长度）
      maxLoad: 200, // 额定载荷 kg
      vmax: 1.2,
      amax: 0.5,
      lowLimit: 0.3, // 最低行程位置（m）
      highLimit: 11.0, // 最高行程位置（m，近栅顶）
      initialPos: 10.5, // 初始停放高度
      prop: null,
    };
  }

  function newProp(kind) {
    return {
      id: uid("p"),
      name: kind === "curtain" ? "幕布" : kind === "light" ? "灯具排" : "布景",
      kind: kind || "scenery",
      width: 8,
      height: 3,
      weight: 60,
      hangingHeight: 10.5,
      clearance: 0.3,
    };
  }

  function newCue(o) {
    return Object.assign(
      {
        id: uid("c"),
        battenId: "",
        name: "升降",
        start: 0,
        duration: 4,
        fromPos: null,
        toPos: 8,
        vmax: null,
        amax: null,
        linkGroup: "",
        locked: false,
        dwell: false,
      },
      o || {}
    );
  }

  function newOcc(o) {
    return Object.assign(
      {
        id: uid("o"),
        name: "演员通行",
        start: 0,
        duration: 8,
        x: 2,
        width: 6,
      },
      o || {}
    );
  }

  function emptyProject() {
    return {
      stage: stageDefaults(),
      battens: [],
      cues: [],
      occupancies: [],
    };
  }

  // ----------------------------------------------------------
  // 规范化（从存储/旧数据恢复时兜底）
  // ----------------------------------------------------------
  function normalizeProject(p) {
    if (!p || typeof p !== "object") p = {};
    const s = Object.assign(stageDefaults(), p.stage || {});
    for (const k of Object.keys(stageDefaults()))
      s[k] = num(s[k], stageDefaults()[k]);

    const battens = (p.battens || []).map((b, i) => ({
      id: String(b.id || uid("b")),
      name: b.name || "吊杆 " + (i + 1),
      x: num(b.x, 3),
      length: num(b.length, 10),
      maxLoad: num(b.maxLoad, 200),
      vmax: num(b.vmax, s.defaultVmax),
      amax: num(b.amax, s.defaultAmax),
      lowLimit: num(b.lowLimit, 0.3),
      highLimit: num(b.highLimit, s.height - 1),
      initialPos: num(b.initialPos, s.height - 1.5),
      prop: b.prop
        ? {
            id: String(b.prop.id || uid("p")),
            name: b.prop.name || "吊物",
            kind: ["curtain", "light", "scenery"].indexOf(b.prop.kind) >= 0
              ? b.prop.kind
              : "scenery",
            width: num(b.prop.width, 8),
            height: num(b.prop.height, 3),
            weight: num(b.prop.weight, 60),
            hangingHeight: num(b.prop.hangingHeight, s.height - 1.5),
            clearance: num(b.prop.clearance, 0.3),
          }
        : null,
    }));

    const cues = (p.cues || []).map((c) => ({
      id: String(c.id || uid("c")),
      battenId: String(c.battenId || ""),
      name: c.name || "升降",
      start: num(c.start, 0),
      duration: Math.max(0, num(c.duration, 4)),
      fromPos: c.fromPos == null ? null : num(c.fromPos, 0),
      toPos: num(c.toPos, 0),
      vmax: c.vmax == null ? null : num(c.vmax, null),
      amax: c.amax == null ? null : num(c.amax, null),
      linkGroup: c.linkGroup || "",
      locked: !!c.locked,
      dwell: !!c.dwell,
    }));

    const occupancies = (p.occupancies || []).map((o) => ({
      id: String(o.id || uid("o")),
      name: o.name || "演员通行",
      start: num(o.start, 0),
      duration: Math.max(0, num(o.duration, 8)),
      x: num(o.x, 2),
      width: num(o.width, 6),
    }));

    // 同吊杆位置连续性：缺省 fromPos 自动接续
    const byB = {};
    for (const b of battens) byB[b.id] = b;
    const groups = {};
    for (const c of cues) (groups[c.battenId] = groups[c.battenId] || []).push(c);
    for (const bid of Object.keys(groups)) {
      const list = groups[bid].sort((a, b) => a.start - b.start);
      let pos = byB[bid] ? byB[bid].initialPos : 0;
      for (const c of list) {
        if (c.dwell) c.toPos = c.fromPos == null ? pos : c.fromPos;
        if (c.fromPos == null) c.fromPos = pos;
        pos = c.toPos;
      }
    }
    cues.sort((a, b) => a.start - b.start || a.duration - b.duration);

    return { stage: s, battens, cues, occupancies };
  }

  // ----------------------------------------------------------
  // 运动曲线
  // ----------------------------------------------------------
  // 最短运行时间（满速、满加速度）
  function minDuration(dist, v, a) {
    dist = Math.abs(dist);
    if (dist < 1e-9) return 0;
    const dTri = (v * v) / a; // 三角形刚好达到 v 的距离
    if (dist <= dTri) return 2 * Math.sqrt(dist / a);
    return v / a + dist / v;
  }

  // 构造曲线：返回 {feasible, kind, params... , pos(tau), vel(tau)}
  function buildProfile(from, to, duration, vmax, amax) {
    const D = to - from;
    const T = Math.max(0, duration);
    if (Math.abs(D) < 1e-6 || T < 1e-6) {
      return {
        feasible: Math.abs(D) < 1e-6,
        kind: "dwell",
        T,
        pos: () => from,
        vel: () => 0,
      };
    }
    const dir = D > 0 ? 1 : -1;
    const dist = Math.abs(D);
    const v = Math.max(1e-4, vmax);
    const a = Math.max(1e-4, amax);

    if (T < minDuration(D, v, a) - 1e-6) {
      // 不可行：用最短时间直线近似，供画面展示
      const Tmin = minDuration(D, v, a);
      const p = buildProfile(from, to, Tmin, v, a);
      p.feasible = false;
      return p;
    }

    // 对称三角形（固定 a）的峰值速度
    const vpTri = 0.5 * a * T;
    if (vpTri <= v + 1e-9) {
      const ta = T / 2;
      return {
        feasible: true,
        kind: "triangle",
        T,
        peakVel: vpTri,
        peakAcc: a,
        pos(tau) {
          let s;
          if (tau <= 0) s = 0;
          else if (tau >= T) s = dist;
          else if (tau <= ta) s = 0.5 * a * tau * tau;
          else s = dist - 0.5 * a * (T - tau) * (T - tau);
          return from + dir * s;
        },
        vel(tau) {
          if (tau <= 0 || tau >= T) return 0;
          return dir * (tau <= ta ? a * tau : a * (T - tau));
        },
      };
    }

    // 梯形：固定加速度 a，巡航速度 vc。
    // 由 T = vc/a + dist/vc（两端加速距离 + 巡航距离）解二次方程
    const vc =
      (a * T - Math.sqrt(Math.max(0, a * a * T * T - 4 * a * dist))) / 2;
    const ta = vc / a;
    const tc = T - 2 * ta;
    return {
      feasible: true,
      kind: "trapezoid",
      T,
      peakVel: vc,
      peakAcc: a,
      pos(tau) {
        let s;
        if (tau <= 0) s = 0;
        else if (tau < ta) s = 0.5 * a * tau * tau;
        else if (tau < ta + tc) s = 0.5 * a * ta * ta + vc * (tau - ta);
        else if (tau < T)
          s = dist - 0.5 * a * (T - tau) * (T - tau);
        else s = dist;
        return from + dir * s;
      },
      vel(tau) {
        if (tau <= 0 || tau >= T) return 0;
        if (tau < ta) return dir * a * tau;
        if (tau < ta + tc) return dir * vc;
        return dir * a * (T - tau);
      },
    };
  }

  function cueLimits(proj, cue) {
    return {
      vmax: cue.vmax != null && cue.vmax > 0 ? cue.vmax : proj.stage.defaultVmax,
      amax: cue.amax != null && cue.amax > 0 ? cue.amax : proj.stage.defaultAmax,
    };
  }

  function cueProfile(proj, cue) {
    const lim = cueLimits(proj, cue);
    return buildProfile(
      cue.fromPos == null ? 0 : cue.fromPos,
      cue.toPos,
      cue.dwell ? 0 : cue.duration,
      lim.vmax,
      lim.amax
    );
  }

  // ----------------------------------------------------------
  // 时间轴查询
  // ----------------------------------------------------------
  function horizon(proj) {
    let h = proj.stage.totalTime;
    for (const c of proj.cues) h = Math.max(h, c.start + c.duration);
    for (const o of proj.occupancies) h = Math.max(h, o.start + o.duration);
    return h + 1;
  }

  // 返回吊杆在 t 时刻的状态
  function battenState(proj, batten, t) {
    const list = proj.cues
      .filter((c) => c.battenId === batten.id)
      .sort((a, b) => a.start - b.start);
    let pos = batten.initialPos;
    let active = null;
    for (const c of list) {
      const e = c.start + c.duration;
      if (t < c.start) break;
      if (t <= e + 1e-9) {
        active = c;
        if (c.dwell) {
          pos = c.fromPos == null ? batten.initialPos : c.fromPos;
        } else {
          pos = cueProfile(proj, c).pos(t - c.start);
        }
        break;
      }
      pos = c.dwell ? (c.fromPos == null ? pos : c.fromPos) : c.toPos;
    }
    const propH = batten.prop ? batten.prop.height : 0;
    return { pos, lowest: pos - propH, cue: active, moving: !!(active && !active.dwell) };
  }

  // ----------------------------------------------------------
  // 安全分析
  // ----------------------------------------------------------
  function analyze(proj) {
    proj = normalizeProject(proj);
    const s = proj.stage;
    const warnings = [];
    const battens = proj.battens;
    const bmap = {};
    for (const b of battens) bmap[b.id] = b;

    // ---- 静态检查 ----
    for (const b of battens) {
      if (b.prop && b.prop.weight > b.maxLoad + 1e-9) {
        warnings.push({
          type: "overload",
          severity: "high",
          battenId: b.id,
          start: 0,
          end: horizon(proj),
          message: b.name + " 静载超载：" + b.prop.weight + "kg ＞ 额定 " + b.maxLoad + "kg",
        });
      }
    }

    // ---- 时间不可行（时长不足）----
    for (const c of proj.cues) {
      if (c.battenId && !bmap[c.battenId]) continue;
      if (c.dwell) continue;
      const pf = cueProfile(proj, c);
      if (!pf.feasible) {
        warnings.push({
          type: "time",
          severity: "high",
          battenId: c.battenId,
          cueId: c.id,
          start: c.start,
          end: c.start + c.duration,
          message:
            (bmap[c.battenId] ? bmap[c.battenId].name : "?") +
            "「" + c.name + "」时间不足：最短需 " +
            pf.T.toFixed(1) + "s",
        });
      }
    }

    // ---- 联动组一致性 ----
    const linkMap = {};
    for (const c of proj.cues)
      if (c.linkGroup) (linkMap[c.linkGroup] = linkMap[c.linkGroup] || []).push(c);
    for (const g of Object.keys(linkMap)) {
      const list = linkMap[g];
      const s0 = Math.min(...list.map((c) => c.start));
      const e1 = Math.max(...list.map((c) => c.start + c.duration));
      const s1 = Math.max(...list.map((c) => c.start));
      const e0 = Math.min(...list.map((c) => c.start + c.duration));
      if (s1 - s0 > 0.15 + 1e-6 || e1 - e0 > 0.15 + 1e-6) {
        warnings.push({
          type: "link",
          severity: "medium",
          linkGroup: g,
          battenIds: list.map((c) => c.battenId),
          cueIds: list.map((c) => c.id),
          start: s0,
          end: e1,
          message: "联动组「" + g + "」起止不同步（偏差 " +
            Math.max(s1 - s0, e1 - e0).toFixed(2) + "s）",
        });
      }
    }

    // ---- 同吊杆提示重叠 ----
    const byBatten = {};
    for (const c of proj.cues)
      (byBatten[c.battenId] = byBatten[c.battenId] || []).push(c);
    for (const bid of Object.keys(byBatten)) {
      const list = byBatten[bid].slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i++) {
        if (list[i].start < list[i - 1].start + list[i - 1].duration - 1e-6) {
          warnings.push({
            type: "overlap",
            severity: "high",
            battenId: bid,
            battenIds: [bid],
            cueIds: [list[i - 1].id, list[i].id],
            cueId: list[i].id,
            start: list[i].start,
            end: Math.min(
              list[i].start + list[i].duration,
              list[i - 1].start + list[i - 1].duration
            ),
            message:
              (bmap[bid] ? bmap[bid].name : "?") + " 上两个提示时段重叠",
          });
        }
      }
    }

    // ---- 深度方向有扫掠交集的吊杆对 ----
    const depthOf = (b) => [b.x - (b.prop ? b.prop.width : b.length) / 2, b.x + (b.prop ? b.prop.width : b.length) / 2];
    const pairs = [];
    for (let i = 0; i < battens.length; i++) {
      for (let j = i + 1; j < battens.length; j++) {
        const [a0, a1] = depthOf(battens[i]);
        const [b0, b1] = depthOf(battens[j]);
        if (a0 < b1 && b0 < a1) pairs.push([battens[i], battens[j]]);
      }
    }

    // ---- 时间采样 ----
    const H = horizon(proj);

    const groups = {}; // key -> 最后一条 interval（用于合并）
    const flush = {};

    function add(type, severity, key, t, battenIds, message, extra) {
      const g = groups[type + "|" + key];
      const holder = flush[type + "|" + key];
      if (holder && t <= holder.end + DT * 1.5) {
        holder.end = t;
        return;
      }
      const w = Object.assign(
        {
          type,
          severity,
          battenIds: battenIds || [],
          start: t,
          end: t,
          message,
        },
        extra || {}
      );
      warnings.push(w);
      flush[type + "|" + key] = w;
    }

    let peakParallel = 0;
    for (let t = 0; t <= H + 1e-9; t += DT) {
      const states = [];
      for (let bi = 0; bi < battens.length; bi++) {
        const b = battens[bi];
        const st = battenState(proj, b, t);
        states.push(Object.assign(st, { b }));
      }

      // 越程
      for (const st of states) {
        const b = st.b;
        if (st.pos < b.lowLimit - 0.01) {
          add(
            "overtravel",
            "high",
            b.id,
            t,
            [b.id],
            b.name + " 越下限位（" + st.pos.toFixed(2) + "m ＜ " + b.lowLimit + "m）",
            { cueId: st.cue ? st.cue.id : null }
          );
        } else if (st.pos > b.highLimit + 0.01) {
          add(
            "overtravel",
            "high",
            b.id,
            t,
            [b.id],
            b.name + " 越上限位（" + st.pos.toFixed(2) + "m ＞ " + b.highLimit + "m）",
            { cueId: st.cue ? st.cue.id : null }
          );
        }
      }

      // 动载超载（按 1.15 动载系数）
      for (const st of states) {
        if (st.moving && st.b.prop && st.b.prop.weight * 1.15 > st.b.maxLoad + 1e-9) {
          add(
            "overload",
            "high",
            st.b.id + "|dyn",
            t,
            [st.b.id],
            st.b.name + " 运行动载超载：" +
              Math.round(st.b.prop.weight * 1.15) + "kg ＞ " + st.b.maxLoad + "kg",
            { cueId: st.cue ? st.cue.id : null }
          );
        }
      }

      // 并发数
      const moving = states.filter((st) => st.moving);
      peakParallel = Math.max(peakParallel, moving.length);
      if (moving.length > s.maxConcurrent) {
        add(
          "concurrency",
          "high",
          "all",
          t,
          moving.map((m) => m.b.id),
          "并发动作 " + moving.length + " 路 ＞ 允许 " + s.maxConcurrent + " 路"
        );
      }

      // 相邻吊杆扫掠相交（计入各自安全净距）
      const spanOf = (st) => {
        const cl = st.b.prop ? st.b.prop.clearance : 0;
        const h = st.b.prop ? st.b.prop.height : 0;
        return [st.pos - h - cl, st.pos + cl];
      };
      for (const [A, B] of pairs) {
        const sa = states[battens.indexOf(A)];
        const sb = states[battens.indexOf(B)];
        const [a0, a1] = spanOf(sa);
        const [b0, b1] = spanOf(sb);
        if (a0 < b1 && b0 < a1) {
          add(
            "sweep",
            "high",
            A.id + "|" + B.id,
            t,
            [A.id, B.id],
            A.name + " 与 " + B.name + " 扫掠相交（含安全净距）",
            { cueId: sa.cue ? sa.cue.id : sb.cue ? sb.cue.id : null }
          );
        }
      }

      // 通行区未清空便落景
      for (const st of states) {
        if (!st.moving || !st.b.prop) continue;
        const cue = st.cue;
        const goingDown = cue.toPos < cue.fromPos;
        if (!goingDown) continue;
        const [d0, d1] = depthOf(st.b);
        for (const occ of proj.occupancies) {
          const within = t >= occ.start - 1e-9 && t <= occ.start + occ.duration + 1e-9;
          if (!within) continue;
          const overlapDepth = d0 < occ.x + occ.width && occ.x < d1;
          if (overlapDepth && st.lowest < s.passageY - 1e-9) {
            add(
              "passage",
              "high",
              st.b.id + "|" + occ.id,
              t,
              [st.b.id],
              st.b.name + " 在「" + occ.name + "」未清空时落入通行净空",
              { cueId: cue.id, occId: occ.id }
            );
          }
        }
      }
    }

    // ---- 总时限 ----
    const completion = Math.max(
      ...proj.cues.map((c) => c.start + c.duration),
      ...proj.occupancies.map((o) => o.start + o.duration),
      0
    );
    if (completion > s.totalTime + 1e-9) {
      warnings.push({
        type: "deadline",
        severity: "medium",
        start: s.totalTime,
        end: completion,
        message:
          "换景完成于 " + completion.toFixed(1) + "s，超过总时限 " + s.totalTime + "s",
      });
    }

    // 统一编号、排序
    warnings.forEach((w, i) => (w.id = "w" + i));
    warnings.sort((a, b) => a.start - b.start || b.severity.localeCompare(a.severity));

    const summary = {
      completion,
      peakParallel,
      total: warnings.length,
      high: warnings.filter((w) => w.severity === "high").length,
      medium: warnings.filter((w) => w.severity === "medium").length,
      byType: warnings.reduce((m, w) => ((m[w.type] = (m[w.type] || 0) + 1), m), {}),
    };
    return { warnings, summary };
  }

  // ----------------------------------------------------------
  // 自动排程（锁定提示保持不动，重排其余）
  // ----------------------------------------------------------
  function _intervalOverlap(a0, a1, b0, b1) {
    return a0 < b1 - 1e-6 && b0 < a1 - 1e-6;
  }

  function _passageEntry(proj, batten, cue, start) {
    // 落景过程中吊物底部到达通行净空高度的时刻（相对整个时间轴）
    const pf = cueProfile(proj, cue);
    const h = batten.prop ? batten.prop.height : 0;
    const targetY = proj.stage.passageY + h;
    if (cue.toPos - h >= proj.stage.passageY - 1e-9) return null;
    let entry = start + cue.duration;
    for (let tau = 0; tau <= cue.duration + 1e-9; tau += DT) {
      if (pf.pos(tau) <= targetY + 1e-9) {
        entry = start + tau;
        break;
      }
    }
    return entry;
  }

  function planVariants(proj) {
    proj = normalizeProject(proj);
    const s = proj.stage;
    const bmap = {};
    for (const b of proj.battens) bmap[b.id] = b;

    const moveCues = proj.cues.filter((c) => !c.dwell && bmap[c.battenId]);
    const locked = moveCues.filter((c) => c.locked);
    const unlocked = moveCues.filter((c) => !c.locked);

    // 联动组成组
    const groupOf = {};
    const linkMembers = {};
    for (const c of unlocked) {
      if (!c.linkGroup) continue;
      // 组成员含锁定提示时，该组整体不可移动
      const lockedPeer = locked.some((l) => l.linkGroup === c.linkGroup);
      if (lockedPeer) {
        locked.push(c); // 视为固定
        continue;
      }
      (linkMembers[c.linkGroup] = linkMembers[c.linkGroup] || []).push(c);
    }
    const free = unlocked.filter((c) => !locked.includes(c));

    // 任务：单项 或 联动组
    const tasks = [];
    const inGroup = {};
    for (const g of Object.keys(linkMembers)) {
      const members = linkMembers[g];
      members.forEach((m) => (inGroup[m.id] = true));
      tasks.push({ kind: "link", group: g, members });
    }
    for (const c of free) if (!inGroup[c.id]) tasks.push({ kind: "single", members: [c] });

    const variants = [
      { key: "fast-early", label: "均衡·全速", factor: 1, order: "early" },
      { key: "fast-heavy", label: "重载优先·全速", factor: 1, order: "heavy" },
      { key: "fast-path", label: "长行程优先·全速", factor: 1, order: "path" },
      { key: "gentle-early", label: "均衡·平稳(75%)", factor: 0.75, order: "early" },
    ];

    const depthOf = (b) => [b.x - (b.prop ? b.prop.width : b.length) / 2, b.x + (b.prop ? b.prop.width : b.length) / 2];
    const pairSet = new Set();
    for (let i = 0; i < proj.battens.length; i++)
      for (let j = i + 1; j < proj.battens.length; j++) {
        const A = proj.battens[i], B = proj.battens[j];
        if (depthOf(A)[0] < depthOf(B)[1] && depthOf(B)[0] < depthOf(A)[1])
          pairSet.add(A.id + "|" + B.id);
      }
    const isPair = (id1, id2) =>
      pairSet.has(id1 + "|" + id2) || pairSet.has(id2 + "|" + id1);

    function run(variant) {
      // 资源占用表（均含锁定提示）
      const batBusy = {}; // battenId -> [{s,e,cue}]
      const movingAll = []; // 全局运动区间
      const sweepBusy = {}; // battenId -> 全局中与自己扫掠冲突的运动
      const passBusy = {}; // occId -> [{s,e}]
      for (const b of proj.battens) batBusy[b.id] = [];
      for (const o of proj.occupancies) passBusy[o.id] = [];

      const addMove = (cue, b, s0, e0) => {
        movingAll.push({ s: s0, e: e0, batten: b.id });
        (sweepBusy[b.id] = sweepBusy[b.id] || []).push({ s: s0, e: e0 });
      };
      for (const c of locked) {
        const b = bmap[c.battenId];
        const e = c.start + c.duration;
        batBusy[b.id].push({ s: c.start, e, cue: c });
        addMove(c, b, c.start, e);
        if (c.toPos < c.fromPos) {
          const entry = _passageEntry(proj, b, c, c.start);
          if (entry != null)
            for (const occ of proj.occupancies) {
              const [d0, d1] = [b.x - (b.prop ? b.prop.width : b.length) / 2, b.x + (b.prop ? b.prop.width : b.length) / 2];
              if (d0 < occ.x + occ.width && occ.x < d1)
                passBusy[occ.id].push({ s: entry, e });
            }
        }
      }
      // 停留提示与所有移动提示同样占用吊杆，不可被重叠
      for (const c of proj.cues) {
        if (c.dwell && bmap[c.battenId])
          batBusy[c.battenId].push({ s: c.start, e: c.start + c.duration, cue: c });
      }

      // 每个任务的时长
      for (const t of tasks) {
        t.durs = t.members.map((c) => {
          const lim = cueLimits(proj, c);
          return minDuration(c.toPos - (c.fromPos == null ? 0 : c.fromPos), lim.vmax, lim.amax) /
            variant.factor;
        });
        t.dur = Math.max(...t.durs);
      }

      const sorted = tasks.slice().sort((a, b) => {
        if (variant.order === "heavy") {
          const wa = Math.max(...a.members.map((c) => (bmap[c.battenId].prop || { weight: 0 }).weight));
          const wb = Math.max(...b.members.map((c) => (bmap[c.battenId].prop || { weight: 0 }).weight));
          if (wb !== wa) return wb - wa;
        }
        if (variant.order === "path") {
          const pa = Math.max(...a.members.map((c) => Math.abs(c.toPos - (c.fromPos == null ? 0 : c.fromPos))));
          const pb = Math.max(...b.members.map((c) => Math.abs(c.toPos - (c.fromPos == null ? 0 : c.fromPos))));
          if (pb !== pa) return pb - pa;
        }
        const sa = Math.min(...a.members.map((c) => c.start));
        const sb = Math.min(...b.members.map((c) => c.start));
        return sa - sb;
      });

      const HARD_LIMIT = Math.max(s.totalTime * 4, 1200);

      function feasible(start, t) {
        const e = start + t.dur;
        // 1. 各自吊杆不重叠
        for (const c of t.members) {
          const b = bmap[c.battenId];
          for (const iv of batBusy[b.id])
            if (_intervalOverlap(start, e, iv.s, iv.e)) return false;
        }
        // 2. 并发数（0.1s 采样）
        for (let tt = start; tt <= e + 1e-9; tt += DT) {
          let n = 0;
          for (const iv of movingAll) if (tt >= iv.s - 1e-9 && tt <= iv.e + 1e-9) n++;
          // 组内各吊杆同时计入
          const memberSet = new Set(t.members.map((c) => c.battenId));
          n += memberSet.size;
          if (n > s.maxConcurrent) return false;
        }
        // 3. 扫掠互斥
        for (const c of t.members) {
          const bid = c.battenId;
          for (const otherId of Object.keys(sweepBusy)) {
            if (otherId === bid || !isPair(bid, otherId)) continue;
            for (const iv of sweepBusy[otherId])
              if (_intervalOverlap(start, e, iv.s, iv.e)) return false;
          }
        }
        // 4. 通行区：只约束落景
        for (const c of t.members) {
          const b = bmap[c.battenId];
          if (c.toPos >= c.fromPos) continue;
          const entryT = (() => {
            const h = b.prop ? b.prop.height : 0;
            if (c.toPos - h >= s.passageY - 1e-9) return null;
            const fake = Object.assign({}, c, { start, duration: t.dur });
            return _passageEntry(proj, b, fake, start);
          })();
          if (entryT == null) continue;
          const [d0, d1] = [b.x - (b.prop ? b.prop.width : b.length) / 2, b.x + (b.prop ? b.prop.width : b.length) / 2];
          for (const occ of proj.occupancies) {
            if (!(d0 < occ.x + occ.width && occ.x < d1)) continue;
            // 通行时间本身
            if (_intervalOverlap(entryT, e, occ.start, occ.start + occ.duration))
              return false;
            for (const iv of passBusy[occ.id])
              if (_intervalOverlap(entryT, e, iv.s, iv.e)) return false;
          }
        }
        return true;
      }

      const placements = [];
      for (const t of sorted) {
        const earliest = Math.max(
          0,
          ...t.members.map((c) => {
            let m = 0;
            for (const iv of batBusy[c.battenId]) m = Math.max(m, iv.e);
            return m;
          })
        );
        let start = earliest;
        const step = 0.5;
        let ok = false;
        for (; start <= HARD_LIMIT; start += step) {
          if (feasible(start, t)) {
            ok = true;
            break;
          }
        }
        if (!ok) start = earliest; // 超限硬放（会在分析中报警）
        const e = start + t.dur;
        for (const c of t.members) {
          c.start = Math.round(start * 10) / 10;
          c.duration = Math.round(t.dur * 10) / 10;
          const b = bmap[c.battenId];
          batBusy[b.id].push({ s: start, e, cue: c });
          addMove(c, b, start, e);
          if (c.toPos < c.fromPos) {
            const [d0, d1] = [b.x - (b.prop ? b.prop.width : b.length) / 2, b.x + (b.prop ? b.prop.width : b.length) / 2];
            const fake = Object.assign({}, c, { start, duration: t.dur });
            const entry = _passageEntry(proj, b, fake, start);
            if (entry != null)
              for (const occ of proj.occupancies)
                if (d0 < occ.x + occ.width && occ.x < d1)
                  passBusy[occ.id].push({ s: entry, e });
          }
        }
        placements.push({ start, end: e, task: t });
      }

      // dwell 提示保持原位
      const resultCues = proj.cues.map((c) => {
        const hit = placements.find((pl) => pl.task.members.includes(c));
        if (!hit) return Object.assign({}, c);
        return Object.assign({}, c, {
          start: Math.round(hit.start * 10) / 10,
          duration: Math.round(hit.task.dur * 10) / 10,
        });
      });

      const candidate = normalizeProject(
        Object.assign({}, proj, { cues: resultCues })
      );
      const res = analyze(candidate);
      return {
        key: variant.key,
        label: variant.label,
        data: candidate,
        metrics: {
          conflicts: res.summary.total,
          high: res.summary.high,
          peakParallel: res.summary.peakParallel,
          completion: Math.round(res.summary.completion * 10) / 10,
          withinDeadline: res.summary.completion <= s.totalTime + 1e-9,
          byType: res.summary.byType,
        },
      };
    }

    const results = variants.map(run);
    const rank = (m) => [m.conflicts, m.peakParallel, m.completion];
    let bestIdx = 0;
    for (let i = 1; i < results.length; i++) {
      const a = rank(results[i].metrics), b = rank(results[bestIdx].metrics);
      if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]))))
        bestIdx = i;
    }
    results[bestIdx].best = true;
    return results;
  }

  global.E = {
    DT,
    uid,
    num,
    clamp,
    stageDefaults,
    newBatten,
    newProp,
    newCue,
    newOcc,
    emptyProject,
    normalizeProject,
    minDuration,
    buildProfile,
    cueProfile,
    cueLimits,
    horizon,
    battenState,
    analyze,
    planVariants,
  };
})(window);
