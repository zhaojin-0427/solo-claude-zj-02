/* timeline.js —— 时间轴 SVG：提示拖放、通行区间、告警带、播放游标 */
(function (global) {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";
  const LABEL_W = 118;
  const PAD_R = 40;
  const HEADER_H = 20;
  const WARN_H = 14;
  const ROW_H = 26;
  const PXS = 15; // 每秒像素

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

  const Timeline = {
    svg: null,
    scroll: null,
    proj: null,
    analysis: null,
    time: 0,
    playing: false,
    selection: { type: null, id: null },
    handlers: {},
    width: 0,
    height: 0,
    rows: [], // {kind:'cue'|'occ', id, label}
    rowMap: {},

    init(svg, scrollEl, handlers) {
      this.svg = svg;
      this.scroll = scrollEl;
      this.handlers = handlers || {};
      this._bind();
    },

    set(state) {
      this.proj = state.proj;
      this.analysis = state.analysis;
      this.time = state.time || 0;
      this.playing = !!state.playing;
      this.selection = state.selection || this.selection;
      this.render();
    },

    timeToX(t) { return LABEL_W + t * PXS; },
    xToTime(x) { return (x - LABEL_W) / PXS; },

    render() {
      if (!this.proj) return;
      const svg = this.svg;
      while (svg.firstChild) svg.removeChild(svg.firstChild);

      // 行结构：每吊杆一行，其后每个通行区一行
      this.rows = [];
      this.rowMap = {};
      for (const b of this.proj.battens) {
        this.rowMap["cue:" + b.id] = this.rows.length;
        this.rows.push({ kind: "cue", id: b.id, label: b.name });
      }
      for (const occ of this.proj.occupancies) {
        this.rowMap["occ:" + occ.id] = this.rows.length;
        this.rows.push({ kind: "occ", id: occ.id, label: "通行·" + occ.name });
      }
      // 没有吊杆时给一条空行方便点放
      if (this.rows.length === 0) this.rows.push({ kind: "empty", label: "（先添加吊杆）" });

      const H = E.horizon(this.proj);
      const endTime = Math.max(
        H,
        this.proj.stage.totalTime,
        ...this.proj.cues.map((c) => c.start + c.duration),
        ...this.proj.occupancies.map((o) => o.start + o.duration)
      );
      this.width = this.timeToX(endTime + 3);
      this.height = HEADER_H + WARN_H + this.rows.length * ROW_H + 6;
      svg.setAttribute("width", Math.max(this.width, this.scroll.clientWidth - 2));
      svg.setAttribute("height", this.height);
      svg.setAttribute("viewBox", "0 0 " + this.width + " " + this.height);

      this._drawHeader(endTime);
      this._drawWarningStrip();
      this._drawRows();
      this._drawCues();
      this._drawOccs();
      this._drawDeadline();
      this._drawPlayhead();
    },

    _drawHeader(endTime) {
      const svg = this.svg;
      for (let t = 0; t <= endTime + 2; t++) {
        const X = this.timeToX(t);
        el("line", {
          x1: X, y1: HEADER_H, x2: X, y2: this.height,
          class: "tl-grid",
          stroke: t % 5 === 0 ? "#33405a" : undefined,
        }, svg);
        if (t % 5 === 0)
          el("text", { x: X + 2, y: 13, class: "tl-row-label", text: t + "s" }, svg);
      }
    },

    _drawWarningStrip() {
      const svg = this.svg;
      const y = HEADER_H;
      if (!this.analysis) return;
      for (const w of this.analysis.warnings) {
        const x = this.timeToX(Math.max(0, w.start));
        const ww = Math.max(3, (w.end - w.start) * PXS);
        const r = el("rect", {
          x, y: y + 1, width: ww, height: WARN_H - 3, rx: 2,
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
    },

    _drawRows() {
      const svg = this.svg;
      const top = HEADER_H + WARN_H;
      this.rows.forEach((r, i) => {
        const y = top + i * ROW_H;
        el("rect", {
          x: 0, y, width: this.width, height: ROW_H - 1,
          class: "tl-row-bg" + (i % 2 ? " alt" : ""),
        }, svg);
        el("line", { x1: LABEL_W, y1: y, x2: LABEL_W, y2: y + ROW_H, class: "tl-grid" }, svg);
        el("text", {
          x: 8, y: y + ROW_H / 2 + 3, class: "tl-row-label",
          text: r.label.length > 9 ? r.label.slice(0, 9) + "…" : r.label,
        }, svg);
      });
    },

    _rowY(rowIdx) { return HEADER_H + WARN_H + rowIdx * ROW_H + 3; },

    _infeasibleCueIds() {
      const set = new Set();
      if (!this.analysis) return set;
      for (const w of this.analysis.warnings)
        if (w.type === "time" && w.cueId) set.add(w.cueId);
      return set;
    },

    _drawCues() {
      const svg = this.svg;
      const infeas = this._infeasibleCueIds();
      for (const c of this.proj.cues) {
        const ri = this.rowMap["cue:" + c.battenId];
        if (ri == null) continue;
        const y = this._rowY(ri);
        const x = this.timeToX(c.start);
        const w = Math.max(3, c.duration * PXS);
        const sel = this.selection.type === "cue" && this.selection.id === c.id;
        const g = el("g", {
          class:
            "cue-block " +
            (c.dwell ? "cue-dwell" : "cue-move") +
            (c.locked ? " cue-locked" : "") +
            (sel ? " selected" : ""),
          "data-id": c.id,
        }, svg);
        const rect = el("rect", { x, y, width: w, height: ROW_H - 7, rx: 4 }, g);
        if (infeas.has(c.id)) {
          rect.setAttribute("stroke", "#ff6b6b");
          rect.setAttribute("stroke-width", "2.5");
        }
        const label = (c.locked ? "🔒 " : "") + (c.name || (c.dwell ? "停留" : "升降"));
        el("text", {
          x: x + 5, y: y + (ROW_H - 7) / 2 + 3.5, class: "cue-label",
          text: label.length * 6 > w ? label.slice(0, Math.max(1, (w / 6) | 0)) : label,
        }, g);
        if (c.linkGroup)
          el("circle", { cx: x + w - 6, cy: y + 5, r: 3.5, class: "cue-link-badge" }, g);
        // 右缘调整
        el("rect", { x: x + w - 4, y, width: 8, height: ROW_H - 7, fill: "transparent", "data-edge": "r", "data-id": c.id, class: "cue-edge" }, g);
      }
    },

    _drawOccs() {
      const svg = this.svg;
      for (const occ of this.proj.occupancies) {
        const ri = this.rowMap["occ:" + occ.id];
        if (ri == null) continue;
        const y = this._rowY(ri);
        const x = this.timeToX(occ.start);
        const w = Math.max(3, occ.duration * PXS);
        const sel = this.selection.type === "occ" && this.selection.id === occ.id;
        const r = el("rect", {
          x, y, width: w, height: ROW_H - 7, rx: 4,
          class: "occ-block" + (sel ? " selected" : ""),
          "data-id": occ.id,
        }, svg);
        el("text", {
          x: x + 5, y: y + (ROW_H - 7) / 2 + 3.5, class: "cue-label",
          text: occ.name,
        }, svg);
        el("rect", { x: x + w - 4, y, width: 8, height: ROW_H - 7, fill: "transparent", "data-edge": "r", "data-id": occ.id, class: "occ-edge" }, svg);
        el("rect", { x: x - 4, y, width: 8, height: ROW_H - 7, fill: "transparent", "data-edge": "l", "data-id": occ.id, class: "occ-edge" }, svg);
      }
    },

    _drawDeadline() {
      const X = this.timeToX(this.proj.stage.totalTime);
      el("line", { x1: X, y1: HEADER_H, x2: X, y2: this.height, class: "tl-deadline" }, this.svg);
    },

    _drawPlayhead() {
      const X = this.timeToX(Math.max(0, this.time));
      el("line", { x1: X, y1: HEADER_H, x2: X, y2: this.height, class: "tl-playhead", "data-id": "__playhead" }, this.svg);
      el("polygon", {
        points: X + ",20 " + (X - 5) + ",12 " + (X + 5) + ",12",
        fill: "#fff", "data-id": "__playhead",
      }, this.svg);
    },

    scrollToTime(t) {
      const X = this.timeToX(t);
      const sl = this.scroll.scrollLeft;
      if (X < sl + LABEL_W) this.scroll.scrollLeft = X - LABEL_W - 10;
      else if (X > sl + this.scroll.clientWidth - 30)
        this.scroll.scrollLeft = X - this.scroll.clientWidth + 30;
    },

    // 交互 --------------------------------------------------------
    _bind() {
      const svg = this.svg;
      let drag = null;

      svg.addEventListener("mousedown", (e) => {
        const t = e.target;
        const id = t.getAttribute && t.getAttribute("data-id");
        if (id === "__playhead") {
          drag = { kind: "seek" };
          e.preventDefault();
          return;
        }
        const lockedBlock = t.closest && t.closest(".cue-locked");
        if (lockedBlock && (t.classList.contains("cue-edge") || t.closest(".cue-block"))) {
          return; // 锁定提示不允许拖动（仍可点击查看）
        }
        if (t.classList && t.classList.contains("cue-edge")) {
          drag = { kind: "cue-resize", id, edge: t.getAttribute("data-edge") };
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (t.classList && t.classList.contains("occ-edge")) {
          drag = { kind: "occ-resize", id, edge: t.getAttribute("data-edge") };
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const g = t.closest && t.closest(".cue-block");
        if (g) {
          drag = { kind: "cue-move", id: g.getAttribute("data-id") };
          e.preventDefault();
          return;
        }
        if (t.classList && t.classList.contains("occ-block")) {
          drag = { kind: "occ-move", id };
          e.preventDefault();
        }
      });

      const clientToTime = (cx) => {
        const r = svg.getBoundingClientRect();
        return Math.max(0, this.xToTime(cx - r.left));
      };

      window.addEventListener("mousemove", (e) => {
        if (!drag) return;
        const t = Math.round(clientToTime(e.clientX) * 10) / 10;
        if (drag.kind === "seek") {
          this.handlers.onSeek && this.handlers.onSeek(t);
        } else if (drag.kind === "cue-move") {
          this.handlers.onDragCue && this.handlers.onDragCue(drag.id, null, t);
        } else if (drag.kind === "cue-resize") {
          this.handlers.onDragCue && this.handlers.onDragCue(drag.id, drag.edge, t);
        } else if (drag.kind === "occ-move") {
          this.handlers.onDragOccTime && this.handlers.onDragOccTime(drag.id, null, t);
        } else if (drag.kind === "occ-resize") {
          this.handlers.onDragOccTime && this.handlers.onDragOccTime(drag.id, drag.edge, t);
        }
      });
      window.addEventListener("mouseup", () => { drag = null; });

      svg.addEventListener("click", (e) => {
        const t = e.target;
        if (t.getAttribute && t.getAttribute("data-id") === "__playhead") return;
        const g = t.closest && t.closest(".cue-block");
        if (g) {
          this.handlers.onSelectCue && this.handlers.onSelectCue(g.getAttribute("data-id"));
          return;
        }
        if (t.classList && t.classList.contains("occ-block")) {
          this.handlers.onSelectOcc && this.handlers.onSelectOcc(t.getAttribute("data-id"));
        }
      });
    },
  };

  global.Timeline = Timeline;
})(window);
