/* stage-view.js —— 舞台侧视图 SVG 渲染与交互 */
(function (global) {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const MARGIN = { l: 46, r: 16, t: 30, b: 28 };

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

  const StageView = {
    svg: null,
    proj: null,
    analysis: null,
    selection: { type: null, id: null },
    time: 0,
    playing: false,
    baseline: null, // 基线复盘数据
    handlers: {},
    scale: 1,
    offX: 0,
    offY: 0,
    viewW: 0,
    viewH: 0,

    init(svg, handlers) {
      this.svg = svg;
      this.handlers = handlers || {};
      this._bindEvents();
    },

    set(state) {
      this.proj = state.proj;
      this.analysis = state.analysis;
      this.selection = state.selection || this.selection;
      this.time = state.time || 0;
      this.playing = !!state.playing;
      this.baseline = state.baseline || null;
      this.render();
    },

    // 坐标换算 ----------------------------------------------------
    _computeGeom() {
      const s = this.proj.stage;
      const rect = this.svg.getBoundingClientRect();
      const W = Math.max(320, rect.width), H = Math.max(240, rect.height);
      const usableW = W - MARGIN.l - MARGIN.r;
      const usableH = H - MARGIN.t - MARGIN.b;
      this.scale = Math.min(usableW / s.depth, usableH / s.height);
      this.offX = MARGIN.l + (usableW - s.depth * this.scale) / 2;
      this.offY = MARGIN.t + (usableH - s.height * this.scale) / 2;
      this.viewW = W;
      this.viewH = H;
    },
    xToPx(x) { return this.offX + x * this.scale; },
    yToPx(y) { return this.offY + (this.proj.stage.height - y) * this.scale; },
    pxToX(px) { return (px - this.offX) / this.scale; },
    clientToX(clientX) {
      const r = this.svg.getBoundingClientRect();
      return this.pxToX(clientX - r.left);
    },

    depthSpan(b) {
      const w = b.prop ? b.prop.width : b.length;
      return [b.x - w / 2, b.x + w / 2];
    },

    // 渲染 --------------------------------------------------------
    render() {
      if (!this.proj) return;
      this._computeGeom();
      const svg = this.svg;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute("viewBox", "0 0 " + this.viewW + " " + this.viewH);
      const s = this.proj.stage;

      this._drawGrid();

      // 通行净空带
      const py = this.yToPx(s.passageY), fy = this.yToPx(0);
      el("rect", {
        x: this.xToPx(0), y: py,
        width: s.depth * this.scale, height: fy - py,
        class: "passage-zone",
      }, svg);
      el("text", {
        x: this.xToPx(0) + 6, y: py - 3, class: "passage-label",
        text: "演员通行净空 " + s.passageY + "m",
      }, svg);

      // 台口线
      const px = this.xToPx(s.prosceniumX);
      el("line", { x1: px, y1: this.offY, x2: px, y2: fy, class: "proscenium-line" }, svg);
      el("text", { x: px + 4, y: this.offY + 12, class: "proscenium-label", text: "台口" }, svg);
      el("text", { x: px - 4, y: this.offY + 12, "text-anchor": "end", class: "proscenium-label", text: "台口前（观众席侧）" }, svg);

      // 基线（半透明叠映）
      if (this.baseline) this._drawBaseline();

      // 吊杆轨迹与限位
      for (const b of this.proj.battens) this._drawTrajectory(b);

      // 通行区
      for (const occ of this.proj.occupancies) this._drawOcc(occ);

      // 吊杆及吊物
      const states = [];
      for (const b of this.proj.battens)
        states.push({ b, st: E.battenState(this.proj, b, this.time) });
      // 相交对高亮
      const collidePairs = this._activeSweepPairs(states);
      for (const { b, st } of states) this._drawBatten(b, st, collidePairs);

      // 播放游标竖线（在侧视图上也显示时刻）
      if (this.playing || this.time > 0) {
        // 不在侧视图上画时间，避免混淆
      }
    },

    _drawGrid() {
      const svg = this.svg, s = this.proj.stage;
      // 每 1m 网格
      for (let x = 0; x <= Math.floor(s.depth); x++) {
        const X = this.xToPx(x);
        el("line", { x1: X, y1: this.offY, x2: X, y2: this.yToPx(0), class: "grid-line" }, svg);
        if (x % 2 === 0)
          el("text", { x: X, y: this.yToPx(0) + 14, "text-anchor": "middle", class: "axis-label", text: x }, svg);
      }
      for (let y = 0; y <= Math.floor(s.height); y++) {
        const Y = this.yToPx(y);
        el("line", { x1: this.offX, y1: Y, x2: this.xToPx(s.depth), y2: Y, class: "grid-line" }, svg);
        el("text", { x: this.offX - 6, y: Y + 3, "text-anchor": "end", class: "axis-label", text: y }, svg);
      }
      // 栅顶
      el("line", {
        x1: this.offX, y1: this.offY, x2: this.xToPx(s.depth), y2: this.offY,
        class: "grid-wall",
      }, svg);
      el("text", { x: this.offX, y: this.offY - 8, class: "axis-label", text: "栅顶 " + s.height + "m" }, svg);
      // 台面
      el("rect", {
        x: this.offX, y: this.yToPx(0), width: s.depth * this.scale, height: 4, class: "stage-floor",
      }, svg);
      el("text", { x: this.xToPx(s.depth), y: this.yToPx(0) + 14, "text-anchor": "end", class: "axis-label", text: "进深 " + s.depth + "m" }, svg);
    },

    _drawTrajectory(b) {
      const svg = this.svg;
      const [d0, d1] = this.depthSpan(b);
      const cx = (d0 + d1) / 2;
      // 限位线
      const over = this._battenHasWarning(b.id, "overtravel");
      el("line", {
        x1: this.xToPx(cx), y1: this.yToPx(b.highLimit),
        x2: this.xToPx(cx), y2: this.yToPx(b.lowLimit),
        class: "batten-trajectory" + (over ? " overtravel" : ""),
      }, svg);
      // 上下限短横
      for (const lim of [b.lowLimit, b.highLimit]) {
        el("line", {
          x1: this.xToPx(cx) - 6, y1: this.yToPx(lim),
          x2: this.xToPx(cx) + 6, y2: this.yToPx(lim),
          class: "limit-line",
        }, svg);
      }
    },

    _drawOcc(occ) {
      const svg = this.svg;
      const s = this.proj.stage;
      const g = el("g", {}, svg);
      const x0 = this.xToPx(occ.x), x1 = this.xToPx(occ.x + occ.width);
      el("rect", {
        x: x0, y: this.yToPx(0), width: x1 - x0, height: this.yToPx(s.passageY) - this.yToPx(0),
        class: "occ-zone" + (this.selection.type === "occ" && this.selection.id === occ.id ? " selected" : ""),
        "data-id": occ.id,
      }, g);
      el("text", {
        x: (x0 + x1) / 2, y: this.yToPx(0) - 4, "text-anchor": "middle", class: "occ-label",
        text: occ.name,
      }, g);
      el("circle", { cx: x0, cy: this.yToPx(0.12), r: 5, class: "occ-handle", "data-id": occ.id, "data-edge": "l" }, g);
      el("circle", { cx: x1, cy: this.yToPx(0.12), r: 5, class: "occ-handle", "data-id": occ.id, "data-edge": "r" }, g);
      g.querySelector("rect").addEventListener("click", (e) => {
        e.stopPropagation();
        this.handlers.onSelect && this.handlers.onSelect({ type: "occ", id: occ.id });
      });
    },

    _drawBatten(b, st, collidePairs) {
      const svg = this.svg;
      const [d0, d1] = this.depthSpan(b);
      const x0 = this.xToPx(d0), x1 = this.xToPx(d1);
      const pos = st.pos;
      const y = this.yToPx(pos);
      const selected = this.selection.type === "batten" && this.selection.id === b.id;
      const collide = collidePairs.has(b.id);

      const g = el("g", {}, svg);

      // 吊绳（栅顶到吊杆）
      for (const tx of [0.25, 0.75]) {
        const wx = x0 + (x1 - x0) * tx;
        el("line", { x1: wx, y1: this.offY, x2: wx, y2: y, class: "batten-wire" }, g);
      }

      // 吊物外形矩形（吊杆位置为吊物挂点/上沿）
      if (b.prop) {
        const phPx = b.prop.height * this.scale;
        const cls = "prop-rect prop-" + b.prop.kind + (collide ? "" : "");
        const rr = el("rect", {
          x: x0, y: y, width: x1 - x0, height: phPx, rx: 2, class: cls,
          "data-id": b.id,
        }, g);
        if (collide) {
          rr.setAttribute("stroke", "#ff6b6b");
          rr.setAttribute("stroke-width", "3");
        }
        // 安全净距虚线框
        if (b.prop.clearance > 0) {
          const c = b.prop.clearance * this.scale;
          el("rect", {
            x: x0 - c, y: y - c, width: x1 - x0 + 2 * c, height: phPx + 2 * c,
            fill: "none", stroke: "#ff6b6b88", "stroke-dasharray": "3 3",
          }, g);
        }
        rr.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handlers.onSelect && this.handlers.onSelect({ type: "batten", id: b.id });
        });
      }

      // 吊杆杆体
      const bat = el("rect", {
        x: x0 - 2, y: y - 4, width: x1 - x0 + 4, height: 7, rx: 3,
        class: "batten-body" + (selected ? " selected" : ""),
        "data-id": b.id,
      }, g);
      bat.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handlers.onSelect && this.handlers.onSelect({ type: "batten", id: b.id });
      });

      // 名称标签
      el("text", {
        x: x0, y: y - 8, class: "batten-label",
        text: b.name + (b.prop ? " · " + b.prop.name : " · 空杆"),
      }, g);

      // 移动把手（进深位置）
      el("circle", { cx: (x0 + x1) / 2, cy: y - 4, r: 5.5, class: "batten-handle", "data-id": b.id }, g);
    },

    _drawBaseline() {
      const base = E.normalizeProject(this.baseline);
      const svg = this.svg;
      const g = el("g", { opacity: "0.55" }, svg);
      const t = this.time;
      for (const b of base.battens) {
        // 基线吊杆按同一播放时刻求解位置，随时间下降/上升
        const st = E.battenState(base, b, t);
        const w = b.prop ? b.prop.width : b.length;
        const x0 = this.xToPx(b.x - w / 2), x1 = this.xToPx(b.x + w / 2);
        const y = this.yToPx(st.pos);
        // 吊绳
        for (const tx of [0.25, 0.75]) {
          const wx = x0 + (x1 - x0) * tx;
          el("line", {
            x1: wx, y1: this.offY, x2: wx, y2: y,
            stroke: "#d9b8ff", "stroke-width": 1, "stroke-dasharray": "3 3",
          }, g);
        }
        // 吊物外形（空心紫框）
        if (b.prop) {
          el("rect", {
            x: x0, y: y, width: x1 - x0, height: b.prop.height * this.scale,
            fill: "rgba(217,184,255,0.10)",
            stroke: "#d9b8ff", "stroke-dasharray": "5 3", "stroke-width": 1.5,
          }, g);
        }
        // 基线杆体
        el("line", {
          x1: x0 - 2, y1: y, x2: x1 + 2, y2: y,
          stroke: "#d9b8ff", "stroke-width": 3, "stroke-linecap": "round",
        }, g);
        el("text", {
          x: x0, y: y - 7, fill: "#d9b8ff", "font-size": 9,
          text: "基线·" + b.name,
        }, g);
      }
      // 基线通行区（时段内才高亮）
      for (const occ of base.occupancies) {
        const active = t >= occ.start && t <= occ.start + occ.duration;
        el("rect", {
          x: this.xToPx(occ.x), y: this.yToPx(0),
          width: occ.width * this.scale, height: 4,
          fill: active ? "#d9b8ff" : "none",
          stroke: "#d9b8ff", "stroke-dasharray": "4 3", opacity: active ? 0.9 : 0.5,
        }, g);
      }
    },

    // 当前时刻的扫掠相交对
    _activeSweepPairs(states) {
      const hit = new Set();
      if (!this.playing && this.time === 0) {
        // 静态位置也检查，便于布置阶段发现
      }
      const span = (b, st) => {
        const w = b.prop ? b.prop.width : b.length;
        const cl = b.prop ? b.prop.clearance : 0;
        const h = b.prop ? b.prop.height : 0;
        return {
          x0: b.x - w / 2, x1: b.x + w / 2,
          y0: st.pos - h - cl, y1: st.pos + cl,
        };
      };
      for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
          const A = span(states[i].b, states[i].st);
          const B = span(states[j].b, states[j].st);
          if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1) {
            hit.add(states[i].b.id);
            hit.add(states[j].b.id);
          }
        }
      }
      return hit;
    },

    _battenHasWarning(bid, type) {
      if (!this.analysis) return false;
      const t = this.time || 0;
      return this.analysis.warnings.some(
        (w) =>
          w.type === type &&
          ((w.battenIds || []).indexOf(bid) >= 0 || w.battenId === bid) &&
          t >= w.start - 0.05 &&
          t <= w.end + 0.05
      );
    },

    // 交互 --------------------------------------------------------
    _bindEvents() {
      const svg = this.svg;
      let drag = null;

      svg.addEventListener("mousedown", (e) => {
        const target = e.target;
        if (target.classList && target.classList.contains("batten-handle")) {
          drag = { kind: "batten-x", id: target.getAttribute("data-id") };
          e.preventDefault();
        } else if (target.classList && target.classList.contains("occ-handle")) {
          drag = {
            kind: "occ",
            id: target.getAttribute("data-id"),
            edge: target.getAttribute("data-edge"),
          };
          e.preventDefault();
        }
      });

      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const x = E.clamp(this.clientToX(e.clientX), 0, this.proj.stage.depth);
        if (drag.kind === "batten-x") {
          this.handlers.onDragBattenX && this.handlers.onDragBattenX(drag.id, x);
        } else if (drag.kind === "occ") {
          this.handlers.onDragOcc && this.handlers.onDragOcc(drag.id, drag.edge, x);
        }
      });
      window.addEventListener("mouseup", () => { drag = null; });

      svg.addEventListener("click", (e) => {
        if (e.target === svg)
          this.handlers.onSelect && this.handlers.onSelect({ type: null, id: null });
      });
    },
  };

  global.StageView = StageView;
})(window);
