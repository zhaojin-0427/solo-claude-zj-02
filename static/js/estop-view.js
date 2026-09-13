/* estop-view.js —— 急停演练视图：轨迹叠加图（可拖触发线）+ 舞台侧视叠加（原生 SVG） */
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

  // 各吊杆轨迹配色（正常轨迹低透明虚线，急停轨迹实线）
  const PALETTE = ["#4aa8ff", "#7bd17b", "#ffb347", "#d98cd9", "#ff9d7a", "#6fd6d6"];

  function ptsToAttr(pts) {
    return pts.map((p) => p[0] + "," + p[1]).join(" ");
  }

  /* ============================================================
   * 轨迹叠加图：横轴时间 s，纵轴高度 m
   * 正常曲线（虚线）与急停曲线（实线）叠加；红色触发线可拖动，
   * 白色游标可拖动定位风险时刻；顶部告警带可点选。
   * ============================================================ */
  const ESChart = {
    svg: null,
    scroll: null,
    handlers: {},
    proj: null,
    sim: null,
    trigger: 0,
    cursor: 0,
    selection: { type: null, id: null },
    width: 0,
    height: 270,

    ML: 40, // 左：高度刻度
    MR: 118, // 右：吊杆图例
    MT: 30, // 上：告警带 + 触发手柄
    MB: 22, // 下：时间刻度
    PXS: 10,

    init(svg, scrollEl, handlers) {
      this.svg = svg;
      this.scroll = scrollEl;
      this.handlers = handlers || {};
      this._bind();
    },

    set(st) {
      this.proj = st.proj;
      this.sim = st.sim;
      this.trigger = st.trigger || 0;
      this.cursor = st.cursor || 0;
      this.selection = st.selection || this.selection;
      this.render();
    },

    timeToX(t) { return this.ML + t * this.PXS; },
    xToTime(x) { return (x - this.ML) / this.PXS; },
    yToPx(y) {
      const h = this.proj ? this.proj.stage.height : 12;
      return this.MT + (this.height - this.MT - this.MB) * (1 - y / h);
    },

    render() {
      const svg = this.svg;
      if (!svg || !this.proj || !this.sim) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const proj = this.proj;
      const sim = this.sim;
      const s = proj.stage;
      const T = this.trigger;
      const end = Math.max(sim.curves ? sim.curves.t1 : 10, 10);
      this.width = this.timeToX(end + 1) + this.MR;
      svg.setAttribute("width", Math.max(this.width, (this.scroll.clientWidth || 200) - 2));
      svg.setAttribute("height", this.height);
      svg.setAttribute("viewBox", "0 0 " + this.width + " " + this.height);

      const plotB = this.height - this.MB;

      // ---- 网格与刻度 ----
      const tick = end > 120 ? 20 : end > 60 ? 10 : 5;
      for (let t = 0; t <= end + tick * 0.5; t += tick) {
        const X = this.timeToX(t);
        el("line", { x1: X, y1: this.MT, x2: X, y2: plotB, class: "tl-grid" }, svg);
        el("text", { x: X + 2, y: this.height - 8, class: "tl-row-label", text: t + "s" }, svg);
      }
      for (let y = 0; y <= Math.floor(s.height); y += 2) {
        const Y = this.yToPx(y);
        el("line", { x1: this.ML, y1: Y, x2: this.timeToX(end), y2: Y, class: "tl-grid" }, svg);
        el("text", { x: this.ML - 5, y: Y + 3, "text-anchor": "end", class: "tl-row-label", text: y }, svg);
      }

      // ---- 演员通行时段（竖向绿带）----
      for (const occ of proj.occupancies) {
        const x0 = this.timeToX(occ.start);
        const x1 = this.timeToX(occ.start + occ.duration);
        el("rect", {
          x: x0, y: this.MT, width: Math.max(2, x1 - x0), height: plotB - this.MT,
          class: "es-occ-band",
        }, svg);
        el("text", { x: x0 + 3, y: this.MT + 22, class: "es-occ-label", text: occ.name }, svg);
      }

      // ---- 通行净空高度线 ----
      el("line", {
        x1: this.ML, y1: this.yToPx(s.passageY), x2: this.timeToX(end), y2: this.yToPx(s.passageY),
        class: "es-passage-line",
      }, svg);
      el("text", {
        x: this.timeToX(end) - 4, y: this.yToPx(s.passageY) - 3, "text-anchor": "end",
        class: "es-passage-label", text: "通行净空 " + s.passageY + "m",
      }, svg);

      // ---- 选中吊杆的行程限位 ----
      const selB =
        this.selection.type === "batten"
          ? proj.battens.find((b) => b.id === this.selection.id)
          : null;
      if (selB) {
        for (const lim of [selB.lowLimit, selB.highLimit]) {
          el("line", {
            x1: this.ML, y1: this.yToPx(lim), x2: this.timeToX(end), y2: this.yToPx(lim),
            class: "limit-line",
          }, svg);
        }
      }

      // ---- 总控响应延迟区（触发 → 制动指令下达）----
      const rx0 = this.timeToX(T);
      const rx1 = this.timeToX(T + (sim.responseDelay || 0));
      el("rect", {
        x: rx0, y: this.MT, width: Math.max(1, rx1 - rx0), height: plotB - this.MT,
        class: "es-resp-band",
      }, svg);

      // ---- 轨迹曲线：正常（虚线）+ 急停（实线）----
      if (sim.curves) {
        proj.battens.forEach((b, i) => {
          const color = PALETTE[i % PALETTE.length];
          const nPts = (sim.curves.normal[b.id] || []).map((p) => [
            this.timeToX(p[0]), this.yToPx(p[1]),
          ]);
          if (nPts.length > 1)
            el("polyline", {
              points: ptsToAttr(nPts), class: "es-curve-normal", stroke: color,
            }, svg);
        });
        proj.battens.forEach((b, i) => {
          const color = PALETTE[i % PALETTE.length];
          const ePts = (sim.curves.estop[b.id] || []).map((p) => [
            this.timeToX(p[0]), this.yToPx(p[1]),
          ]);
          if (ePts.length > 1)
            el("polyline", {
              points: ptsToAttr(ePts), class: "es-curve-estop", stroke: color,
            }, svg);
        });
      }

      // ---- 制动介入刻度与停止点 ----
      const planOf = {};
      for (const pl of sim.plans) planOf[pl.battenId] = pl;
      proj.battens.forEach((b, i) => {
        const pl = planOf[b.id];
        if (!pl) return;
        const color = PALETTE[i % PALETTE.length];
        if (pl.moving) {
          // 制动介入点
          el("circle", {
            cx: this.timeToX(pl.brakeStart), cy: this.yToPx(pl.posAtBrake), r: 3,
            class: "es-brake-dot", stroke: color,
          }, svg);
          // 停止点
          const sx = this.timeToX(pl.stopTime), sy = this.yToPx(pl.finalPos);
          el("circle", { cx: sx, cy: sy, r: 4.5, class: "es-stop-dot" }, svg);
          el("text", {
            x: sx + 6, y: sy + 3, class: "es-stop-label",
            text: pl.finalPos.toFixed(2) + "m",
          }, svg);
        }
      });

      // ---- 告警带（顶部，可点选）----
      for (const w of sim.warnings) {
        const x = this.timeToX(Math.max(0, w.start));
        const ww = Math.max(4, (w.end - w.start) * this.PXS);
        const r = el("rect", {
          x, y: 4, width: ww, height: 12, rx: 2,
          class: "warn-strip" + (w.severity === "medium" ? " medium" : "") +
            (this.selection.type === "warning" && this.selection.id === w.id ? " sel" : ""),
        }, svg);
        r.style.cursor = "pointer";
        r.style.pointerEvents = "all";
        r.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handlers.onSelectWarning && this.handlers.onSelectWarning(w);
        });
        const tip = document.createElementNS(SVGNS, "title");
        tip.textContent = w.message;
        r.appendChild(tip);
      }

      // ---- 急停触发线（可拖动）----
      const TX = this.timeToX(T);
      el("line", {
        x1: TX, y1: 2, x2: TX, y2: plotB, class: "es-trigger-line", "data-id": "__trigger",
      }, svg);
      el("polygon", {
        points: TX + ",16 " + (TX - 7) + ",4 " + (TX + 7) + ",4",
        class: "es-trigger-handle", "data-id": "__trigger",
      }, svg);
      el("text", {
        x: TX + 8, y: 12, class: "es-trigger-label", "data-id": "__trigger",
        text: "急停 " + T.toFixed(1) + "s",
      }, svg);

      // ---- 回放游标（可拖动）----
      const CX = this.timeToX(Math.max(0, this.cursor));
      el("line", {
        x1: CX, y1: this.MT - 6, x2: CX, y2: plotB, class: "tl-playhead", "data-id": "__cursor",
      }, svg);

      // ---- 图例（右侧，点击选杆）----
      const lx = this.timeToX(end) + 10;
      proj.battens.forEach((b, i) => {
        const y = this.MT + 4 + i * 18;
        const g = el("g", { class: "es-legend-item", "data-id": b.id }, svg);
        el("line", {
          x1: lx, y1: y - 3, x2: lx + 16, y2: y - 3,
          stroke: PALETTE[i % PALETTE.length], "stroke-width": 2.5,
        }, g);
        el("text", {
          x: lx + 21, y, class: "tl-row-label",
          text: b.name.length > 7 ? b.name.slice(0, 7) + "…" : b.name,
        }, g);
        if (this.selection.type === "batten" && this.selection.id === b.id)
          el("rect", {
            x: lx - 4, y: y - 12, width: this.MR - 18, height: 16, rx: 3,
            class: "es-legend-sel",
          }, g);
        g.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handlers.onSelectBatten && this.handlers.onSelectBatten(b.id);
        });
      });
      el("text", { x: lx, y: this.MT + 4 + proj.battens.length * 18 + 4, class: "es-legend-hint",
        text: "虚=原计划 实=急停" }, svg);
    },

    scrollToTime(t) {
      const X = this.timeToX(t);
      const sl = this.scroll.scrollLeft;
      if (X < sl + this.ML) this.scroll.scrollLeft = X - this.ML - 10;
      else if (X > sl + this.scroll.clientWidth - 40)
        this.scroll.scrollLeft = X - this.scroll.clientWidth + 40;
    },

    _bind() {
      const svg = this.svg;
      let drag = null;
      svg.addEventListener("mousedown", (e) => {
        const t = e.target;
        const id = t.getAttribute && t.getAttribute("data-id");
        if (id === "__trigger") {
          drag = { kind: "trigger" };
          e.preventDefault();
          return;
        }
        // 其余位置按下：拖动回放游标
        if (t.closest && t.closest(".es-legend-item")) return;
        drag = { kind: "seek" };
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const r = svg.getBoundingClientRect();
        const t = Math.max(0, Math.round(this.xToTime(e.clientX - r.left) * 10) / 10);
        if (drag.kind === "trigger") {
          this.handlers.onTrigger && this.handlers.onTrigger(t);
        } else {
          this.handlers.onSeek && this.handlers.onSeek(t);
        }
      });
      window.addEventListener("mouseup", () => (drag = null));
    },
  };

  /* ============================================================
   * 舞台侧视叠加：实杆=急停推演位置，紫虚影=原计划位置
   * ============================================================ */
  const ESStage = {
    svg: null,
    handlers: {},
    proj: null,
    sim: null,
    cursor: 0,
    selection: { type: null, id: null },
    MARGIN: { l: 46, r: 16, t: 30, b: 28 },

    init(svg, handlers) {
      this.svg = svg;
      this.handlers = handlers || {};
    },

    set(st) {
      this.proj = st.proj;
      this.sim = st.sim;
      this.cursor = st.cursor || 0;
      this.selection = st.selection || this.selection;
      this.render();
    },

    render() {
      const svg = this.svg;
      if (!svg || !this.proj || !this.sim) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const proj = this.proj;
      const sim = this.sim;
      const s = proj.stage;
      const E = global.E;
      const M = this.MARGIN;
      const rect = svg.getBoundingClientRect();
      const W = Math.max(320, rect.width || 640), H = Math.max(240, rect.height || 320);
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      const scale = Math.min((W - M.l - M.r) / s.depth, (H - M.t - M.b) / s.height);
      const offX = M.l + (W - M.l - M.r - s.depth * scale) / 2;
      const offY = M.t + (H - M.t - M.b - s.height * scale) / 2;
      const xToPx = (x) => offX + x * scale;
      const yToPx = (y) => offY + (s.height - y) * scale;

      // 网格 / 台面 / 栅顶
      for (let x = 0; x <= Math.floor(s.depth); x += 2)
        el("line", { x1: xToPx(x), y1: offY, x2: xToPx(x), y2: yToPx(0), class: "grid-line" }, svg);
      for (let y = 0; y <= Math.floor(s.height); y += 2) {
        el("line", { x1: offX, y1: yToPx(y), x2: xToPx(s.depth), y2: yToPx(y), class: "grid-line" }, svg);
        el("text", { x: offX - 6, y: yToPx(y) + 3, "text-anchor": "end", class: "axis-label", text: y }, svg);
      }
      el("line", { x1: offX, y1: offY, x2: xToPx(s.depth), y2: offY, class: "grid-wall" }, svg);
      el("rect", { x: offX, y: yToPx(0), width: s.depth * scale, height: 4, class: "stage-floor" }, svg);

      // 通行净空带 + 通行区（游标所在时段高亮）
      el("rect", {
        x: xToPx(0), y: yToPx(s.passageY), width: s.depth * scale,
        height: yToPx(0) - yToPx(s.passageY), class: "passage-zone",
      }, svg);
      el("text", {
        x: xToPx(0) + 6, y: yToPx(s.passageY) - 3, class: "passage-label",
        text: "演员通行净空 " + s.passageY + "m",
      }, svg);
      const t = this.cursor;
      for (const occ of proj.occupancies) {
        const active = t >= occ.start && t <= occ.start + occ.duration;
        el("rect", {
          x: xToPx(occ.x), y: yToPx(0), width: occ.width * scale, height: 4,
          fill: active ? "#7bd17b" : "none",
          stroke: "#7bd17b", "stroke-dasharray": "4 3", opacity: active ? 0.95 : 0.45,
        }, svg);
        el("text", {
          x: xToPx(occ.x + occ.width / 2), y: yToPx(0) + 14, "text-anchor": "middle",
          class: "occ-label", text: occ.name + (active ? "（通行中）" : ""),
        }, svg);
      }

      const planOf = {};
      for (const pl of sim.plans) planOf[pl.battenId] = pl;
      const T = sim.trigger;

      // 游标时刻处于告警中的吊杆
      const warned = new Set();
      for (const w of sim.warnings)
        if (t >= w.start - 0.05 && t <= w.end + 0.05)
          (w.battenIds || []).forEach((id) => warned.add(id));

      proj.battens.forEach((b) => {
        const pl = planOf[b.id];
        const wdt = b.prop ? b.prop.width : b.length;
        const x0 = xToPx(b.x - wdt / 2), x1 = xToPx(b.x + wdt / 2);
        const g = el("g", {}, svg);

        // 行程轨迹与限位
        el("line", {
          x1: (x0 + x1) / 2, y1: yToPx(b.highLimit), x2: (x0 + x1) / 2, y2: yToPx(b.lowLimit),
          class: "batten-trajectory",
        }, g);
        for (const lim of [b.lowLimit, b.highLimit])
          el("line", {
            x1: (x0 + x1) / 2 - 6, y1: yToPx(lim), x2: (x0 + x1) / 2 + 6, y2: yToPx(lim),
            class: "limit-line",
          }, g);

        // 停止高度标记
        if (pl && pl.moving) {
          el("line", {
            x1: x1 + 3, y1: yToPx(pl.finalPos), x2: x1 + 13, y2: yToPx(pl.finalPos),
            class: "es-stop-tick",
          }, g);
          el("text", {
            x: x1 + 15, y: yToPx(pl.finalPos) + 3, class: "es-stop-label",
            text: "停 " + pl.finalPos.toFixed(2),
          }, g);
        }

        // 原计划虚影（同一游标时刻）
        const ghost = E.battenState(proj, b, t);
        const gy = yToPx(ghost.pos);
        for (const tx of [0.25, 0.75]) {
          const wx = x0 + (x1 - x0) * tx;
          el("line", {
            x1: wx, y1: offY, x2: wx, y2: gy,
            stroke: "#d9b8ff", "stroke-width": 1, "stroke-dasharray": "3 3",
          }, g);
        }
        if (b.prop)
          el("rect", {
            x: x0, y: gy, width: x1 - x0, height: b.prop.height * scale,
            fill: "rgba(217,184,255,0.10)", stroke: "#d9b8ff",
            "stroke-dasharray": "5 3", "stroke-width": 1.5,
          }, g);
        el("line", {
          x1: x0 - 2, y1: gy, x2: x1 + 2, y2: gy,
          stroke: "#d9b8ff", "stroke-width": 3, "stroke-linecap": "round",
        }, g);

        // 急停推演位置（实杆）
        const pos = pl ? ES.estopPos(proj, b, pl, T, t) : ghost.pos;
        const y = yToPx(pos);
        const danger = warned.has(b.id);
        for (const tx of [0.25, 0.75]) {
          const wx = x0 + (x1 - x0) * tx;
          el("line", { x1: wx, y1: offY, x2: wx, y2: y, class: "batten-wire" }, g);
        }
        if (b.prop) {
          const rr = el("rect", {
            x: x0, y, width: x1 - x0, height: b.prop.height * scale, rx: 2,
            class: "prop-rect prop-" + b.prop.kind, "data-id": b.id,
          }, g);
          if (danger) {
            rr.setAttribute("stroke", "#ff6b6b");
            rr.setAttribute("stroke-width", "3");
          }
          rr.addEventListener("click", (e) => {
            e.stopPropagation();
            this.handlers.onSelectBatten && this.handlers.onSelectBatten(b.id);
          });
        }
        const bat = el("rect", {
          x: x0 - 2, y: y - 4, width: x1 - x0 + 4, height: 7, rx: 3,
          class: "batten-body" +
            (this.selection.type === "batten" && this.selection.id === b.id ? " selected" : ""),
          "data-id": b.id,
        }, g);
        bat.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handlers.onSelectBatten && this.handlers.onSelectBatten(b.id);
        });
        el("text", {
          x: x0, y: y - 8, class: "batten-label",
          text: b.name + " " + pos.toFixed(2) + "m" + (danger ? " ⚠" : ""),
        }, g);
      });
    },
  };

  global.ESChart = ESChart;
  global.ESStage = ESStage;
})(window);
