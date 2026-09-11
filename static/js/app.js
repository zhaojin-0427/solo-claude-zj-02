/* app.js —— 主控：状态、撤销栈、表单、播放、方案、版本、演练、基线 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 状态
  const state = {
    projectId: null,
    project: E.emptyProject(),
    selection: { type: null, id: null },
    time: 0,
    playing: false,
    analysis: null,
    plans: null,
    baseline: null, // {name, data}
    _np: null,
  };

  let undoStack = [];
  let redoStack = [];
  const HISTORY_MAX = 60;
  let saveTimer = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const toast = (msg, isErr) => {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "show" + (isErr ? " err" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.className = ""), 2200);
  };

  // ---------------------------------------------------------------- 撤销
  function snap() {
    return JSON.stringify({ project: state.project, selection: state.selection });
  }
  function commit(label) {
    undoStack.push({ label: label || "编辑", data: snap() });
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function restore(json, redoJson) {
    const obj = JSON.parse(json);
    state.project = obj.project;
    state.selection = obj.selection || { type: null, id: null };
    state.time = 0;
    state.playing = false;
    if (redoJson) redoStack.push({ data: redoJson });
    render();
    scheduleSave();
  }
  function undo() {
    if (!undoStack.length) return;
    const cur = snap();
    const item = undoStack.pop();
    redoStack.push({ label: item.label, data: cur });
    restore(item.data);
    toast("已撤销：" + item.label);
    updateUndoButtons();
  }
  function redo() {
    if (!redoStack.length) return;
    const cur = snap();
    const item = redoStack.pop();
    undoStack.push({ label: item.label, data: cur });
    restore(item.data);
    toast("已重做：" + item.label);
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $("#btnUndo").disabled = !undoStack.length;
    $("#btnRedo").disabled = !redoStack.length;
  }

  // ---------------------------------------------------------------- 保存
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (state.projectId == null) return; // 未命名项目需手动保存创建
      try {
        await API.saveProject(state.projectId, $("#projectName").value, state.project);
      } catch (e) {
        toast("自动保存失败：" + e.message, true);
      }
    }, 800);
  }
  async function manualSave() {
    const name = $("#projectName").value.trim() || "未命名剧目";
    try {
      if (state.projectId == null) {
        const r = await API.createProject(name, state.project);
        state.projectId = r.id;
        await refreshProjectList();
        $("#projectSelect").value = String(r.id);
      } else {
        await API.saveProject(state.projectId, name, state.project);
      }
      toast("已保存到本地数据库");
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }

  async function refreshProjectList(selectId) {
    const list = await API.listProjects();
    const sel = $("#projectSelect");
    sel.innerHTML =
      '<option value="">（内存中的草稿）</option>' +
      list
        .map(
          (p) =>
            '<option value="' + p.id + '">' + esc(p.name) + "</option>"
        )
        .join("");
    if (selectId != null) sel.value = String(selectId);
    else if (state.projectId != null) sel.value = String(state.projectId);
  }

  async function loadProject(id) {
    const r = await API.getProject(id);
    state.projectId = r.id;
    state.project = r.data;
    $("#projectName").value = r.name;
    state.selection = { type: null, id: null };
    state.time = 0;
    state.playing = false;
    state.plans = null;
    undoStack = [];
    redoStack = [];
    updateUndoButtons();
    render();
  }

  // ---------------------------------------------------------------- 查找
  const findBatten = (id) => state.project.battens.find((b) => b.id === id);
  const findCue = (id) => state.project.cues.find((c) => c.id === id);
  const findOcc = (id) => state.project.occupancies.find((o) => o.id === id);

  function selectedCue(np) {
    if (state.selection.type !== "cue") return null;
    return np.cues.find((c) => c.id === state.selection.id) || null;
  }
  function selectedOcc(np) {
    if (state.selection.type !== "occ") return null;
    return np.occupancies.find((o) => o.id === state.selection.id) || null;
  }
  function selectedBatten(np) {
    if (state.selection.type !== "batten") return null;
    return np.battens.find((b) => b.id === state.selection.id) || null;
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    const np = E.normalizeProject(state.project);
    state._np = np;
    state.analysis = E.analyze(state.project);
    StageView.set({
      proj: np,
      analysis: state.analysis,
      selection: state.selection,
      time: state.time,
      playing: state.playing,
      baseline: state.baseline ? state.baseline.data : null,
    });
    Timeline.set({
      proj: np,
      analysis: state.analysis,
      selection: state.selection,
      time: state.time,
      playing: state.playing,
    });
    $("#clockText").textContent = state.time.toFixed(1) + " s";
    renderForms(np);
    renderCheck(np);
    renderPlans(np);
  }

  function renderViewsOnly() {
    const np = state._np;
    StageView.set({
      proj: np, analysis: state.analysis, selection: state.selection,
      time: state.time, playing: state.playing,
      baseline: state.baseline ? state.baseline.data : null,
    });
    Timeline.set({
      proj: np, analysis: state.analysis, selection: state.selection,
      time: state.time, playing: state.playing,
    });
    $("#clockText").textContent = state.time.toFixed(1) + " s";
  }

  // ---------------------------------------------------------------- 播放
  let rafId = null;
  let wall0 = 0;
  let t0 = 0;
  function play() {
    const H = Math.min(E.horizon(state.project), state.project.stage.totalTime + 2);
    if (state.time >= H - 0.05) state.time = 0;
    state.playing = true;
    wall0 = performance.now();
    t0 = state.time;
    $("#btnPlay").textContent = "⏸ 暂停";
    const loop = (now) => {
      if (!state.playing) return;
      const speed = parseFloat($("#playSpeed").value) || 1;
      const t = t0 + ((now - wall0) / 1000) * speed;
      const end = Math.min(E.horizon(state.project), state.project.stage.totalTime + 2);
      state.time = Math.min(t, end);
      renderViewsOnly();
      if (t >= end) return stop();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function pause() {
    state.playing = false;
    cancelAnimationFrame(rafId);
    $("#btnPlay").textContent = "▶ 排练播放";
    renderViewsOnly();
  }
  function stop() {
    state.playing = false;
    cancelAnimationFrame(rafId);
    state.time = 0;
    $("#btnPlay").textContent = "▶ 排练播放";
    renderViewsOnly();
  }
  function seek(t) {
    state.time = Math.max(0, Math.min(t, E.horizon(state.project)));
    renderViewsOnly();
    Timeline.scrollToTime(state.time);
  }

  // ---------------------------------------------------------------- 侧视图/时间轴回调
  const dragSession = {};
  let preDragSnap = null; // mousedown 时暂存，首次实际改动时入撤销栈
  let dragActive = false; // 本次按下后是否真的改动过数据
  function markDrag() {
    if (preDragSnap) {
      undoStack.push({ label: "拖动", data: preDragSnap });
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      redoStack = [];
      updateUndoButtons();
      preDragSnap = null;
    }
    dragActive = true;
  }

  StageView.init($("#stageSvg"), {
    onSelect(sel) {
      state.selection = sel || { type: null, id: null };
      activateTabFor(sel);
      render();
    },
    onDragBattenX(id, x) {
      const b = findBatten(id);
      if (!b) return;
      b.x = Math.round(x * 100) / 100;
      afterDrag();
    },
    onDragOcc(id, edge, x) {
      const o = findOcc(id);
      if (!o) return;
      x = Math.max(0, Math.round(x * 100) / 100);
      if (edge === "l") {
        const right = o.x + o.width;
        o.x = Math.min(x, right - 0.5);
        o.width = Math.round((right - o.x) * 100) / 100;
      } else {
        o.width = Math.max(0.5, Math.round((x - o.x) * 100) / 100);
      }
      afterDrag();
    },
  });

  Timeline.init($("#timelineSvg"), $("#tlScroll"), {
    onSeek(t) { seek(t); },
    onSelectCue(id) {
      state.selection = { type: "cue", id };
      switchTab("cue");
      render();
    },
    onSelectOcc(id) {
      state.selection = { type: "occ", id };
      switchTab("cue");
      render();
    },
    onSelectWarning(w) { jumpToWarning(w); },
    onDragCue(id, edge, t) {
      const c = findCue(id);
      if (!c) return;
      if (c.locked) {
        toast("该提示已锁定，请先在“提示”页解锁", true);
        return;
      }
      const key = "cue:" + id;
      if (!dragSession[key]) dragSession[key] = { start: c.start, duration: c.duration, t0: t };
      const d = dragSession[key];
      t = Math.round(t * 10) / 10;
      if (edge === "r") {
        c.duration = Math.max(0.5, Math.round((t - c.start) * 10) / 10);
      } else {
        c.start = Math.max(0, Math.round((d.start + (t - d.t0)) * 10) / 10);
      }
      afterDrag();
    },
    onDragOccTime(id, edge, t) {
      const o = findOcc(id);
      if (!o) return;
      const key = "occ:" + id;
      if (!dragSession[key]) dragSession[key] = { start: o.start, duration: o.duration, t0: t };
      const d = dragSession[key];
      t = Math.round(t * 10) / 10;
      if (edge === "r") {
        o.duration = Math.max(0.5, Math.round((t - o.start) * 10) / 10);
      } else if (edge === "l") {
        const ns = Math.max(0, Math.round((d.start + (t - d.t0)) * 10) / 10);
        o.start = Math.min(ns, o.start + o.duration - 0.5);
        o.duration = Math.round((d.start + d.duration - o.start) * 10) / 10;
      } else {
        o.start = Math.max(0, Math.round((d.start + (t - d.t0)) * 10) / 10);
      }
      afterDrag();
    },
  });

  // 拖动过程中只重算视图与检查，松手后落库
  function afterDrag() {
    markDrag();
    const np = E.normalizeProject(state.project);
    state._np = np;
    state.analysis = E.analyze(state.project);
    renderViewsOnly();
    renderCheck(np);
  }

  // mousedown 暂存快照；真正发生移动时由 markDrag() 入栈，纯点击不入栈
  document.addEventListener(
    "mousedown",
    (e) => {
      const t = e.target;
      if (
        t.classList &&
        (t.classList.contains("batten-handle") ||
          t.classList.contains("occ-handle") ||
          t.classList.contains("cue-edge") ||
          t.classList.contains("occ-edge") ||
          t.classList.contains("occ-block") ||
          (t.closest && t.closest(".cue-block") && !t.closest(".cue-locked")))
      ) {
        preDragSnap = snap();
        dragActive = false;
      }
    },
    true
  );
  document.addEventListener(
    "mouseup",
    () => {
      preDragSnap = null;
      if (dragActive) {
        dragActive = false;
        for (const k in dragSession) delete dragSession[k];
        render();
        scheduleSave();
      }
    },
    true
  );

  function jumpToWarning(w) {
    pause();
    state.time = Math.max(0, w.start);
    if (w.cueId) state.selection = { type: "cue", id: w.cueId };
    else if (w.battenIds && w.battenIds.length)
      state.selection = { type: "batten", id: w.battenIds[0] };
    else if (w.battenId)
      state.selection = { type: "batten", id: w.battenId };
    else if (w.occId) state.selection = { type: "occ", id: w.occId };
    render();
    activateTabFor(state.selection);
    Timeline.scrollToTime(state.time);
    toast("跳转至 " + w.start.toFixed(1) + "s：" + w.message);
  }

  function activateTabFor(sel) {
    if (!sel || !sel.type) return;
    if (sel.type === "batten") switchTab("battens");
    if (sel.type === "cue" || sel.type === "occ") switchTab("cue");
  }

  // ---------------------------------------------------------------- Tab
  function switchTab(name) {
    $$(".tabs .tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.tab === name)
    );
    $$(".tab-page").forEach((p) =>
      p.classList.toggle("active", p.dataset.page === name)
    );
  }
  $$(".tabs .tab").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab))
  );

  // ---------------------------------------------------------------- 表单
  const numInput = (label, bind, val, opt) => {
    opt = opt || {};
    return (
      '<div class="form-row"><label>' + esc(label) + '</label>' +
      '<input type="number" step="' + (opt.step || 0.1) + '"' +
      (opt.min != null ? ' min="' + opt.min + '"' : "") +
      (opt.placeholder != null ? ' placeholder="' + esc(opt.placeholder) + '"' : "") +
      ' data-bind="' + bind + '" value="' + (val == null || val === "" ? "" : val) + '">' +
      (opt.unit ? '<span class="val">' + opt.unit + '</span>' : "") +
      "</div>"
    );
  };
  const textInput = (label, bind, val, opt) =>
    '<div class="form-row"><label>' + esc(label) + '</label>' +
    '<input type="text" data-bind="' + bind + '" value="' + esc(val) + '"></div>';

  function renderForms(np) {
    renderSetup(np);
    renderBattens(np);
    renderCuePage(np);
  }

  function renderSetup(np) {
    const s = np.stage;
    $("#pageSetup").innerHTML =
      '<div class="form-section"><h3>舞台参数（侧视图标定）</h3>' +
      numInput("舞台进深", "stage.depth", s.depth, { unit: "m", min: 1 }) +
      numInput("栅顶高度", "stage.height", s.height, { unit: "m", min: 1 }) +
      numInput("台口位置", "stage.prosceniumX", s.prosceniumX, { unit: "m", min: 0 }) +
      numInput("通行净空高度", "stage.passageY", s.passageY, { unit: "m", min: 0 }) +
      numInput("总换景时限", "stage.totalTime", s.totalTime, { unit: "s", min: 1, step: 1 }) +
      numInput("可同时操作数", "stage.maxConcurrent", s.maxConcurrent, { min: 1, step: 1 }) +
      numInput("默认最大速度", "stage.defaultVmax", s.defaultVmax, { unit: "m/s", min: 0.05 }) +
      numInput("默认加速度", "stage.defaultAmax", s.defaultAmax, { unit: "m/s²", min: 0.02 }) +
      "</div>" +
      '<div class="form-section"><h3>快速构建</h3>' +
      '<div class="btn-row"><button id="btnAddBatten">＋ 添加吊杆</button>' +
      '<button id="btnAddBattenAt" title="在侧视图空白处点击添加">提示：可改吊杆参数后挂吊物</button></div>' +
      '<p style="color:var(--muted);line-height:1.7">在侧视图中拖动蓝色圆点设定吊杆进深位置；' +
      "吊杆上下红色短横为行程限位，虚线为可升降范围。绿色区域为演员通行区，可在时间轴上设定其占用时段。</p></div>";
    $("#btnAddBatten").onclick = () => {
      commit("添加吊杆");
      const i = state.project.battens.length + 1;
      const b = E.newBatten(
        3 + ((i - 1) * 3) % Math.max(4, state.project.stage.depth - 4),
        i
      );
      state.project.battens.push(b);
      state.selection = { type: "batten", id: b.id };
      switchTab("battens");
      render();
      scheduleSave();
    };
  }

  function renderBattens(np) {
    const sb = selectedBatten(np);
    let html = '<div class="form-section"><h3>吊杆列表（' + np.battens.length + "）</h3>";
    if (!np.battens.length) html += '<div class="empty-hint">还没有吊杆，请到“舞台”页添加。</div>';
    for (const b of np.battens) {
      const dot = b.prop ? "dot-" + b.prop.kind : "dot-none";
      const sel = sb && sb.id === b.id ? " selected" : "";
      html +=
        '<div class="list-item' + sel + '" data-pick-batten="' + b.id + '">' +
        '<span class="kind-dot ' + dot + '"></span>' +
        '<span class="nm">' + esc(b.name) +
        (b.prop ? " · " + esc(b.prop.name) : " · 空杆") + "</span>" +
        '<span class="meta mono">' + b.x.toFixed(1) + "m</span></div>";
    }
    html += "</div>";

    if (sb) {
      const raw = findBatten(sb.id);
      html +=
        '<div class="form-section"><h3>吊杆参数</h3>' +
        textInput("名称", "batten.name", sb.name) +
        numInput("进深位置 X", "batten.x", sb.x, { unit: "m" }) +
        numInput("杆体长度", "batten.length", sb.length, { unit: "m", min: 0.5 }) +
        numInput("额定载荷", "batten.maxLoad", sb.maxLoad, { unit: "kg", min: 0 }) +
        numInput("最高速度", "batten.vmax", sb.vmax, { unit: "m/s", min: 0.05 }) +
        numInput("加速度", "batten.amax", sb.amax, { unit: "m/s²", min: 0.02 }) +
        numInput("行程下限", "batten.lowLimit", sb.lowLimit, { unit: "m" }) +
        numInput("行程上限", "batten.highLimit", sb.highLimit, { unit: "m" }) +
        numInput("初始停放高度", "batten.initialPos", sb.initialPos, { unit: "m" }) +
        '<div class="btn-row"><button class="danger" id="btnDelBatten">删除该吊杆</button></div></div>';

      if (sb.prop) {
        const p = sb.prop;
        html +=
          '<div class="form-section"><h3>悬挂物（' +
          ({ curtain: "幕布", light: "灯具", scenery: "布景" }[p.kind] || "吊物") +
          "）</h3>" +
          '<div class="form-row"><label>类型</label><select data-bind="prop.kind">' +
          ['<option value="curtain"', p.kind === "curtain" ? " selected" : "", ">幕布</option>",
            '<option value="light"', p.kind === "light" ? " selected" : "", ">灯具</option>",
            '<option value="scenery"', p.kind === "scenery" ? " selected" : "", ">布景</option>"]
            .join("") +
          "</select></div>" +
          textInput("吊物名称", "prop.name", p.name) +
          numInput("外形宽度", "prop.width", p.width, { unit: "m", min: 0.1 }) +
          numInput("外形高度", "prop.height", p.height, { unit: "m", min: 0.05 }) +
          numInput("重量", "prop.weight", p.weight, { unit: "kg", min: 0 }) +
          numInput("悬挂高度", "prop.hangingHeight", p.hangingHeight, { unit: "m" }) +
          numInput("安全净距", "prop.clearance", p.clearance, { unit: "m", min: 0 }) +
          '<div class="btn-row"><button id="btnDetachProp">卸下吊物</button></div></div>';
      } else {
        html +=
          '<div class="form-section"><h3>悬挂物</h3><div class="empty-hint">该吊杆未挂吊物。</div>' +
          '<div class="btn-row">' +
          '<button data-attach="curtain">挂幕布</button>' +
          '<button data-attach="light">挂灯具</button>' +
          '<button data-attach="scenery">挂布景</button></div></div>';
      }
      html +=
        '<div class="form-section"><h3>为该吊杆添加提示</h3><div class="btn-row">' +
        '<button data-addcue="' + sb.id + '">＋ 升降提示</button>' +
        '<button data-adddwell="' + sb.id + '">＋ 停留提示</button></div></div>';
    }
    $("#pageBattens").innerHTML = html;

    $$("[data-pick-batten]").forEach((node) => {
      node.onclick = () => {
        state.selection = { type: "batten", id: node.dataset.pickBatten };
        render();
      };
    });
    if (sb) {
      $("#btnDelBatten").onclick = () => {
        commit("删除吊杆");
        state.project.battens = state.project.battens.filter((b) => b.id !== sb.id);
        state.project.cues = state.project.cues.filter((c) => c.battenId !== sb.id);
        state.selection = { type: null, id: null };
        render();
        scheduleSave();
      };
      $$("[data-attach]").forEach((btn) => {
        btn.onclick = () => {
          commit("挂吊物");
          const p = E.newProp(btn.dataset.attach);
          p.hangingHeight = raw.initialPos;
          raw.prop = p;
          render();
          scheduleSave();
        };
      });
      const detach = $("#btnDetachProp");
      if (detach)
        detach.onclick = () => {
          commit("卸下吊物");
          raw.prop = null;
          render();
          scheduleSave();
        };
      $$("[data-addcue]").forEach((btn) =>
        (btn.onclick = () => addCue(btn.dataset.addcue, false))
      );
      $$("[data-adddwell]").forEach((btn) =>
        (btn.onclick = () => addCue(btn.dataset.adddwell, true))
      );
    }
  }

  function renderCuePage(np) {
    const cue = selectedCue(np);
    const occ = selectedOcc(np);
    let html =
      '<div class="form-section"><h3>时间轴上的提示（' + np.cues.length + "）</h3>";
    if (!np.cues.length)
      html += '<div class="empty-hint">在下方时间轴工具条添加升降/停留提示，然后在此编辑。</div>';
    for (const c of np.cues) {
      const b = np.battens.find((x) => x.id === c.battenId);
      const sel = cue && cue.id === c.id ? " selected" : "";
      html +=
        '<div class="list-item' + sel + '" data-pick-cue="' + c.id + '">' +
        '<span class="nm">' + (c.locked ? "🔒 " : "") + esc(c.name) +
        " · " + esc(b ? b.name : "?") + "</span>" +
        '<span class="meta mono">' + c.start.toFixed(1) + "s/" + c.duration.toFixed(1) + "s</span></div>";
    }
    html += "</div>";

    if (cue) {
      const raw = findCue(cue.id);
      html +=
        '<div class="form-section"><h3>' + (cue.dwell ? "停留提示" : "升降提示") + "</h3>" +
        textInput("提示名称", "cue.name", cue.name) +
        '<div class="form-row"><label>所属吊杆</label><select data-bind="cue.battenId">' +
        np.battens
          .map(
            (b) =>
              '<option value="' + b.id + '"' +
              (b.id === cue.battenId ? " selected" : "") +
              ">" + esc(b.name) + "</option>"
          )
          .join("") +
        "</select></div>" +
        numInput("起始时间", "cue.start", cue.start, { unit: "s", min: 0 }) +
        numInput("持续时间", "cue.duration", cue.duration, { unit: "s", min: 0.5 }) +
        numInput("起始高度", "cue.fromPos", cue.fromPos, { unit: "m", placeholder: "自动接续" }) +
        numInput(cue.dwell ? "停留高度" : "目标高度", "cue.toPos", cue.toPos, { unit: "m" }) +
        numInput("限速（留空用默认）", "cue.vmax", cue.vmax == null ? "" : cue.vmax, { unit: "m/s", placeholder: "默认" }) +
        numInput("限加速（留空用默认）", "cue.amax", cue.amax == null ? "" : cue.amax, { unit: "m/s²", placeholder: "默认" }) +
        textInput("联动组名", "cue.linkGroup", cue.linkGroup || "") +
        '<div class="form-row"><label>停留提示</label><input type="checkbox" data-bind="cue.dwell"' +
        (cue.dwell ? " checked" : "") + "></div>" +
        '<div class="form-row"><label>🔒 锁定（自动调整时不动）</label><input type="checkbox" data-bind="cue.locked"' +
        (cue.locked ? " checked" : "") + "></div>" +
        '<div class="btn-row"><button class="danger" id="btnDelCue">删除提示</button></div></div>';

      // 联动组同伴
      if (cue.linkGroup) {
        const peers = np.cues.filter(
          (c) => c.linkGroup === cue.linkGroup && c.id !== cue.id
        );
        if (peers.length)
          html +=
            '<div class="form-section"><h3>联动同伴</h3>' +
            peers
              .map(
                (c) => {
                  const b = np.battens.find((x) => x.id === c.battenId);
                  return '<div class="list-item" data-pick-cue="' + c.id +
                    '"><span class="nm">' + esc(c.name) + " · " + esc(b ? b.name : "?") +
                    '</span><span class="meta mono">' + c.start.toFixed(1) + "s</span></div>";
                }
              )
              .join("") +
            "</div>";
      }
    }

    if (occ) {
      html +=
        '<div class="form-section"><h3>演员通行区时段</h3>' +
        textInput("名称", "occ.name", occ.name) +
        numInput("起始时间", "occ.start", occ.start, { unit: "s", min: 0 }) +
        numInput("持续时间", "occ.duration", occ.duration, { unit: "s", min: 0.5 }) +
        numInput("进深起点", "occ.x", occ.x, { unit: "m", min: 0 }) +
        numInput("占宽", "occ.width", occ.width, { unit: "m", min: 0.5 }) +
        '<div class="btn-row"><button class="danger" id="btnDelOcc">删除通行区</button></div></div>';
    }

    $("#pageCue").innerHTML = html;

    $$("[data-pick-cue]").forEach((node) => {
      node.onclick = () => {
        state.selection = { type: "cue", id: node.dataset.pickCue };
        render();
      };
    });
    if (cue)
      $("#btnDelCue").onclick = () => {
        commit("删除提示");
        state.project.cues = state.project.cues.filter((c) => c.id !== cue.id);
        state.selection = { type: null, id: null };
        render();
        scheduleSave();
      };
    if (occ)
      $("#btnDelOcc").onclick = () => {
        commit("删除通行区");
        state.project.occupancies = state.project.occupancies.filter((o) => o.id !== occ.id);
        state.selection = { type: null, id: null };
        render();
        scheduleSave();
      };
  }

  // 统一数据绑定
  document.querySelector(".tab-body").addEventListener("change", (e) => {
    const node = e.target;
    const bind = node.dataset && node.dataset.bind;
    if (!bind) return;
    commit("修改参数");
    applyBind(bind, node);
    render();
    scheduleSave();
  });
  // 文本类 input 即时刷新（不逐条入栈，change 时已入栈一次）
  document.querySelector(".tab-body").addEventListener("input", (e) => {
    const node = e.target;
    const bind = node.dataset && node.dataset.bind;
    if (!bind || node.type === "number") return;
    applyBind(bind, node);
    const np = E.normalizeProject(state.project);
    state._np = np;
    state.analysis = E.analyze(state.project);
    renderViewsOnly();
    renderForms(np);
    // 输入焦点恢复
    restoreFocus(node);
    scheduleSave();
  });

  function restoreFocus(prev) {
    const now = document.querySelector('[data-bind="' + prev.dataset.bind + '"]');
    if (now && document.activeElement !== now) {
      const start = prev.selectionStart;
      const end = prev.selectionEnd;
      try {
        now.focus();
        now.setSelectionRange(start, end);
      } catch (_) {}
    }
  }

  function applyBind(bind, node) {
    const [root, key] = bind.split(".");
    const set = (obj) => {
      if (!obj) return;
      if (node.type === "checkbox") obj[key] = node.checked;
      else if (node.type === "number") {
        if (node.value === "") obj[key] = null;
        else obj[key] = parseFloat(node.value);
      } else obj[key] = node.value;
    };
    if (root === "stage") set(state.project.stage, key);
    if (root === "batten") {
      const b = findBatten(state.selection.id);
      if (b) {
        set(b);
        if (key === "initialPos" && b.prop) b.prop.hangingHeight = b.initialPos;
      }
    }
    if (root === "prop") {
      const b = findBatten(state.selection.id);
      if (b && b.prop) {
        set(b.prop);
        if (key === "hangingHeight") b.initialPos = b.prop.hangingHeight;
      }
    }
    if (root === "cue") {
      const c = findCue(state.selection.id);
      if (c) {
        if (key === "dwell" && node.checked) c.toPos = c.fromPos == null ? c.toPos : c.fromPos;
        set(c);
        if (key === "dwell" && !node.checked && c.toPos === c.fromPos) c.toPos = (c.fromPos || 0) - 1;
      }
    }
    if (root === "occ") set(findOcc(state.selection.id), key);
  }

  // ---------------------------------------------------------------- 添加提示/通行
  function addCue(battenId, dwell) {
    if (!state.project.battens.length) {
      toast("请先添加吊杆", true);
      return;
    }
    commit(dwell ? "添加停留" : "添加升降提示");
    const b = findBatten(battenId) || state.project.battens[0];
    const st = E.battenState(state._np || E.normalizeProject(state.project), b, state.time);
    const c = E.newCue({
      battenId: b.id,
      name: dwell ? "停留" : "升降",
      start: Math.round(state.time * 10) / 10,
      duration: dwell ? 5 : 4,
      fromPos: Math.round(st.pos * 100) / 100,
      toPos: dwell ? st.pos : Math.max(b.lowLimit, st.pos - 2),
      dwell: !!dwell,
    });
    state.project.cues.push(c);
    state.selection = { type: "cue", id: c.id };
    switchTab("cue");
    render();
    Timeline.scrollToTime(c.start);
    scheduleSave();
  }
  function addOcc() {
    commit("添加演员通行");
    const s = state.project.stage;
    const o = E.newOcc({
      name: "演员通行 " + (state.project.occupancies.length + 1),
      start: Math.round(state.time * 10) / 10,
      duration: 8,
      x: s.prosceniumX + 0.5,
      width: Math.min(6, s.depth - s.prosceniumX - 1),
    });
    state.project.occupancies.push(o);
    state.selection = { type: "occ", id: o.id };
    switchTab("cue");
    render();
    Timeline.scrollToTime(o.start);
    scheduleSave();
  }
  $("#btnAddCue").onclick = () => {
    const b =
      state.selection.type === "batten"
        ? state.selection.id
        : state.project.battens[0] && state.project.battens[0].id;
    addCue(b, false);
  };
  $("#btnAddDwell").onclick = () => {
    const b =
      state.selection.type === "batten"
        ? state.selection.id
        : state.project.battens[0] && state.project.battens[0].id;
    addCue(b, true);
  };
  $("#btnAddOcc").onclick = addOcc;

  // ---------------------------------------------------------------- 检查页
  const TYPE_LABEL = {
    overload: "超载",
    overtravel: "越程",
    sweep: "扫掠相交",
    concurrency: "并发超限",
    passage: "通行区未落清",
    time: "时间不可行",
    deadline: "超总时限",
    link: "联动不同步",
    overlap: "提示重叠",
  };
  function renderCheck(np) {
    const a = state.analysis;
    if (!a) return;
    const m = a.summary;
    let html =
      '<div class="summary-pills">' +
      '<span class="pill ' + (m.high ? "bad" : "ok") + '">高危 <b>' + m.high + "</b></span>" +
      '<span class="pill ' + (m.medium ? "bad" : "") + '">警告 <b>' + m.medium + "</b></span>" +
      '<span class="pill">完成时间 <b>' + m.completion.toFixed(1) + "s</b></span>" +
      '<span class="pill ' + (m.peakParallel > np.stage.maxConcurrent ? "bad" : "ok") +
      '">峰值并行 <b>' + m.peakParallel + "</b>/" + np.stage.maxConcurrent + "</span></div>";
    if (!m.total)
      html += '<div style="color:var(--accent2);padding:8px 0">✓ 当前方案未发现冲突。</div>';
    html += a.warnings
      .map(
        (w) =>
          '<div class="warn-item ' + w.severity + '" data-warn="' + w.id + '">' +
          '<div class="t"><span class="tag">' + (TYPE_LABEL[w.type] || w.type) + "</span>" +
          esc(w.message) + "</div>" +
          '<div class="tm">' + w.start.toFixed(1) + "s – " + w.end.toFixed(1) + "s</div></div>"
      )
      .join("");
    const page = $("#pageCheck");
    page.innerHTML = html;
    $$("[data-warn]").forEach((node) => {
      node.onclick = () => {
        const w = a.warnings.find((x) => x.id === node.dataset.warn);
        if (w) jumpToWarning(w);
      };
    });
  }

  // ---------------------------------------------------------------- 自动方案
  $("#btnAutoPlan").onclick = () => {
    if (!state.project.battens.length) {
      toast("请先添加吊杆与提示", true);
      return;
    }
    state.plans = E.planVariants(state.project);
    switchTab("plans");
    renderPlans(state._np);
    toast("已生成 " + state.plans.length + " 个调整方案");
  };

  function renderPlans(np) {
    const page = $("#pagePlans");
    if (!state.plans) {
      const locked = np.cues.filter((c) => c.locked && !c.dwell).length;
      page.innerHTML =
        '<div class="form-section"><h3>自动调整</h3>' +
        '<p style="color:var(--muted);line-height:1.8">在时间轴上勾选提示的 <b>🔒 锁定</b>，' +
        "把导演已确认的动作固定下来；然后点击下方按钮，系统在总换景时限 " +
        "内重排其余提示的起止时间与速度，并给出多方案对比。</p>" +
        "<p>已锁定升降提示：<b>" + locked + "</b> 个；待调整：<b>" +
        (np.cues.filter((c) => !c.locked && !c.dwell).length) + "</b> 个</p>" +
        '<div class="btn-row"><button class="primary" id="btnGenPlans">⚙ 生成方案对比</button></div></div>';
      $("#btnGenPlans").onclick = $("#btnAutoPlan").onclick;
      return;
    }
    let html =
      '<div class="form-section"><h3>方案对比（按 冲突数 → 峰值并行 → 完成时间 排序）</h3>';
    state.plans.forEach((p, i) => {
      const m = p.metrics;
      html +=
        '<div class="plan-card' + (p.best ? " best" : "") + '">' +
        "<h4><span>" + esc(p.label) + "</span>" +
        (p.best ? '<span class="badge">推荐</span>' : "") + "</h4>" +
        '<div class="plan-metrics">' +
        "<span>冲突 <b class=\"" + (m.conflicts ? "bad" : "good") + '">' + m.conflicts + "</b></span>" +
        "<span>高危 <b class=\"" + (m.high ? "bad" : "good") + '">' + m.high + "</b></span>" +
        "<span>峰值并行 <b>" + m.peakParallel + "</b></span>" +
        "<span>完成 <b class=\"" + (m.withinDeadline ? "good" : "bad") + '">' +
        m.completion.toFixed(1) + "s</b>/" + np.stage.totalTime + "s</span></div>" +
        '<div class="btn-row"><button data-apply="' + i + '"' +
        (p.best ? ' class="primary"' : "") + ">采用此方案</button></div></div>";
    });
    html +=
      '<div class="btn-row"><button id="btnClearPlans">放弃，返回当前方案</button></div></div>';
    page.innerHTML = html;
    $$("[data-apply]").forEach((btn) => {
      btn.onclick = () => {
        const p = state.plans[parseInt(btn.dataset.apply, 10)];
        commit("采用方案：" + p.label);
        // 仅替换未锁定提示；锁定提示与通行区保持现状
        const lockedIds = new Set(
          state.project.cues.filter((c) => c.locked).map((c) => c.id)
        );
        const newCues = p.data.cues.filter((c) => !lockedIds.has(c.id));
        state.project.cues = state.project.cues
          .filter((c) => lockedIds.has(c.id))
          .concat(newCues);
        state.plans = null;
        render();
        scheduleSave();
        toast("已采用方案：" + p.label + "（冲突 " + p.metrics.conflicts + "，完成 " + p.metrics.completion + "s）");
      };
    });
    $("#btnClearPlans").onclick = () => {
      state.plans = null;
      renderPlans(state._np);
    };
  }

  // ---------------------------------------------------------------- 播放按钮
  $("#btnPlay").onclick = () => (state.playing ? pause() : play());
  $("#btnStop").onclick = stop;

  // ---------------------------------------------------------------- 键盘
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
    ) {
      e.preventDefault();
      redo();
    } else if (e.code === "Space") {
      e.preventDefault();
      state.playing ? pause() : play();
    }
  });

  // ---------------------------------------------------------------- 顶栏
  $("#btnUndo").onclick = undo;
  $("#btnRedo").onclick = redo;
  $("#btnSave").onclick = manualSave;
  $("#projectName").addEventListener("input", scheduleSave);
  $("#projectSelect").addEventListener("change", async (e) => {
    pause();
    if (e.target.value === "") {
      state.projectId = null;
      state.project = E.emptyProject();
      state.selection = { type: null, id: null };
      undoStack = [];
      redoStack = [];
      updateUndoButtons();
      render();
    } else {
      await loadProject(parseInt(e.target.value, 10));
    }
  });

  // ---------------------------------------------------------- 新建项目
  function demoProject() {
    const s = E.stageDefaults();
    const p = { stage: s, battens: [], cues: [], occupancies: [] };
    const b1 = E.newBatten(2.0, 1);
    b1.name = "台口幕杆";
    Object.assign(b1, { length: 2.5, maxLoad: 250, lowLimit: 0.2, highLimit: 11, initialPos: 10.5 });
    b1.prop = Object.assign(E.newProp("curtain"), {
      name: "丝绒大幕", width: 2.5, height: 7.5, weight: 120, hangingHeight: 10.5, clearance: 0.3,
    });
    const b2 = E.newBatten(7.0, 2);
    b2.name = "布景杆 A";
    Object.assign(b2, { length: 6, maxLoad: 200, initialPos: 10.5 });
    b2.prop = Object.assign(E.newProp("scenery"), {
      name: "城堡景片", width: 6, height: 4, weight: 150, hangingHeight: 10.5, clearance: 0.4,
    });
    const b3 = E.newBatten(11.0, 3);
    b3.name = "灯杆 B";
    Object.assign(b3, { length: 5, maxLoad: 70, initialPos: 10.8, highLimit: 11.2 });
    b3.prop = Object.assign(E.newProp("light"), {
      name: "顶灯排", width: 5, height: 0.8, weight: 80, hangingHeight: 10.8, clearance: 0.3,
    });
    p.battens.push(b1, b2, b3);

    p.occupancies.push(E.newOcc({
      name: "演员抢装通行", start: 4, duration: 12, x: 1.5, width: 7.5,
    }));

    p.cues.push(E.newCue({
      battenId: b1.id, name: "大幕下落", start: 0, duration: 8,
      fromPos: 10.5, toPos: 3, locked: true,
    }));
    p.cues.push(E.newCue({
      battenId: b2.id, name: "城堡景降位", start: 4, duration: 8,
      fromPos: 10.5, toPos: 0.2,
    }));
    p.cues.push(E.newCue({
      battenId: b3.id, name: "灯排微降", start: 6, duration: 6,
      fromPos: 10.8, toPos: 8,
    }));
    p.cues.push(E.newCue({
      battenId: b2.id, name: "城堡景归位", start: 30, duration: 8,
      fromPos: 0.2, toPos: 10.5,
    }));
    p.cues.push(E.newCue({
      battenId: b1.id, name: "大幕提升", start: 32, duration: 8,
      fromPos: 3, toPos: 10.5,
    }));
    return p;
  }

  $("#btnNewProject").onclick = () => {
    $("#newProjName").value = "未命名剧目";
    $("#modalNew").classList.add("show");
  };
  $("#btnConfirmNew").onclick = async () => {
    const name = $("#newProjName").value.trim() || "未命名剧目";
    const tpl = $("#newProjTpl").value;
    const data = tpl === "demo" ? demoProject() : E.emptyProject();
    $("#modalNew").classList.remove("show");
    try {
      const r = await API.createProject(name, data);
      state.projectId = r.id;
      state.project = data;
      $("#projectName").value = name;
      state.selection = { type: null, id: null };
      state.time = 0;
      state.plans = null;
      undoStack = [];
      redoStack = [];
      updateUndoButtons();
      await refreshProjectList(r.id);
      render();
      toast("已创建项目：" + name);
    } catch (e) {
      toast(e.message, true);
    }
  };

  // ---------------------------------------------------------- 模态框通用关闭
  $$(".modal-mask").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || (e.target.dataset && e.target.dataset.close != null))
        m.classList.remove("show");
    });
  });

  // ---------------------------------------------------------- 版本快照
  $("#btnVersions").onclick = async () => {
    $("#modalVersions").classList.add("show");
    await renderVersionList();
  };
  $("#btnSaveVersion").onclick = async () => {
    if (state.projectId == null) {
      toast("请先保存项目，再拍快照", true);
      return;
    }
    const label = $("#versionLabel").value.trim() ||
      ("快照 " + new Date().toLocaleString("zh-CN"));
    await API.saveVersion(state.projectId, label, state.project);
    $("#versionLabel").value = "";
    await renderVersionList();
    toast("已保存版本：" + label);
  };
  async function renderVersionList() {
    if (state.projectId == null) {
      $("#versionList").innerHTML = '<div class="empty-hint">草稿尚未保存为项目，无法建立版本。</div>';
      return;
    }
    const list = await API.listVersions(state.projectId);
    $("#versionList").innerHTML = list.length
      ? list
          .map(
            (v) =>
              '<div class="history-item"><span class="nm">' + esc(v.label) +
              '<br><span class="ts">' + new Date(v.createdAt).toLocaleString("zh-CN") +
              '</span></span><button class="tiny" data-ver-restore="' + v.id + '">恢复</button>' +
              '<button class="tiny" data-ver-base="' + v.id + '">设为基线</button>' +
              '<button class="tiny danger" data-ver-del="' + v.id + '">删</button></div>'
          )
          .join("")
      : '<div class="empty-hint">还没有版本快照。</div>';
    $$("[data-ver-restore]").forEach((b) =>
      b.addEventListener("click", async () => {
        const v = await API.getVersion(b.dataset.verRestore);
        commit("恢复版本：" + v.label);
        state.project = v.data;
        state.selection = { type: null, id: null };
        state.time = 0;
        $("#modalVersions").classList.remove("show");
        render();
        scheduleSave();
        toast("已恢复版本：" + v.label);
      })
    );
    $$("[data-ver-base]").forEach((b) =>
      b.addEventListener("click", async () => {
        const v = await API.getVersion(b.dataset.verBase);
        setBaseline(v.label, v.data);
        $("#modalVersions").classList.remove("show");
      })
    );
    $$("[data-ver-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        await API.deleteVersion(b.dataset.verDel);
        await renderVersionList();
      })
    );
  }

  // ---------------------------------------------------------- 演练记录
  $("#btnRehearsals").onclick = async () => {
    $("#modalRehearsals").classList.add("show");
    await renderRehearsalList();
  };
  $("#btnSaveRehearsal").onclick = async () => {
    if (state.projectId == null) {
      toast("请先保存项目，再记录演练", true);
      return;
    }
    const name = $("#rehearsalName").value.trim() ||
      ("演练 " + new Date().toLocaleString("zh-CN"));
    await API.saveRehearsal(
      state.projectId, name, state.project, state.analysis.summary
    );
    $("#rehearsalName").value = "";
    await renderRehearsalList();
    toast("已保存演练结果：" + name);
  };
  async function renderRehearsalList() {
    if (state.projectId == null) {
      $("#rehearsalList").innerHTML = '<div class="empty-hint">草稿尚未保存为项目。</div>';
      return;
    }
    const list = await API.listRehearsals(state.projectId);
    $("#rehearsalList").innerHTML = list.length
      ? list
          .map((r) => {
            const m = r.metrics || {};
            return (
              '<div class="history-item"><span class="nm">' + esc(r.name) +
              '<br><span class="ts">' +
              new Date(r.createdAt).toLocaleString("zh-CN") +
              " ｜ 冲突 " + (m.total != null ? m.total : "-") +
              " ｜ 峰值并行 " + (m.peakParallel != null ? m.peakParallel : "-") +
              " ｜ 完成 " + (m.completion != null ? m.completion.toFixed(1) + "s" : "-") +
              "</span></span>" +
              '<button class="tiny" data-reh-restore="' + r.id + '">复盘载入</button>' +
              '<button class="tiny" data-reh-base="' + r.id + '">设为基线</button>' +
              '<button class="tiny danger" data-reh-del="' + r.id + '">删</button></div>'
            );
          })
          .join("")
      : '<div class="empty-hint">还没有演练记录。播放检查后可保存当前结果。</div>';
    $$("[data-reh-restore]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await API.getRehearsal(b.dataset.rehRestore);
        commit("复盘载入：" + r.name);
        state.project = r.data;
        state.selection = { type: null, id: null };
        state.time = 0;
        $("#modalRehearsals").classList.remove("show");
        render();
        scheduleSave();
        toast("已载入演练：" + r.name);
      })
    );
    $$("[data-reh-base]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await API.getRehearsal(b.dataset.rehBase);
        setBaseline(r.name, r.data);
        $("#modalRehearsals").classList.remove("show");
      })
    );
    $$("[data-reh-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        await API.deleteRehearsal(b.dataset.rehDel);
        await renderRehearsalList();
      })
    );
  }

  // ---------------------------------------------------------- 基线
  function setBaseline(name, data) {
    state.baseline = { name: name, data: data };
    const bar = $("#baselineBar");
    bar.style.display = "flex";
    bar.classList.add("active");
    bar.innerHTML =
      "🔍 基线复盘叠加中：<b>" + esc(name) +
      '</b>（紫色虚线为基线吊杆位置）　<button class="tiny" id="btnClearBaseline">清除基线</button>';
    $("#btnClearBaseline").onclick = () => {
      state.baseline = null;
      bar.style.display = "none";
      renderViewsOnly();
    };
    renderViewsOnly();
    toast("已叠加基线：" + name);
  }
  $("#btnBaseline").onclick = () => {
    $("#modalVersions").classList.add("show");
    renderVersionList();
  };

  // ---------------------------------------------------------------- 启动
  async function boot() {
    updateUndoButtons();
    try {
      await refreshProjectList();
    } catch (e) {
      toast("后端不可用，请先启动 app.py", true);
    }
    // 默认载入演示数据（内存草稿，保存后才入库）
    state.project = demoProject();
    $("#projectName").value = "示例：一幕换景";
    render();
    window.addEventListener("resize", renderViewsOnly);
  }
  boot();
})();
