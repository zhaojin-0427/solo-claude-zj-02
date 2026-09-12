/* cw-app.js —— 配重换装单主控：状态流转、锁定、执行、回放、对照、沙盘引用 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 状态
  const state = {
    sheetId: null,
    sheet: CW.newSheet("未命名换装单", ""),
    status: "draft",
    selection: { type: null, id: null }, // line | step | brick
    analysis: null,
    replay: { on: false, t: 0, playing: false },
    sandboxProjects: [],
    sandboxProj: null, // 已载入的换景沙盘项目数据
    sheetList: [],
  };
  let saveTimer = null;
  let rafId = null;

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
    toast._t = setTimeout(() => (t.className = ""), 2400);
  };

  const findLine = (id) => state.sheet.lines.find((l) => l.id === id);
  const findStep = (id) => state.sheet.steps.find((s) => s.id === id);
  const findBrick = (id) => state.sheet.bricks.find((b) => b.id === id);

  // 当前（已完成步骤之后）的各行状态
  function currentStates() {
    const sheet = CW.normalize(state.sheet);
    const bricks = {};
    for (const l of sheet.lines) bricks[l.id] = l.initialBricks;
    for (const s of CW.orderedSteps(sheet)) {
      if (s.status !== "done") continue;
      if (s.kind === "add") bricks[s.lineId] = (bricks[s.lineId] || 0) + s.count;
      else if (s.kind === "remove") bricks[s.lineId] = (bricks[s.lineId] || 0) - s.count;
    }
    const out = {};
    for (const l of sheet.lines) {
      const brick = CW.brickOf(sheet, l);
      const w = brick ? brick.weight : 0;
      const stageW = CW.stageWeight(l);
      const cwW = Math.round((bricks[l.id] || 0) * w * 10) / 10;
      out[l.id] = {
        lineId: l.id,
        bricks: bricks[l.id] || 0,
        stageW,
        cwW,
        imbalance: Math.round(Math.abs(stageW - cwW) * 10) / 10,
        remain: Math.round((l.arborCapacity - cwW) * 10) / 10,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- 编辑权限
  // 草稿：全部可改；已核对：只读；执行中：仅临时变更字段；完成：只读
  const TEMP_FIELDS = ["propWeight", "targetBricks", "arborPos", "braked"];
  function canEdit(field) {
    if (state.status === "draft") return true;
    if (state.status === "running") return TEMP_FIELDS.indexOf(field) >= 0;
    return false;
  }
  const readonly = () => state.status === "checked" || state.status === "done";

  // ---------------------------------------------------------------- 保存
  function payload(extra) {
    return Object.assign(
      {
        name: $("#sheetName").value.trim() || "未命名换装单",
        scene: $("#sheetScene").value.trim(),
        projectId: state.sheet.projectId,
        data: state.sheet,
        metrics: CW.metrics(state.sheet),
      },
      extra || {}
    );
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 700);
  }
  async function saveNow() {
    if (state.sheetId == null) return; // 未入库的草稿需手动保存
    if (readonly()) return;
    try {
      await API.saveCwSheet(state.sheetId, payload());
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }
  async function manualSave() {
    try {
      if (state.sheetId == null) {
        const r = await API.createCwSheet(
          $("#sheetName").value.trim() || "未命名换装单",
          $("#sheetScene").value.trim(),
          state.sheet.projectId,
          state.sheet,
          CW.metrics(state.sheet)
        );
        state.sheetId = r.id;
        await refreshSheetList(r.id);
      } else {
        await API.saveCwSheet(state.sheetId, payload());
      }
      toast("已保存到本地数据库");
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }

  async function refreshSheetList(selectId) {
    state.sheetList = await API.listCwSheets();
    const sel = $("#sheetSelect");
    sel.innerHTML =
      '<option value="">（内存中的草稿）</option>' +
      state.sheetList
        .map(
          (s) =>
            '<option value="' + s.id + '">' + esc(s.name) +
            (s.scene ? " · " + esc(s.scene) : "") +
            "（" + (CW.STATUS_LABEL[s.status] || s.status) + "）</option>"
        )
        .join("");
    if (selectId != null) sel.value = String(selectId);
    else if (state.sheetId != null) sel.value = String(state.sheetId);
  }

  async function loadSheet(id) {
    const r = await API.getCwSheet(id);
    state.sheetId = r.id;
    state.sheet = CW.normalize(r.data);
    state.sheet.projectId = r.projectId;
    state.status = r.status;
    $("#sheetName").value = r.name;
    $("#sheetScene").value = r.scene || "";
    state.selection = { type: null, id: null };
    state.replay = { on: false, t: 0, playing: false };
    if (r.projectId) await loadSandbox(r.projectId, true);
    render();
  }

  // ---------------------------------------------------------------- 状态流转
  async function transition(to) {
    if (state.sheetId == null) {
      toast("请先保存换装单，再流转状态", true);
      return;
    }
    if (to === "running" && state.analysis && state.analysis.summary.high > 0) {
      toast("存在 " + state.analysis.summary.high + " 条高危告警，排除后才能开始执行", true);
      switchTab("check");
      return;
    }
    await saveNow(); // 先落库未保存的编辑，再流转
    try {
      await API.saveCwSheet(state.sheetId, { status: to });
      state.status = to;
      if (to !== "running") stopReplay();
      await refreshSheetList();
      render();
      toast("已流转为「" + CW.STATUS_LABEL[to] + "」");
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    state.sheet = CW.normalize(state.sheet);
    state.analysis = CW.simulate(state.sheet);
    const states = state.replay.on
      ? CW.replayState(state.sheet, state.replay.t)
      : currentStates();

    CWArbor.set({ sheet: state.sheet, states, selection: state.selection });
    const next = nextPendingStep();
    CWTimeline.set({
      sheet: state.sheet,
      analysis: state.analysis,
      selection: state.selection,
      time: state.replay.on ? state.replay.t : 0,
      replayOn: state.replay.on,
      nextStepId: state.status === "running" && next ? next.id : null,
    });
    renderStatusBar();
    renderExecBar(next);
    renderLines();
    renderStock();
    renderCheck();
    renderReplayTab();
  }

  function renderViewsOnly() {
    const states = state.replay.on
      ? CW.replayState(state.sheet, state.replay.t)
      : currentStates();
    CWArbor.set({ sheet: state.sheet, states, selection: state.selection });
    const next = nextPendingStep();
    CWTimeline.set({
      sheet: state.sheet,
      analysis: state.analysis,
      selection: state.selection,
      time: state.replay.on ? state.replay.t : 0,
      replayOn: state.replay.on,
      nextStepId: state.status === "running" && next ? next.id : null,
    });
    $("#replayClock").textContent = state.replay.on
      ? state.replay.t.toFixed(1) + " s"
      : "–";
    const slider = $("#replaySlider");
    if (slider) slider.value = String(Math.round(state.replay.t * 10));
  }

  function renderStatusBar() {
    const pill = $("#statusPill");
    pill.textContent = CW.STATUS_LABEL[state.status];
    pill.className = "status-pill st-" + state.status;
    const acts = $("#statusActions");
    const btn = (to, label, primary) =>
      '<button class="tiny' + (primary ? " primary" : "") + '" data-trans="' + to + '">' +
      label + "</button>";
    let html = "";
    if (state.status === "draft") html = btn("checked", "提交核对 ✓", true);
    else if (state.status === "checked")
      html = btn("draft", "退回草稿") + btn("running", "开始执行 ▶", true);
    else if (state.status === "running")
      html = btn("checked", "暂停回核对") + btn("done", "完成归档 🏁", true);
    acts.innerHTML = html;
    $$("#statusActions [data-trans]").forEach((b) =>
      b.addEventListener("click", () => transition(b.dataset.trans))
    );
    // 只读横幅
    const bar = $("#readonlyBar");
    if (state.status === "checked") {
      bar.style.display = "flex";
      bar.innerHTML = "📋 换装单已核对，内容只读；可退回草稿修改，或开始执行。";
    } else if (state.status === "done") {
      bar.style.display = "flex";
      bar.innerHTML = "🏁 换装单已完成归档，不可改写；可在「回放/对照」页复盘。";
    } else if (state.status === "running") {
      bar.style.display = "flex";
      bar.innerHTML =
        "▶ 执行中：仅可顺序确认/撤回步骤；临时变更吊物或目标砖块将只重排未完成步骤。";
    } else {
      bar.style.display = "none";
    }
    // 只读时锁定单据头字段
    const ro = readonly();
    $("#sheetName").disabled = ro;
    $("#sheetScene").disabled = ro;
    // 编排过期提示
    $("#staleHint").style.display =
      state.status !== "done" && state.sheet.steps.length && planStale() ? "inline" : "none";
  }

  function planStale() {
    if (state.status === "checked" || state.status === "done") return false;
    const cur = state.sheet.steps
      .filter((s) => s.status !== "done")
      .map((s) => s.kind + ":" + s.lineId + ":" + s.count)
      .join("|");
    const planned = CW.planSteps(state.sheet, { keepDone: state.status === "running" })
      .filter((s) => s.status !== "done")
      .map((s) => s.kind + ":" + s.lineId + ":" + s.count)
      .join("|");
    return cur !== planned;
  }

  function nextPendingStep() {
    const pend = CW.orderedSteps(state.sheet).filter((s) => s.status !== "done");
    return pend.length ? pend[0] : null;
  }

  function renderExecBar(next) {
    const bar = $("#execBar");
    if (state.status !== "running") {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "inline-flex";
    const lineName = (s) => {
      const l = findLine(s.lineId);
      return l ? l.name : "?";
    };
    $("#execNext").innerHTML = next
      ? "下一步：<b>#" +
        (next.seq || "-") + " " + esc(CW.KIND_LABEL[next.kind]) + " · " + esc(lineName(next)) +
        (next.kind === "add" || next.kind === "remove" ? " " + next.count + " 块" : "") +
        " · 工位 " + next.station + "</b>"
      : "<b>全部步骤已执行，可归档完成</b>";
    $("#btnConfirm").disabled = !next;
    $("#btnUndoStep").disabled = !state.sheet.steps.some((s) => s.status === "done");
  }

  // ---------------------------------------------------------------- 吊杆行页
  const numInput = (label, bind, val, opt) => {
    opt = opt || {};
    const dis = opt.disabled ? " disabled" : "";
    return (
      '<div class="form-row"><label>' + esc(label) + "</label>" +
      '<input type="number" step="' + (opt.step || 1) + '" data-bind="' + bind + '"' +
      ' value="' + (val == null ? "" : val) + '"' +
      (opt.placeholder ? ' placeholder="' + esc(opt.placeholder) + '"' : "") + dis + ">" +
      (opt.unit ? '<span class="val">' + opt.unit + "</span>" : "") + "</div>"
    );
  };
  const textInput = (label, bind, val, opt) =>
    '<div class="form-row"><label>' + esc(label) + "</label>" +
    '<input type="text" data-bind="' + bind + '" value="' + esc(val) + '"' +
    (opt && opt.disabled ? " disabled" : "") + "></div>";
  const checkInput = (label, bind, val, opt) =>
    '<div class="form-row"><label>' + esc(label) + "</label>" +
    '<input type="checkbox" data-bind="' + bind + '"' + (val ? " checked" : "") +
    (opt && opt.disabled ? " disabled" : "") + "></div>";

  function renderLines() {
    const sheet = state.sheet;
    const cur = currentStates();
    let html =
      '<div class="form-section"><h3>手动吊杆行（' + sheet.lines.length + "）</h3>";
    if (!sheet.lines.length)
      html += '<div class="empty-hint">还没有吊杆行。可点击下方按钮添加，或到「参数/库存」页从换景沙盘生成。</div>';
    for (const l of sheet.lines) {
      const st = cur[l.id];
      const tgt = CW.targetBricks(sheet, l);
      const sel = state.selection.type === "line" && state.selection.id === l.id;
      const over = st.imbalance > sheet.params.maxImbalance + 1e-9;
      html +=
        '<div class="list-item' + (sel ? " selected" : "") + '" data-pick-line="' + l.id + '">' +
        '<span class="nm">' + (l.propLocked || l.bricksLocked ? "🔒 " : "") + esc(l.name) +
        (l.propName ? " · " + esc(l.propName) : " · 空杆") + "</span>" +
        '<span class="meta mono">' + st.bricks + "→" + tgt + "块" +
        (over ? ' <b style="color:var(--danger)">Δ' + st.imbalance.toFixed(0) + "</b>" : "") +
        "</span></div>";
    }
    html +=
      '<div class="btn-row"><button id="btnAddLine"' + (canEdit("x") ? "" : " disabled") +
      ">＋ 添加吊杆行</button></div></div>";

    const l = state.selection.type === "line" ? findLine(state.selection.id) : null;
    if (l) {
      const brick = CW.brickOf(sheet, l);
      const lockDis = state.status !== "draft";
      html += '<div class="form-section"><h3>吊杆行参数</h3>';
      html += textInput("行名称", "line.name", l.name, { disabled: !canEdit("name") });
      // 沙盘引用
      if (state.sandboxProj) {
        const bats = state.sandboxProj.battens || [];
        html +=
          '<div class="form-row"><label>引用沙盘吊杆</label><select data-bind="line.battenId"' +
          (canEdit("battenId") ? "" : " disabled") + '><option value="">（不引用）</option>' +
          bats
            .map(
              (b) =>
                '<option value="' + b.id + '"' + (b.id === l.battenId ? " selected" : "") +
                ">" + esc(b.name) + "</option>"
            )
            .join("") + "</select></div>";
        const cues = (state.sandboxProj.cues || []).filter((c) => c.battenId === l.battenId);
        html +=
          '<div class="form-row"><label>引用升降提示</label><select data-bind="line.cueId"' +
          (canEdit("cueId") ? "" : " disabled") + '><option value="">（不引用）</option>' +
          cues
            .map(
              (c) =>
                '<option value="' + c.id + '"' + (c.id === l.cueId ? " selected" : "") + ">" +
                esc(c.name) + "（" + c.start.toFixed(0) + "s→" + (c.start + c.duration).toFixed(0) +
                "s）</option>"
            )
            .join("") + "</select></div>";
      } else {
        html += '<div class="empty-hint">未引用换景沙盘项目（在「参数/库存」页设置）。</div>';
      }
      html += numInput("管身自重", "line.pipeWeight", l.pipeWeight, {
        unit: "kg", disabled: !canEdit("pipeWeight"),
      });
      html += textInput("当前吊物", "line.propName", l.propName, {
        disabled: !canEdit("propName") || l.propLocked,
      });
      html += numInput("吊物重量", "line.propWeight", l.propWeight, {
        unit: "kg", disabled: !canEdit("propWeight") || l.propLocked,
      });
      html += checkInput("🔒 锁定已挂吊物", "line.propLocked", l.propLocked, { disabled: lockDis });
      html += numInput("配重架容量", "line.arborCapacity", l.arborCapacity, {
        unit: "kg", disabled: !canEdit("arborCapacity"),
      });
      html +=
        '<div class="form-row"><label>砖块规格</label><select data-bind="line.brickId"' +
        (canEdit("brickId") ? "" : " disabled") + ">" +
        sheet.bricks
          .map(
            (b) =>
              '<option value="' + b.id + '"' + (b.id === l.brickId ? " selected" : "") + ">" +
              esc(b.name) + "（" + b.weight + "kg）</option>"
          )
          .join("") + "</select></div>";
      html += numInput("当前已装砖", "line.initialBricks", l.initialBricks, {
        unit: "块", disabled: !canEdit("initialBricks") || l.bricksLocked,
      });
      html += numInput("目标砖数", "line.targetBricks", l.targetBricks, {
        unit: "块", placeholder: "自动=" + CW.targetBricks(sheet, l),
        disabled: !canEdit("targetBricks") || l.bricksLocked,
      });
      html += checkInput("🔒 锁定已装砖块", "line.bricksLocked", l.bricksLocked, { disabled: lockDis });
      html += checkInput("吊杆已制动", "line.braked", l.braked, { disabled: !canEdit("braked") });
      html += numInput("配重架高度", "line.arborPos", l.arborPos, {
        unit: "m", step: 0.05, disabled: !canEdit("arborPos"),
      });
      const st = currentStates()[l.id];
      html +=
        '<div class="form-row"><label>实时核算</label><span class="mono" style="font-size:12px">' +
        "舞台侧 " + st.stageW + "kg ｜ 配重侧 " + st.cwW + "kg ｜ 失衡 " + st.imbalance +
        "kg ｜ 架余量 " + st.remain + "kg</span></div>";
      html +=
        '<div class="btn-row"><button class="danger" id="btnDelLine"' +
        (canEdit("x") ? "" : " disabled") + ">删除该行</button></div></div>";

      // 手动步骤（草稿）
      if (state.status === "draft") {
        html +=
          '<div class="form-section"><h3>手动添加步骤（该行）</h3><div class="btn-row">' +
          '<button data-mkstep="add">＋加砖</button><button data-mkstep="remove">＋减砖</button>' +
          '<button data-mkstep="review">＋复核</button><button data-mkstep="test">＋试运行</button>' +
          "</div></div>";
      }
    }

    // 选中步骤的详情
    const stp = state.selection.type === "step" ? findStep(state.selection.id) : null;
    if (stp) {
      const l2 = findLine(stp.lineId);
      const ss = state.analysis.stepStates[stp.id];
      html +=
        '<div class="form-section"><h3>步骤 #' + (stp.seq || "-") + "：" +
        CW.KIND_LABEL[stp.kind] + (stp.status === "done" ? "（已完成）" : "") + "</h3>" +
        '<div class="form-row"><label>吊杆行</label><span>' + esc(l2 ? l2.name : "?") + "</span></div>" +
        '<div class="form-row"><label>工位 / 时间</label><span class="mono">工位 ' + stp.station +
        " ｜ " + stp.start.toFixed(0) + "s → " + (stp.start + stp.duration).toFixed(0) + "s</span></div>";
      if (stp.kind === "add" || stp.kind === "remove")
        html += numInput("砖块数量", "step.count", stp.count, {
          unit: "块", disabled: !(state.status === "draft") || stp.status === "done",
        });
      if (ss)
        html +=
          '<div class="form-row"><label>完成后状态</label><span class="mono" style="font-size:12px">' +
          ss.bricks + " 块 ｜ 失衡 " + ss.imbalance + "kg ｜ 架余量 " + ss.remain + "kg</span></div>";
      if (state.status === "draft" && stp.status !== "done")
        html +=
          '<div class="btn-row"><button class="danger" id="btnDelStep">删除该步骤</button></div>';
      html += "</div>";
    }

    $("#pageLines").innerHTML = html;

    $$("[data-pick-line]").forEach((n) =>
      n.addEventListener("click", () => {
        state.selection = { type: "line", id: n.dataset.pickLine };
        render();
      })
    );
    const addL = $("#btnAddLine");
    if (addL)
      addL.onclick = () => {
        const nl = CW.newLine(
          state.sheet.lines.length + 1,
          state.sheet.bricks[0] ? state.sheet.bricks[0].id : ""
        );
        state.sheet.lines.push(nl);
        state.selection = { type: "line", id: nl.id };
        afterEdit("添加吊杆行");
      };
    const delL = $("#btnDelLine");
    if (delL)
      delL.onclick = () => {
        state.sheet.lines = state.sheet.lines.filter((x) => x.id !== l.id);
        state.sheet.steps = state.sheet.steps.filter((s) => s.lineId !== l.id);
        state.selection = { type: null, id: null };
        afterEdit("删除吊杆行");
      };
    const delS = $("#btnDelStep");
    if (delS)
      delS.onclick = () => {
        state.sheet.steps = state.sheet.steps.filter((s) => s.id !== stp.id);
        state.selection = { type: null, id: null };
        afterEdit("删除步骤");
      };
    $$("[data-mkstep]").forEach((b) =>
      b.addEventListener("click", () => {
        const kind = b.dataset.mkstep;
        const p = state.sheet.params;
        const end = state.sheet.steps.length
          ? Math.max(...state.sheet.steps.map((s) => s.start + s.duration))
          : 0;
        const ns = CW.newStep({
          kind,
          lineId: l.id,
          count: 1,
          station: 1,
          start: end,
          duration:
            kind === "review" ? p.reviewSeconds
            : kind === "test" ? p.testSeconds
            : p.stepBase + p.stepPerBrick,
        });
        state.sheet.steps.push(ns);
        state.selection = { type: "step", id: ns.id };
        afterEdit("添加步骤");
      })
    );
  }

  // ---------------------------------------------------------------- 参数/库存页
  function renderStock() {
    const sheet = state.sheet;
    const p = sheet.params;
    const dis = canEdit("params") ? "" : " disabled";
    let html =
      '<div class="form-section"><h3>引用换景沙盘</h3>' +
      '<div class="form-row"><label>沙盘项目</label><select id="sandboxSelect"' + dis + '>' +
      '<option value="">（不引用）</option>' +
      state.sandboxProjects
        .map(
          (pj) =>
            '<option value="' + pj.id + '"' +
            (state.sheet.projectId === pj.id ? " selected" : "") + ">" + esc(pj.name) + "</option>"
        )
        .join("") +
      "</select></div>" +
      '<div class="btn-row">' +
      '<button id="btnGenLines"' + dis + ">按沙盘吊杆生成行</button>" +
      '<button id="btnSyncProps"' + dis + ">同步吊物重量</button></div>" +
      (state.sandboxProj
        ? '<p style="color:var(--muted)">已引用「' + esc(state.sheet.projectName || "") + "」：" +
          (state.sandboxProj.battens || []).length + " 根吊杆 / " +
          (state.sandboxProj.cues || []).length + " 条升降提示。</p>"
        : '<p style="color:var(--muted)">未引用项目。生成行后，吊物与升降提示将随沙盘同步。</p>') +
      "</div>";

    html += '<div class="form-section"><h3>编排参数</h3>';
    html += numInput("装卸工位并发数", "param.stationCount", p.stationCount, { disabled: !canEdit("params"), step: 1 });
    html += numInput("允许失衡范围", "param.maxImbalance", p.maxImbalance, { unit: "kg", disabled: !canEdit("params") });
    html += numInput("装卸位高度", "param.loadingPos", p.loadingPos, { unit: "m", step: 0.05, disabled: !canEdit("params") });
    html += numInput("到位容差", "param.posTolerance", p.posTolerance, { unit: "m", step: 0.01, disabled: !canEdit("params") });
    html += numInput("每步最多装卸", "param.bricksPerStep", p.bricksPerStep, { unit: "块", disabled: !canEdit("params") });
    html += numInput("每步基础耗时", "param.stepBase", p.stepBase, { unit: "s", disabled: !canEdit("params") });
    html += numInput("每块砖附加", "param.stepPerBrick", p.stepPerBrick, { unit: "s", disabled: !canEdit("params") });
    html += numInput("复核耗时", "param.reviewSeconds", p.reviewSeconds, { unit: "s", disabled: !canEdit("params") });
    html += numInput("试运行耗时", "param.testSeconds", p.testSeconds, { unit: "s", disabled: !canEdit("params") });
    html += "</div>";

    html += '<div class="form-section"><h3>砖块规格与库存</h3>';
    sheet.bricks.forEach((b) => {
      const inUse = sheet.lines
        .filter((l) => CW.brickOf(sheet, l).id === b.id)
        .reduce((a, l) => a + l.initialBricks, 0);
      const selB = state.selection.type === "brick" && state.selection.id === b.id;
      html +=
        '<div class="brick-card' + (selB ? " selected" : "") + '" data-pick-brick="' + b.id + '">' +
        '<div class="form-row"><label>名称</label><input type="text" data-brick="' + b.id +
        '" data-field="name" value="' + esc(b.name) + '"' + dis + "></div>" +
        '<div class="form-row"><label>单块重量</label><input type="number" step="0.5" data-brick="' +
        b.id + '" data-field="weight" value="' + b.weight + '"' + dis + '><span class="val">kg</span></div>' +
        '<div class="form-row"><label>可用数量</label><input type="number" step="1" data-brick="' +
        b.id + '" data-field="count" value="' + b.count + '"' + dis + '><span class="val">块（在装 ' +
        inUse + "）</span></div>" +
        (sheet.bricks.length > 1 && canEdit("params")
          ? '<div class="btn-row"><button class="danger tiny" data-del-brick="' + b.id + '">删除规格</button></div>'
          : "") +
        "</div>";
    });
    html +=
      '<div class="btn-row"><button id="btnAddBrick"' + dis + ">＋ 添加砖块规格</button></div></div>";
    $("#pageStock").innerHTML = html;

    $("#sandboxSelect").onchange = async (e) => {
      const pid = e.target.value ? parseInt(e.target.value, 10) : null;
      state.sheet.projectId = pid;
      if (pid) await loadSandbox(pid);
      else {
        state.sandboxProj = null;
        state.sheet.projectName = "";
      }
      afterEdit("引用沙盘项目");
    };
    $("#btnGenLines").onclick = genLinesFromSandbox;
    $("#btnSyncProps").onclick = syncPropsFromSandbox;
    $("#btnAddBrick").onclick = () => {
      state.sheet.bricks.push(CW.newBrickSpec(state.sheet.bricks.length + 1));
      afterEdit("添加砖块规格");
    };
    $$("[data-del-brick]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.delBrick;
        state.sheet.bricks = state.sheet.bricks.filter((x) => x.id !== id);
        for (const l of state.sheet.lines)
          if (l.brickId === id) l.brickId = state.sheet.bricks[0] ? state.sheet.bricks[0].id : "";
        afterEdit("删除砖块规格");
      })
    );
    $$("[data-brick]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const bk = findBrick(inp.dataset.brick);
        if (!bk) return;
        if (inp.dataset.field === "name") bk.name = inp.value;
        else bk[inp.dataset.field] = Math.max(0, parseFloat(inp.value) || 0);
        afterEdit("修改砖块规格");
      })
    );
    $$("[data-pick-brick]").forEach((n) =>
      n.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
        state.selection = { type: "brick", id: n.dataset.pickBrick };
      })
    );
  }

  // ---------------------------------------------------------------- 检查页
  const TYPE_LABEL = {
    capacity: "超容量",
    stock: "库存不足",
    brick_short: "砖块不足",
    brake: "吊杆未制动",
    position: "未到装卸位",
    brake_release: "失衡解除制动",
    imbalance: "失衡超限",
    target: "未达目标",
  };
  function renderCheck() {
    const a = state.analysis;
    const m = a.summary;
    let html =
      '<div class="summary-pills">' +
      '<span class="pill ' + (m.high ? "bad" : "ok") + '">高危 <b>' + m.high + "</b></span>" +
      '<span class="pill ' + (m.medium ? "bad" : "") + '">警告 <b>' + m.medium + "</b></span>" +
      '<span class="pill">步骤 <b>' + m.doneSteps + "/" + m.steps + "</b></span>" +
      '<span class="pill">完成 <b>' + m.completion.toFixed(0) + "s</b></span>" +
      '<span class="pill ' + (m.peakImbalance > state.sheet.params.maxImbalance ? "bad" : "ok") +
      '">峰值失衡 <b>' + m.peakImbalance.toFixed(0) + "kg</b></span></div>";
    if (!m.total)
      html += '<div style="color:var(--accent2);padding:8px 0">✓ 当前换装单未发现问题。</div>';
    html += a.warnings
      .map((w) => {
        const l = w.lineId ? findLine(w.lineId) : null;
        return (
          '<div class="warn-item ' + w.severity + '" data-warn="' + w.id + '">' +
          '<div class="t"><span class="tag">' + (TYPE_LABEL[w.type] || w.type) + "</span>" +
          (l ? "<b>" + esc(l.name) + "</b> " : "") + esc(w.message) + "</div>" +
          '<div class="tm">' + w.start.toFixed(0) + "s – " + w.end.toFixed(0) + "s</div></div>"
        );
      })
      .join("");
    $("#pageCheck").innerHTML = html;
    $$("#pageCheck [data-warn]").forEach((n) =>
      n.addEventListener("click", () => {
        const w = a.warnings.find((x) => x.id === n.dataset.warn);
        if (w) jumpToWarning(w);
      })
    );
  }

  function jumpToWarning(w) {
    if (w.lineId) state.selection = { type: "line", id: w.lineId };
    if (w.stepId) state.selection = { type: "step", id: w.stepId };
    if (state.replay.on) state.replay.t = Math.max(0, w.start);
    render();
    switchTab("lines");
    CWTimeline.scrollToTime(w.start);
    toast("已定位：" + w.message);
  }

  // ---------------------------------------------------------------- 回放/对照页
  function renderReplayTab() {
    const comp = state.analysis.summary.completion;
    let html =
      '<div class="form-section"><h3>步骤回放</h3>' +
      '<div class="btn-row"><button id="btnReplayToggle" class="' + (state.replay.on ? "primary" : "") + '">' +
      (state.replay.on ? "退出回放" : "进入回放") + "</button>" +
      '<button id="btnReplayPlay"' + (state.replay.on ? "" : " disabled") + ">" +
      (state.replay.playing ? "⏸ 暂停" : "▶ 播放") + "</button>" +
      '<select id="replaySpeed" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px">' +
      '<option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></div>' +
      '<input type="range" id="replaySlider" min="0" max="' + Math.max(1, Math.round(comp * 10)) +
      '" value="' + Math.round(state.replay.t * 10) + '" style="width:100%"' +
      (state.replay.on ? "" : " disabled") + ">" +
      '<p style="color:var(--muted)">回放按步骤时间轴推进，配重架视图中的砖块随进度增减；' +
      "完成后归档的换装单可在此完整复盘。</p></div>";

    html += '<div class="form-section"><h3>历史换装单</h3><div id="cwHistoryList">';
    html += state.sheetList.length
      ? state.sheetList
          .map((s) => {
            const m = s.metrics || {};
            return (
              '<div class="history-item"><span class="nm">' + esc(s.name) +
              (s.scene ? " · " + esc(s.scene) : "") +
              '<br><span class="ts">' + (CW.STATUS_LABEL[s.status] || s.status) +
              " ｜ 步骤 " + (m.steps != null ? m.steps : "-") +
              " ｜ 高危 " + (m.high != null ? m.high : "-") +
              " ｜ 完成 " + (m.completion != null ? m.completion.toFixed(0) + "s" : "-") +
              "</span></span>" +
              '<button class="tiny" data-open-sheet="' + s.id + '">打开</button>' +
              '<button class="tiny" data-compare-sheet="' + s.id + '">对照</button></div>'
            );
          })
          .join("")
      : '<div class="empty-hint">还没有已保存的换装单。</div>';
    html += "</div></div>";
    $("#pageReplay").innerHTML = html;

    $("#btnReplayToggle").onclick = () => {
      state.replay.on = !state.replay.on;
      state.replay.playing = false;
      state.replay.t = 0;
      cancelAnimationFrame(rafId);
      render();
    };
    const playBtn = $("#btnReplayPlay");
    if (playBtn) playBtn.onclick = toggleReplayPlay;
    const slider = $("#replaySlider");
    if (slider)
      slider.oninput = () => {
        state.replay.t = parseInt(slider.value, 10) / 10;
        renderViewsOnly();
      };
    const speed = $("#replaySpeed");
    if (speed) speed.onchange = () => {};
    $$("[data-open-sheet]").forEach((b) =>
      b.addEventListener("click", () => loadSheet(parseInt(b.dataset.openSheet, 10)))
    );
    $$("[data-compare-sheet]").forEach((b) =>
      b.addEventListener("click", () => openCompare(parseInt(b.dataset.compareSheet, 10)))
    );
  }

  function toggleReplayPlay() {
    if (state.replay.playing) {
      state.replay.playing = false;
      cancelAnimationFrame(rafId);
      renderReplayTab();
      return;
    }
    const comp = Math.max(1, state.analysis.summary.completion);
    if (state.replay.t >= comp - 0.05) state.replay.t = 0;
    state.replay.playing = true;
    const wall0 = performance.now();
    const t0 = state.replay.t;
    const loop = (now) => {
      if (!state.replay.playing) return;
      const speed = parseFloat(($("#replaySpeed") || { value: "1" }).value) || 1;
      state.replay.t = Math.min(t0 + ((now - wall0) / 1000) * speed, comp);
      renderViewsOnly();
      if (state.replay.t >= comp) {
        state.replay.playing = false;
        renderReplayTab();
        return;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    renderReplayTab();
  }
  function stopReplay() {
    state.replay.playing = false;
    cancelAnimationFrame(rafId);
  }

  // ---------------------------------------------------------------- 对照
  async function openCompare(otherId) {
    try {
      const other = await API.getCwSheet(otherId);
      const cur =
        state.sheetId != null
          ? { name: $("#sheetName").value, data: state.sheet, metrics: CW.metrics(state.sheet) }
          : null;
      const sheets = [cur, { name: other.name, data: other.data, metrics: other.metrics }].filter(Boolean);
      if (sheets.length < 2 && !cur) {
        toast("请先打开或保存一张换装单再对照", true);
        return;
      }
      const rows = ["completion", "steps", "doneSteps", "high", "medium", "peakImbalance"];
      const labels = {
        completion: "完成时长 s", steps: "步骤数", doneSteps: "已执行",
        high: "高危", medium: "警告", peakImbalance: "峰值失衡 kg",
      };
      let html =
        '<table class="cmp-table"><tr><th></th>' +
        sheets.map((s) => "<th>" + esc(s.name) + "</th>").join("") + "</tr>";
      for (const r of rows) {
        html += "<tr><td>" + labels[r] + "</td>" +
          sheets
            .map((s) => {
              const v = s.metrics ? s.metrics[r] : null;
              return "<td>" + (v == null ? "-" : v) + "</td>";
            })
            .join("") + "</tr>";
      }
      html += "</table>";
      // 各行末态对照
      html += '<h4 style="margin:10px 0 6px">各行最终配重对照</h4><table class="cmp-table"><tr><th>吊杆行</th>' +
        sheets.map((s) => "<th>" + esc(s.name) + "</th>").join("") + "</tr>";
      const finals = sheets.map((s) => CW.simulate(s.data).finalStates);
      const names = sheets.map((s) => CW.normalize(s.data).lines);
      const allNames = new Set();
      names.forEach((ls) => ls.forEach((l) => allNames.add(l.name)));
      for (const nm of allNames) {
        html += "<tr><td>" + esc(nm) + "</td>" +
          sheets
            .map((s, i) => {
              const l = names[i].find((x) => x.name === nm);
              if (!l) return "<td>-</td>";
              const f = finals[i][l.id];
              return (
                "<td>" + f.bricks + "块 ｜ 失衡 " + f.imbalance + "kg ｜ 余量 " + f.remain + "kg</td>"
              );
            })
            .join("") + "</tr>";
      }
      html += "</table>";
      $("#compareBody").innerHTML = html;
      $("#modalCompare").classList.add("show");
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------------------------------------------------------- 沙盘引用
  async function loadSandbox(pid, silent) {
    try {
      const r = await API.getProject(pid);
      state.sandboxProj = E.normalizeProject(r.data);
      state.sheet.projectId = pid;
      state.sheet.projectName = r.name;
      if (!silent) render();
    } catch (e) {
      toast("载入沙盘项目失败：" + e.message, true);
    }
  }

  function genLinesFromSandbox() {
    const proj = state.sandboxProj;
    if (!proj) {
      toast("请先选择沙盘项目", true);
      return;
    }
    if (!state.sheet.bricks.length) state.sheet.bricks.push(CW.newBrickSpec(1));
    const bk = state.sheet.bricks[0];
    let added = 0;
    for (const b of proj.battens) {
      if (state.sheet.lines.some((l) => l.battenId === b.id)) continue;
      const nl = CW.newLine(state.sheet.lines.length + 1, bk.id);
      nl.name = b.name;
      nl.battenId = b.id;
      nl.pipeWeight = 40;
      if (b.prop) {
        nl.propName = b.prop.name;
        nl.propWeight = b.prop.weight;
      }
      // 已装砖块按当前平衡估算，目标留自动 → 换装后随吊物变化产生差额
      nl.initialBricks = Math.round(CW.stageWeight(nl) / bk.weight);
      nl.arborCapacity = Math.max(200, Math.ceil((CW.stageWeight(nl) * 1.3) / 25) * 25);
      state.sheet.lines.push(nl);
      added++;
    }
    afterEdit("从沙盘生成行");
    toast(added ? "已生成 " + added + " 行" : "没有新的吊杆可生成（可能都已存在）");
  }

  function syncPropsFromSandbox() {
    const proj = state.sandboxProj;
    if (!proj) {
      toast("请先选择沙盘项目", true);
      return;
    }
    let n = 0;
    for (const l of state.sheet.lines) {
      if (!l.battenId || l.propLocked) continue;
      const b = (proj.battens || []).find((x) => x.id === l.battenId);
      if (!b) continue;
      l.propName = b.prop ? b.prop.name : "";
      l.propWeight = b.prop ? b.prop.weight : 0;
      n++;
    }
    afterEdit("同步吊物");
    toast("已同步 " + n + " 行吊物（锁定行已跳过）");
  }

  // ---------------------------------------------------------------- 编辑后处理
  function afterEdit(label, opts) {
    opts = opts || {};
    // 执行中的临时变更：仅重排未完成步骤
    if (state.status === "running" && !opts.noReplan) {
      state.sheet.steps = CW.planSteps(state.sheet, { keepDone: true });
      toast("已按变更重排未完成步骤");
    }
    render();
    scheduleSave();
  }

  // 统一数据绑定
  $(".tab-body").addEventListener("change", (e) => {
    const node = e.target;
    const bind = node.dataset && node.dataset.bind;
    if (!bind) return;
    const [root, key] = bind.split(".");
    if (root === "line") {
      const l = findLine(state.selection.id);
      if (!l) return;
      if (!canEdit(key)) {
        toast("当前状态不可修改该字段", true);
        render();
        return;
      }
      if ((key === "propName" || key === "propWeight") && l.propLocked) {
        toast("已挂吊物被舞台监督锁定", true);
        render();
        return;
      }
      if ((key === "initialBricks" || key === "targetBricks") && l.bricksLocked) {
        toast("已装砖块被舞台监督锁定", true);
        render();
        return;
      }
      applyValue(l, key, node);
      if (key === "battenId") {
        l.cueId = "";
        syncOneLine(l);
      }
      // 执行中仅吊物/目标砖变更需要重排；其余（制动、架位等）只影响告警
      const replanKeys = ["propWeight", "targetBricks", "initialBricks"];
      afterEdit("修改吊杆行", {
        noReplan: state.status === "running" && replanKeys.indexOf(key) < 0,
      });
    } else if (root === "param") {
      if (!canEdit("params")) {
        toast("当前状态不可修改参数", true);
        render();
        return;
      }
      state.sheet.params[key] = parseFloat(node.value) || 0;
      afterEdit("修改参数");
    } else if (root === "step") {
      const s = findStep(state.selection.id);
      if (!s || state.status !== "draft") return;
      applyValue(s, key, node);
      afterEdit("修改步骤");
    }
  });

  function applyValue(obj, key, node) {
    if (node.type === "checkbox") obj[key] = node.checked;
    else if (node.type === "number")
      obj[key] = node.value === "" ? null : parseFloat(node.value);
    else obj[key] = node.value;
  }

  function syncOneLine(l) {
    const proj = state.sandboxProj;
    if (!proj || !l.battenId || l.propLocked) return;
    const b = (proj.battens || []).find((x) => x.id === l.battenId);
    if (!b) return;
    l.propName = b.prop ? b.prop.name : "";
    l.propWeight = b.prop ? b.prop.weight : 0;
  }

  // ---------------------------------------------------------------- 编排
  $("#btnPlan").onclick = () => {
    if (!state.sheet.lines.length) {
      toast("请先添加吊杆行", true);
      return;
    }
    if (state.status === "checked" || state.status === "done") {
      toast("当前状态不可重新编排", true);
      return;
    }
    state.sheet.steps = CW.planSteps(state.sheet, { keepDone: state.status === "running" });
    state.selection = { type: null, id: null };
    afterEdit("自动编排", { noReplan: true });
    toast("已编排 " + state.sheet.steps.filter((s) => s.status !== "done").length + " 个待执行步骤");
  };
  $("#btnClearSteps").onclick = () => {
    if (state.status !== "draft") {
      toast("仅草稿状态可清空步骤", true);
      return;
    }
    state.sheet.steps = [];
    afterEdit("清空步骤", { noReplan: true });
  };

  // ---------------------------------------------------------------- 执行
  $("#btnConfirm").onclick = async () => {
    try {
      const r = await API.confirmCwStep(state.sheetId);
      state.sheet = CW.normalize(r.data);
      render();
      scheduleMetricsSave();
      toast("已确认步骤：" + (r.stepId || ""));
    } catch (e) {
      toast(e.message, true);
    }
  };
  $("#btnUndoStep").onclick = async () => {
    try {
      const r = await API.undoCwStep(state.sheetId);
      state.sheet = CW.normalize(r.data);
      render();
      scheduleMetricsSave();
      toast("已撤回步骤：" + (r.stepId || ""));
    } catch (e) {
      toast(e.message, true);
    }
  };
  // 确认/撤回后把最新步骤状态与指标落库（data 未变则仅更新 metrics）
  function scheduleMetricsSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await API.saveCwSheet(state.sheetId, { metrics: CW.metrics(state.sheet) });
        await refreshSheetList();
      } catch (_) {}
    }, 600);
  }

  // ---------------------------------------------------------------- 视图回调
  CWArbor.init($("#arborSvg"), {
    onSelectLine(id) {
      state.selection = { type: "line", id };
      switchTab("lines");
      render();
    },
  });
  CWTimeline.init($("#cwTimelineSvg"), $("#cwTlScroll"), {
    onSelectStep(id) {
      state.selection = { type: "step", id };
      switchTab("lines");
      render();
    },
    onSelectWarning(w) {
      jumpToWarning(w);
    },
    onSeek(t) {
      if (!state.replay.on) state.replay.on = true;
      state.replay.t = Math.min(t, Math.max(1, state.analysis.summary.completion));
      renderViewsOnly();
      renderReplayTab();
    },
  });

  // ---------------------------------------------------------------- Tab
  function switchTab(name) {
    $$(".tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".tab-page").forEach((p) => p.classList.toggle("active", p.dataset.page === name));
  }
  $$(".tabs .tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // ---------------------------------------------------------------- 顶栏
  $("#btnSave").onclick = manualSave;
  $("#sheetName").addEventListener("input", scheduleSave);
  $("#sheetScene").addEventListener("input", scheduleSave);
  $("#sheetSelect").addEventListener("change", async (e) => {
    stopReplay();
    if (e.target.value === "") {
      state.sheetId = null;
      state.sheet = demoSheet();
      state.status = "draft";
      $("#sheetName").value = state.sheet.name;
      $("#sheetScene").value = state.sheet.scene;
      state.selection = { type: null, id: null };
      state.replay = { on: false, t: 0, playing: false };
      render();
    } else {
      await loadSheet(parseInt(e.target.value, 10));
    }
  });
  $("#btnDelete").onclick = async () => {
    if (state.sheetId == null) {
      toast("内存草稿无需删除", true);
      return;
    }
    if (!confirm("确定删除换装单「" + $("#sheetName").value + "」？此操作不可恢复。")) return;
    await API.deleteCwSheet(state.sheetId);
    state.sheetId = null;
    await refreshSheetList();
    if (state.sheetList.length) await loadSheet(state.sheetList[0].id);
    else {
      state.sheet = demoSheet();
      state.status = "draft";
      $("#sheetName").value = state.sheet.name;
      $("#sheetScene").value = state.sheet.scene;
      render();
    }
    toast("已删除");
  };

  // ---------------------------------------------------------------- 新建
  function demoSheet() {
    const s = CW.newSheet("演示：一幕→二幕配重换装", "第一幕 → 第二幕");
    s.bricks = [{ id: "bk_demo", name: "标准铁砖 25kg", weight: 25, count: 20 }];
    const mk = (o) => Object.assign(CW.newLine(0, "bk_demo"), o);
    s.lines = [
      mk({
        id: "ln_d1", name: "台口幕杆", pipeWeight: 45,
        propName: "丝绒大幕", propWeight: 120, arborCapacity: 300, initialBricks: 6,
      }),
      mk({
        id: "ln_d2", name: "布景杆 A", pipeWeight: 42,
        propName: "城堡景片", propWeight: 150, arborCapacity: 320, initialBricks: 5,
      }),
      mk({
        id: "ln_d3", name: "灯杆 B", pipeWeight: 38,
        propName: "顶灯排", propWeight: 80, arborCapacity: 260, initialBricks: 7,
      }),
    ];
    s.steps = CW.planSteps(s);
    return CW.normalize(s);
  }

  $("#btnNewSheet").onclick = async () => {
    $("#newSheetName").value = "未命名换装单";
    $("#newSheetScene").value = "";
    const sel = $("#newSheetProject");
    sel.innerHTML =
      '<option value="">（不引用）</option>' +
      state.sandboxProjects
        .map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>")
        .join("");
    $("#modalNew").classList.add("show");
  };
  $("#btnConfirmNew").onclick = async () => {
    const name = $("#newSheetName").value.trim() || "未命名换装单";
    const scene = $("#newSheetScene").value.trim();
    const tpl = $("#newSheetTpl").value;
    const pid = $("#newSheetProject").value;
    $("#modalNew").classList.remove("show");
    let data = tpl === "demo" ? demoSheet() : CW.newSheet(name, scene);
    data.name = name;
    data.scene = scene;
    try {
      const r = await API.createCwSheet(
        name, scene, pid ? parseInt(pid, 10) : null, data, CW.metrics(data)
      );
      state.sheetId = r.id;
      state.status = "draft";
      state.sheet = CW.normalize(data);
      state.sheet.projectId = pid ? parseInt(pid, 10) : null;
      $("#sheetName").value = name;
      $("#sheetScene").value = scene;
      state.selection = { type: null, id: null };
      state.replay = { on: false, t: 0, playing: false };
      if (pid) await loadSandbox(parseInt(pid, 10), true);
      await refreshSheetList(r.id);
      render();
      toast("已创建换装单：" + name);
    } catch (e) {
      toast(e.message, true);
    }
  };

  // 模态框通用关闭
  $$(".modal-mask").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || (e.target.dataset && e.target.dataset.close != null))
        m.classList.remove("show");
    });
  });

  // ---------------------------------------------------------------- 键盘
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space" && state.replay.on) {
      e.preventDefault();
      toggleReplayPlay();
    }
  });

  // ---------------------------------------------------------------- 启动
  async function boot() {
    try {
      state.sandboxProjects = await API.listProjects();
    } catch (e) {
      toast("后端不可用，请先启动 app.py", true);
    }
    try {
      await refreshSheetList();
      if (state.sheetList.length) {
        await loadSheet(state.sheetList[0].id);
        return;
      }
    } catch (e) {
      toast("载入换装单失败：" + e.message, true);
    }
    // 无已存单据：内存演示
    state.sheet = demoSheet();
    state.status = "draft";
    $("#sheetName").value = state.sheet.name;
    $("#sheetScene").value = state.sheet.scene;
    render();
  }
  boot();
})();
