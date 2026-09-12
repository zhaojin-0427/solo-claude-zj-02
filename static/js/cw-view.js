/* cw-view.js —— 配重架正视图与装卸步骤时间轴（原生 SVG） */
(function (global) {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, parent) {
    const node = document.createElementNS(SVGNS, tag);
    for (const k in attrs || {}) {
      if (attrs[k] == null) continue;
      if (k === "text") node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  /* ============================================================
   * 配重架正视图：每根吊杆一列 —— 舞台侧重量条 / 配重架与砖块 /
   * 目标刻度 / 失衡量 / 配重架位置与装卸位 / 制动状态
   * ============================================================ */
  const CWArbor = {
    svg: null,
    handlers: {},
    sheet: null,
    states: null, // {lineId: {bricks, stageW, cwW, imbalance, remain}}
    selection: { type: null, id: null },

    init(svg, handlers) {
      this.svg = svg;
      this.handlers = handlers || {};
    },

    set(st) {
      this.sheet = st.sheet;
      this.states = st.states || {};
      this.selection = st.selection || this.selection;
      this.render();
    },

    render() {
      const svg = this.svg;
      if (!svg || !this.sheet) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const sheet = this.sheet;
      const lines = sheet.lines;
      const rect = svg.getBoundingClientRect();
      const viewH = Math.max(300, rect.height || 340);
      const COL_W = 150;
      const M = { l: 14, r: 14, t: 40, b: 52 };
      const width = Math.max(M.l + M.r + COL_W * Math.max(1, lines.length), rect.width || 0);
      svg.setAttribute("viewBox", "0 0 " + width + " " + viewH);
      svg.setAttribute("width", width);

      const chartH = viewH - M.t - M.b;
      const base = M.t + chartH;

      // 统一 kg 比例尺
      let maxKg = 60;
      for (const l of lines) {
        const st = this.states[l.id];
        const brick = CW.brickOf(sheet, l);
        const tgtW = CW.targetBricks(sheet, l) * (brick ? brick.weight : 0);
        maxKg = Math.max(
          maxKg, l.arborCapacity, tgtW,
          st ? st.stageW : 0, st ? st.cwW : 0
        );
      }
      const ks = chartH / (maxKg * 1.08);
      const p = sheet.params;

      if (!lines.length) {
        el("text", {
          x: width / 2, y: viewH / 2, "text-anchor": "middle",
          class: "cw-empty", text: "尚未添加吊杆行 —— 在右侧「吊杆行」页添加，或从换景沙盘生成",
        }, svg);
        return;
      }

      lines.forEach((l, i) => {
        const st = this.states[l.id] || {
          bricks: l.initialBricks, stageW: CW.stageWeight(l),
          cwW: 0, imbalance: CW.stageWeight(l), remain: l.arborCapacity,
        };
        const brick = CW.brickOf(sheet, l);
        const bw = brick ? brick.weight : 0;
        const tgt = CW.targetBricks(sheet, l);
        const x0 = M.l + i * COL_W;
        const selected = this.selection.type === "line" && this.selection.id === l.id;
        const g = el("g", { class: "cw-col", "data-id": l.id }, svg);

        if (selected)
          el("rect", {
            x: x0 + 2, y: 6, width: COL_W - 8, height: viewH - 12, rx: 8,
            class: "cw-col-selected",
          }, g);

        // 标题行：名称 + 锁定/制动标记
        el("text", {
          x: x0 + COL_W / 2 - 6, y: 20, "text-anchor": "middle", class: "cw-col-title",
          text:
            (l.propLocked || l.bricksLocked ? "🔒" : "") + l.name +
            (l.braked ? "" : " ⚠未制动"),
        }, g);
        // 失衡量
        const over = st.imbalance > p.maxImbalance + 1e-9;
        el("text", {
          x: x0 + COL_W / 2 - 6, y: 34, "text-anchor": "middle",
          class: "cw-delta " + (over ? "bad" : "ok"),
          text: "失衡 " + st.imbalance.toFixed(st.bricks % 1 ? 1 : 0) + " / ±" + p.maxImbalance + "kg",
        }, g);

        // ---- 舞台侧重量条（管身 + 吊物）----
        const sx = x0 + 20, sw = 30;
        const pipeH = l.pipeWeight * ks;
        const propH = l.propWeight * ks;
        el("rect", { x: sx, y: base - pipeH, width: sw, height: pipeH, class: "cw-bar-pipe" }, g);
        if (propH > 0)
          el("rect", { x: sx, y: base - pipeH - propH, width: sw, height: propH, class: "cw-bar-prop" }, g);
        el("text", {
          x: sx + sw / 2, y: base + 12, "text-anchor": "middle", class: "cw-axis",
          text: "舞台侧",
        }, g);
        el("text", {
          x: sx + sw / 2, y: base - pipeH - propH - 4, "text-anchor": "middle", class: "cw-kg",
          text: Math.round(st.stageW) + "kg",
        }, g);

        // ---- 配重架 ----
        const ax = x0 + 66, aw = 42;
        const capH = l.arborCapacity * ks;
        // 架体框
        el("rect", { x: ax, y: base - capH, width: aw, height: capH, class: "cw-arbor-frame" }, g);
        // 架顶横梁与吊绳示意
        el("line", { x1: ax - 6, y1: base - capH, x2: ax + aw + 6, y2: base - capH, class: "cw-arbor-top" }, g);
        el("line", { x1: ax + aw / 2, y1: base - capH, x2: ax + aw / 2, y2: M.t - 8, class: "cw-arbor-rope" }, g);
        // 砖块（自底向上，回放时可为分数）
        const bricks = Math.max(0, st.bricks);
        const fillH = Math.min(bricks * bw, Math.max(0, l.arborCapacity)) * ks;
        const overH = Math.max(0, bricks * bw - l.arborCapacity) * ks;
        el("rect", {
          x: ax + 2, y: base - fillH, width: aw - 4, height: Math.max(0, fillH),
          class: "cw-bricks" + (st.remain < -1e-9 ? " over" : ""),
        }, g);
        // 砖缝
        if (bw > 0 && bw * ks >= 5) {
          const n = Math.min(Math.floor(bricks), Math.floor(l.arborCapacity / bw));
          for (let k = 1; k <= n; k++) {
            const y = base - k * bw * ks;
            el("line", { x1: ax + 2, y1: y, x2: ax + aw - 2, y2: y, class: "cw-brick-seam" }, g);
          }
        }
        // 超容量红色警示区
        if (overH > 0.5) {
          el("rect", {
            x: ax + 2, y: base - capH - Math.min(overH, 26), width: aw - 4,
            height: Math.min(overH, 26), class: "cw-bricks-over",
          }, g);
        }
        // 目标刻度
        const ty = base - tgt * bw * ks;
        el("line", { x1: ax - 5, y1: ty, x2: ax + aw + 5, y2: ty, class: "cw-target-line" }, g);
        el("text", { x: ax + aw + 8, y: ty + 3, class: "cw-target-label", text: "目标" + tgt }, g);
        // 砖数与余量
        el("text", {
          x: ax + aw / 2, y: base + 12, "text-anchor": "middle", class: "cw-axis",
          text: "配重架",
        }, g);
        el("text", {
          x: ax + aw / 2, y: base + 24, "text-anchor": "middle",
          class: "cw-kg " + (st.remain < -1e-9 ? "bad" : ""),
          text:
            (st.bricks % 1 ? st.bricks.toFixed(1) : st.bricks) + "块 " +
            Math.round(st.cwW) + "kg",
        }, g);
        el("text", {
          x: ax + aw / 2, y: base + 36, "text-anchor": "middle",
          class: "cw-remain " + (st.remain < -1e-9 ? "bad" : "ok"),
          text: st.remain < -1e-9 ? "超容 " + Math.abs(st.remain).toFixed(0) + "kg" : "余量 " + st.remain.toFixed(0) + "kg",
        }, g);

        // ---- 配重架位置指示（装卸位）----
        const tx = x0 + 124, tw = 8;
        const posMax = Math.max(p.loadingPos, l.arborPos, 0.5) * 1.35;
        const posH = 54;
        const py = (v) => base - (v / posMax) * posH;
        el("rect", { x: tx, y: base - posH, width: tw, height: posH, class: "cw-pos-track" }, g);
        el("line", {
          x1: tx - 3, y1: py(p.loadingPos), x2: tx + tw + 3, y2: py(p.loadingPos),
          class: "cw-pos-loading",
        }, g);
        const atPos = Math.abs(l.arborPos - p.loadingPos) <= p.posTolerance + 1e-9;
        el("circle", {
          cx: tx + tw / 2, cy: py(l.arborPos), r: 4.5,
          class: "cw-pos-dot " + (atPos ? "ok" : "bad"),
        }, g);
        el("text", {
          x: tx + tw / 2, y: base + 12, "text-anchor": "middle", class: "cw-axis",
          text: "架位",
        }, g);

        // 点击选择
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handlers.onSelectLine && this.handlers.onSelectLine(l.id);
        });
      });

      // 图例（右上角，避免与首列底部标签重叠）
      const lx = Math.max(M.l, width - 330), ly = 14;
      el("rect", { x: lx, y: ly - 8, width: 10, height: 8, class: "cw-bar-pipe" }, svg);
      el("text", { x: lx + 14, y: ly, class: "cw-axis", text: "管身" }, svg);
      el("rect", { x: lx + 48, y: ly - 8, width: 10, height: 8, class: "cw-bar-prop" }, svg);
      el("text", { x: lx + 62, y: ly, class: "cw-axis", text: "吊物" }, svg);
      el("rect", { x: lx + 96, y: ly - 8, width: 10, height: 8, class: "cw-bricks" }, svg);
      el("text", { x: lx + 110, y: ly, class: "cw-axis", text: "已装砖块（绿线为目标，红框为超容）" }, svg);
    },
  };

  /* ============================================================
   * 步骤时间轴：行 = 装卸工位，块 = 步骤（加/减砖、复核、试运行）
   * ============================================================ */
  const CWTimeline = {
    svg: null,
    scroll: null,
    handlers: {},
    sheet: null,
    analysis: null,
    selection: { type: null, id: null },
    time: 0,
    replayOn: false,
    nextStepId: null,
    width: 0,
    height: 0,

    LABEL_W: 76,
    ROW_H: 32,
    HEADER_H: 20,
    WARN_H: 14,
    PXS: 6,

    init(svg, scrollEl, handlers) {
      this.svg = svg;
      this.scroll = scrollEl;
      this.handlers = handlers || {};
      this._bind();
    },

    set(st) {
      this.sheet = st.sheet;
      this.analysis = st.analysis;
      this.selection = st.selection || this.selection;
      this.time = st.time || 0;
      this.replayOn = !!st.replayOn;
      this.nextStepId = st.nextStepId || null;
      this.render();
    },

    timeToX(t) { return this.LABEL_W + t * this.PXS; },
    xToTime(x) { return (x - this.LABEL_W) / this.PXS; },

    render() {
      const svg = this.svg;
      if (!svg || !this.sheet) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const sheet = this.sheet;
      const stations = Math.max(1, sheet.params.stationCount);
      const end = Math.max(
        60,
        ...sheet.steps.map((s) => s.start + s.duration),
        this.time + 10
      );
      this.width = this.timeToX(end + 8);
      this.height = this.HEADER_H + this.WARN_H + stations * this.ROW_H + 8;
      svg.setAttribute("width", Math.max(this.width, (this.scroll.clientWidth || 200) - 2));
      svg.setAttribute("height", this.height);
      svg.setAttribute("viewBox", "0 0 " + this.width + " " + this.height);

      // 表头刻度
      const tick = end > 240 ? 30 : end > 120 ? 20 : 10;
      for (let t = 0; t <= end + tick; t += tick) {
        const X = this.timeToX(t);
        el("line", { x1: X, y1: this.HEADER_H, x2: X, y2: this.height, class: "tl-grid" }, svg);
        el("text", { x: X + 2, y: 13, class: "tl-row-label", text: t + "s" }, svg);
      }

      // 告警带
      if (this.analysis) {
        for (const w of this.analysis.warnings) {
          const x = this.timeToX(Math.max(0, w.start));
          const ww = Math.max(4, (w.end - w.start) * this.PXS);
          const r = el("rect", {
            x, y: this.HEADER_H + 1, width: ww, height: this.WARN_H - 3, rx: 2,
            class: "warn-strip" + (w.severity === "medium" ? " medium" : ""),
          }, svg);
          r.style.cursor = "pointer";
          r.addEventListener("click", (e) => {
            e.stopPropagation();
            this.handlers.onSelectWarning && this.handlers.onSelectWarning(w);
          });
          const tip = document.createElementNS(SVGNS, "title");
          tip.textContent = w.message;
          r.appendChild(tip);
        }
      }

      // 工位行
      const top = this.HEADER_H + this.WARN_H;
      for (let i = 0; i < stations; i++) {
        const y = top + i * this.ROW_H;
        el("rect", {
          x: 0, y, width: this.width, height: this.ROW_H - 1,
          class: "tl-row-bg" + (i % 2 ? " alt" : ""),
        }, svg);
        el("line", { x1: this.LABEL_W, y1: y, x2: this.LABEL_W, y2: y + this.ROW_H, class: "tl-grid" }, svg);
        el("text", {
          x: 8, y: y + this.ROW_H / 2 + 3, class: "tl-row-label",
          text: "工位 " + (i + 1),
        }, svg);
      }

      // 步骤块
      const lineName = {};
      for (const l of sheet.lines) lineName[l.id] = l.name;
      for (const s of CW.orderedSteps(sheet)) {
        if (s.station > stations) continue;
        const y = top + (s.station - 1) * this.ROW_H + 4;
        const x = this.timeToX(s.start);
        const w = Math.max(6, s.duration * this.PXS);
        const sel = this.selection.type === "step" && this.selection.id === s.id;
        const g = el("g", {
          class:
            "cw-step cw-step-" + s.kind +
            (s.status === "done" ? " done" : "") +
            (sel ? " selected" : "") +
            (this.nextStepId === s.id ? " next" : ""),
          "data-id": s.id,
        }, svg);
        el("rect", { x, y, width: w, height: this.ROW_H - 9, rx: 4 }, g);
        const nm = lineName[s.lineId] || "?";
        const label =
          s.kind === "add" ? nm + " +" + s.count
          : s.kind === "remove" ? nm + " −" + s.count
          : nm + " " + CW.KIND_LABEL[s.kind];
        el("text", {
          x: x + 5, y: y + (this.ROW_H - 9) / 2 + 3.5, class: "cue-label",
          text:
            (s.status === "done" ? "✓ " : "") +
            (label.length * 6.2 > w ? label.slice(0, Math.max(1, (w / 6.2) | 0)) : label),
        }, g);
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handlers.onSelectStep && this.handlers.onSelectStep(s.id);
        });
      }

      // 回放/执行游标
      if (this.replayOn || this.time > 0) {
        const X = this.timeToX(Math.max(0, this.time));
        el("line", {
          x1: X, y1: this.HEADER_H, x2: X, y2: this.height,
          class: "tl-playhead", "data-id": "__playhead",
        }, svg);
        el("polygon", {
          points: X + ",20 " + (X - 5) + ",12 " + (X + 5) + ",12",
          fill: "#fff", "data-id": "__playhead",
        }, svg);
      }
    },

    scrollToTime(t) {
      const X = this.timeToX(t);
      const sl = this.scroll.scrollLeft;
      if (X < sl + this.LABEL_W) this.scroll.scrollLeft = X - this.LABEL_W - 10;
      else if (X > sl + this.scroll.clientWidth - 30)
        this.scroll.scrollLeft = X - this.scroll.clientWidth + 30;
    },

    _bind() {
      const svg = this.svg;
      let drag = null;
      svg.addEventListener("mousedown", (e) => {
        const t = e.target;
        if (t.getAttribute && t.getAttribute("data-id") === "__playhead") {
          drag = { kind: "seek" };
          e.preventDefault();
        }
      });
      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const r = svg.getBoundingClientRect();
        const t = Math.max(0, this.xToTime(e.clientX - r.left));
        this.handlers.onSeek && this.handlers.onSeek(Math.round(t * 10) / 10);
      });
      window.addEventListener("mouseup", () => (drag = null));
    },
  };

  global.CWArbor = CWArbor;
  global.CWTimeline = CWTimeline;
})(window);
