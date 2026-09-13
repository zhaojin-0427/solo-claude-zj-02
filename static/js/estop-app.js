/* estop-app.js —— 紧急停车演练单主控：来源版本、触发点选、扫描、确认冻结、回放对照 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 状态
  const state = {
    drillId: null,
    drill: ES.newDrill("未命名演练单"),
    status: "draft",
    selection: { type: null, id: null }, // batten | warning
    sim: null, // ES.simulate 结果（含轨迹曲线）
    cursor: 0, // 回放游标（绝对时刻 s）
    playing: false,
    scanResults: null, // {rows, scanned, from, to, step}
    stale: false,
    staleReason: "",
    drillList: [],
    projects: [], // 沙盘项目列表
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

  const editable = () => state.status === "draft";
  const proj = () => (state.drill.project ? E.normalizeProject(state.drill.project) : null);

  // ---------------------------------------------------------------- 保存
  function payload(extra) {
    return Object.assign(
      {
        name: $("#drillName").value.trim() || "未命名演练单",
        projectId: state.drill.projectId,
        versionId: state.drill.versionId,
        data: state.drill,
        metrics: ES.metrics(state.drill),
      },
      extra || {}
    );
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 700);
  }
  async function saveNow() {
    if (state.drillId == null || !editable()) return;
    try {
      await API.saveEstopDrill(state.drillId, payload());
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }
  async function manualSave() {
    try {
      if (state.drillId == null) {
        const r = await API.createEstopDrill(
          $("#drillName").value.trim() || "未命名演练单",
          state.drill.projectId,
          state.drill.versionId,
          state.drill,
          ES.metrics(state.drill)
        );
        state.drillId = r.id;
        await refreshDrillList(r.id);
      } else {
        await API.saveEstopDrill(state.drillId, payload());
      }
      toast("已保存到本地数据库");
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }

  async function refreshDrillList(selectId) {
    state.drillList = await API.listEstopDrills();
    const sel = $("#drillSelect");
    sel.innerHTML =
      '<option value="">（内存中的草稿）</option>' +
      state.drillList
        .map(
          (d) =>
            '<option value="' + d.id + '">' + esc(d.name) +
            "（" + (ES.STATUS_LABEL[d.status] || d.status) + "）</option>"
        )
        .join("");
    if (selectId != null) sel.value = String(selectId);
    else if (state.drillId != null) sel.value = String(state.drillId);
  }

  async function loadDrill(id) {
    const r = await API.getEstopDrill(id);
    state.drillId = r.id;
    state.drill = ES.normalize(r.data);
    state.drill.projectId = r.projectId;
    if (state.drill.versionId == null) state.drill.versionId = r.versionId;
    state.status = r.status;
    $("#drillName").value = r.name;
    state.selection = { type: null, id: null };
    state.scanResults = null;
    stopPlay();
    state.cursor = state.drill.trigger;
    await checkStale();
    render();
  }

  // ---------------------------------------------------------------- 来源版本与过期标记
  async function captureSource(projectId, versionId, silent) {
    try {
      let data, label, projName = "";
      if (versionId) {
        const v = await API.getVersion(versionId);
        data = v.data;
        label = v.label;
        const pj = state.projects.find((p) => p.id === projectId);
        projName = pj ? pj.name : "";
      } else {
        const p = await API.getProject(projectId);
        data = p.data;
        projName = p.name;
        label = "当前数据";
      }
      state.drill.project = E.normalizeProject(data);
      state.drill.projectId = projectId;
      state.drill.projectName = projName;
      state.drill.versionId = versionId || null;
      state.drill.versionLabel = label;
      state.drill.fingerprint = ES.fingerprint(state.drill.project);
      // 触发时刻钳入新时间轴；各杆制动参数沿用（按吊杆 id 匹配）
      const h = E.horizon(state.drill.project);
      state.drill.trigger = ES.clamp(state.drill.trigger, 0, Math.max(0, h - 0.1));
      state.cursor = state.drill.trigger;
      state.stale = false;
      if (!silent) afterEdit("读取沙盘版本");
      toast("已读取来源：" + projName + " / " + label);
    } catch (e) {
      toast("读取来源失败：" + e.message, true);
    }
  }

  // 来源版本变化后只标记过期，不自动更新
  async function checkStale() {
    state.stale = false;
    state.staleReason = "";
    if (state.status !== "draft" || !state.drill.projectId || !state.drill.fingerprint) {
      renderStaleBar();
      return;
    }
    try {
      let data;
      if (state.drill.versionId) {
        const v = await API.getVersion(state.drill.versionId);
        data = v.data;
      } else {
        const p = await API.getProject(state.drill.projectId);
        data = p.data;
      }
      const fp = ES.fingerprint(E.normalizeProject(data));
      if (fp !== state.drill.fingerprint) {
        state.stale = true;
        state.staleReason = "来源内容已变化";
      }
    } catch (e) {
      state.stale = true;
      state.staleReason = "来源版本不可读取（可能已删除）";
    }
    renderStaleBar();
  }

  function renderStaleBar() {
    const show = state.stale && state.status === "draft";
    $("#staleBadge").style.display = show ? "inline" : "none";
    $("#staleBar").style.display = show ? "flex" : "none";
    if (show)
      $("#staleBar").querySelector("span").textContent =
        "⚠ " + (state.staleReason || "来源沙盘版本已变化") +
        "，本演练单仍按抓取时的数据推演（仅标记过期，不自动更新）。";
  }

  // ---------------------------------------------------------------- 状态流转
  async function confirmDrill() {
    if (state.drillId == null) {
      toast("请先保存演练单，再确认冻结", true);
      return;
    }
    if (!state.drill.project) {
      toast("请先在「触发参数」页读取沙盘版本数据", true);
      switchTab("trigger");
      return;
    }
    await saveNow(); // 先落库未保存的编辑，再确认
    try {
      await API.saveEstopDrill(state.drillId, { status: "done" });
      await loadDrill(state.drillId); // 重新载入服务端冻结的快照
      await refreshDrillList();
      toast("已确认冻结，逐杆停车检查卡已生成");
      switchTab("cards");
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    state.drill = ES.normalize(state.drill);
    state.sim = state.drill.project ? ES.simulate(state.drill) : null;
    renderStatusBar();
    renderStaleBar();
    renderViewsOnly();
    renderTriggerTab();
    renderScanTab();
    renderCheckTab();
    renderCardsTab();
    renderReplayTab();
  }

  function renderViewsOnly() {
    const p = proj();
    ESStage.set({
      proj: p,
      sim: state.sim,
      cursor: state.cursor,
      selection: state.selection,
    });
    ESChart.set({
      proj: p,
      sim: state.sim,
      trigger: state.drill.trigger,
      cursor: state.cursor,
      selection: state.selection,
    });
    $("#cursorClock").textContent =
      "游标 " + state.cursor.toFixed(1) + " s ｜ 急停 " + state.drill.trigger.toFixed(1) + " s";
    const slider = $("#replaySlider");
    if (slider) slider.value = String(Math.round(state.cursor * 10));
  }

  function renderStatusBar() {
    const pill = $("#statusPill");
    pill.textContent = ES.STATUS_LABEL[state.status];
    pill.className = "status-pill st-" + state.status;
    const acts = $("#statusActions");
    acts.innerHTML =
      state.status === "draft"
        ? '<button class="tiny primary" id="btnConfirm">确认演练 ✓ 冻结</button>'
        : "";
    const cf = $("#btnConfirm");
    if (cf) cf.addEventListener("click", confirmDrill);
    const bar = $("#readonlyBar");
    if (state.status === "done") {
      const snap = state.drill.snapshot;
      bar.style.display = "flex";
      bar.innerHTML =
        "🔒 演练单已确认冻结" +
        (snap && snap.frozenAt
          ? "（" + new Date(snap.frozenAt).toLocaleString() + "）"
          : "") +
        "，输入快照不可改写；可在「回放/对照」页复盘，或对照历史演练单。";
    } else {
      bar.style.display = "none";
    }
    $("#drillName").disabled = !editable();
    $("#triggerNum").disabled = !editable();
    $("#respDelay").disabled = !editable();
    // 工具栏数值同步
    $("#triggerNum").value = state.drill.trigger;
    $("#respDelay").value = state.drill.params.responseDelay;
  }

  // ---------------------------------------------------------------- 触发参数页
  const numInput = (label, bind, val, opt) => {
    opt = opt || {};
    return (
      '<div class="form-row"><label>' + esc(label) + "</label>" +
      '<input type="number" step="' + (opt.step || 0.1) + '" data-bind="' + bind + '"' +
      ' value="' + (val == null ? "" : val) + '"' +
      (opt.disabled ? " disabled" : "") + ">" +
      (opt.unit ? '<span class="val">' + opt.unit + "</span>" : "") + "</div>"
    );
  };

  function renderTriggerTab() {
    const d = state.drill;
    const dis = editable() ? "" : " disabled";
    let html = '<div class="form-section"><h3>来源沙盘版本</h3>';
    html +=
      '<div class="form-row"><label>沙盘项目</label><select id="srcProject"' + dis + ">" +
      '<option value="">（未引用）</option>' +
      state.projects
        .map(
          (p) =>
            '<option value="' + p.id + '"' +
            (d.projectId === p.id ? " selected" : "") + ">" + esc(p.name) + "</option>"
        )
        .join("") +
      "</select></div>";
    html +=
      '<div class="form-row"><label>来源版本</label><select id="srcVersion"' + dis + ">" +
      '<option value="">（项目当前数据）</option></select></div>';
    html +=
      '<div class="btn-row"><button id="btnReadSource"' + dis + ">读取来源版本</button>" +
      '<button id="btnCheckStale"' + (d.projectId ? "" : " disabled") + ">检查来源变化</button></div>";
    if (d.project) {
      html +=
        '<p style="color:var(--muted)">已抓取「' + esc(d.projectName || "未命名") + " / " +
        esc(d.versionLabel || "当前数据") + "」：" + d.project.battens.length + " 根吊杆 / " +
        d.project.cues.length + " 条提示" +
        (state.stale ? '；<b style="color:var(--warn)">来源已过期</b>' : "") + "。</p>";
    } else {
      html += '<p style="color:var(--muted)">尚未读取沙盘数据。选择项目与版本后点击「读取来源版本」。</p>';
    }
    html += "</div>";

    html += '<div class="form-section"><h3>急停与扫描参数</h3>';
    html += numInput("急停触发时刻", "param.trigger", d.trigger, { unit: "s", disabled: !editable() });
    html += numInput("总控响应延迟", "param.responseDelay", d.params.responseDelay, { unit: "s", disabled: !editable() });
    html += numInput("默认制动延迟", "param.brakeDelay", d.params.brakeDelay, { unit: "s", disabled: !editable() });
    html += numInput("默认应急减速度", "param.decel", d.params.decel, { unit: "m/s²", disabled: !editable() });
    html += numInput("联动时刻容差", "param.linkTimeTol", d.params.linkTimeTol, { unit: "s", disabled: !editable() });
    html += numInput("联动终高容差", "param.linkPosTol", d.params.linkPosTol, { unit: "m", disabled: !editable() });
    html += numInput("扫描起点", "param.scanFrom", d.params.scanFrom, { unit: "s", disabled: !editable() });
    html += numInput("扫描终点(0=自动)", "param.scanTo", d.params.scanTo, { unit: "s", disabled: !editable() });
    html += numInput("扫描步长", "param.scanStep", d.params.scanStep, { unit: "s", disabled: !editable() });
    html += "</div>";

    // 各运动吊杆制动参数
    if (d.project) {
      const p = proj();
      html += '<div class="form-section"><h3>各杆制动参数（制动延迟 / 应急减速度）</h3>';
      for (const b of p.battens) {
        const bk = ES.brakeFor(d, b.id);
        const overridden = !!d.brakes[b.id];
        const sel = state.selection.type === "batten" && state.selection.id === b.id;
        html +=
          '<div class="brake-row' + (sel ? " selected" : "") + '" data-pick-batten="' + b.id + '">' +
          '<span class="nm">' + esc(b.name) + "</span>" +
          '<input type="number" step="0.1" min="0" data-brake="' + b.id + '" data-field="delay"' +
          ' value="' + bk.delay + '"' + dis + '><span class="unit">s</span>' +
          '<input type="number" step="0.1" min="0.05" data-brake="' + b.id + '" data-field="decel"' +
          ' value="' + bk.decel + '"' + dis + '><span class="unit">m/s²</span>' +
          (overridden
            ? '<button class="tiny" data-brake-reset="' + b.id + '"' + dis + ">默认</button>"
            : '<span class="unit">默认</span>') +
          "</div>";
      }
      html += "</div>";
    }
    $("#pageTrigger").innerHTML = html;
    // 已引用项目时补齐版本下拉（保持当前来源版本选中）
    if (d.projectId) fillVersionSelect(d.projectId, d.versionId);

    $("#srcProject").onchange = async (e) => {
      await fillVersionSelect(e.target.value ? parseInt(e.target.value, 10) : null, null);
    };
    $("#btnReadSource").onclick = async () => {
      const pid = $("#srcProject").value ? parseInt($("#srcProject").value, 10) : null;
      if (!pid) {
        toast("请先选择沙盘项目", true);
        return;
      }
      const vid = $("#srcVersion").value ? parseInt($("#srcVersion").value, 10) : null;
      await captureSource(pid, vid);
    };
    $("#btnCheckStale").onclick = async () => {
      await checkStale();
      toast(state.stale ? "来源已变化：本单标记过期" : "来源未变化");
      render();
    };
    $$("#pageTrigger [data-pick-batten]").forEach((n) =>
      n.addEventListener("click", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
        state.selection = { type: "batten", id: n.dataset.pickBatten };
        render();
      })
    );
    $$("#pageTrigger [data-brake]").forEach((inp) =>
      inp.addEventListener("change", () => {
        if (!editable()) return;
        const bid = inp.dataset.brake;
        const cur = ES.brakeFor(state.drill, bid);
        state.drill.brakes[bid] = state.drill.brakes[bid] || { delay: cur.delay, decel: cur.decel };
        state.drill.brakes[bid][inp.dataset.field] = parseFloat(inp.value) || 0;
        afterEdit("修改制动参数");
      })
    );
    $$("#pageTrigger [data-brake-reset]").forEach((btn) =>
      btn.addEventListener("click", () => {
        delete state.drill.brakes[btn.dataset.brakeReset];
        afterEdit("恢复默认制动参数");
      })
    );
  }

  async function fillVersionSelect(projectId, selectId) {
    const sel = $("#srcVersion");
    let opts = '<option value="">（项目当前数据）</option>';
    if (projectId) {
      try {
        const list = await API.listVersions(projectId);
        opts += list
          .map(
            (v) =>
              '<option value="' + v.id + '"' +
              (selectId === v.id || state.drill.versionId === v.id ? " selected" : "") +
              ">" + esc(v.label) + "</option>"
          )
          .join("");
      } catch (e) {
        toast("读取版本列表失败：" + e.message, true);
      }
    }
    sel.innerHTML = opts;
  }

  // ---------------------------------------------------------------- 扫描页
  function renderScanTab() {
    const d = state.drill;
    let html =
      '<div class="form-section"><h3>危险触发点扫描</h3>' +
      '<p style="color:var(--muted)">在指定时段内逐点试触发，按 <b>高危冲突数 → 最大制动距离 → 全部停止用时</b> 排列危险触发点。</p>' +
      '<div class="btn-row"><button id="btnRunScan" class="primary"' +
      (d.project && editable() ? "" : " disabled") + ">⚡ 扫描 " +
      d.params.scanFrom + "s – " + (d.params.scanTo > 0 ? d.params.scanTo + "s" : "自动") +
      "（步长 " + d.params.scanStep + "s）</button></div>";
    if (state.scanResults) {
      const r = state.scanResults;
      html +=
        '<p style="color:var(--muted)">已扫描 ' + r.scanned + " 个触发点（" + r.from + "s – " +
        r.to + "s，步长 " + r.step + "s）。点击行采用该触发时刻。</p>";
      const top = r.rows.slice(0, 15);
      html += top
        .map((row, i) => {
          const danger = row.high > 0;
          const cur = Math.abs(row.t - d.trigger) < 1e-6;
          return (
            '<div class="scan-item' + (danger ? " danger" : "") + (cur ? " current" : "") +
            '" data-scan-t="' + row.t + '">' +
            '<span class="rk">#' + (i + 1) + "</span>" +
            '<span class="tm mono">' + row.t.toFixed(1) + "s</span>" +
            '<span class="meta mono">高危 <b>' + row.high + "</b> ｜ 制动 " +
            row.maxBrakeDist.toFixed(2) + "m ｜ 全停 " + row.allStopTime.toFixed(2) + "s</span>" +
            "</div>"
          );
        })
        .join("");
      if (!top.length) html += '<div class="empty-hint">时段内没有可扫描的触发点。</div>';
    } else {
      html += '<div class="empty-hint">尚未扫描。设置扫描时段后点击上方按钮。</div>';
    }
    html += "</div>";
    $("#pageScan").innerHTML = html;
    const btn = $("#btnRunScan");
    if (btn) btn.onclick = runScan;
    $$("#pageScan [data-scan-t]").forEach((n) =>
      n.addEventListener("click", () => {
        setTrigger(parseFloat(n.dataset.scanT));
        toast("已采用触发时刻 " + parseFloat(n.dataset.scanT).toFixed(1) + "s");
      })
    );
  }

  function runScan() {
    if (!state.drill.project) {
      toast("请先读取沙盘版本数据", true);
      return;
    }
    const r = ES.scan(state.drill);
    state.scanResults = r;
    renderScanTab();
    switchTab("scan");
    const best = r.rows[0];
    toast(
      best
        ? "扫描完成：最危险触发点 " + best.t.toFixed(1) + "s（高危 " + best.high + "）"
        : "扫描完成：时段内无运动"
    );
  }

  // ---------------------------------------------------------------- 告警页
  function renderCheckTab() {
    const sim = state.sim;
    if (!sim) {
      $("#pageCheck").innerHTML =
        '<div class="empty-hint">尚未读取沙盘数据，无法推演。</div>';
      return;
    }
    const m = sim.summary;
    let html =
      '<div class="summary-pills">' +
      '<span class="pill ' + (m.high ? "bad" : "ok") + '">高危 <b>' + m.high + "</b></span>" +
      '<span class="pill ' + (m.medium ? "bad" : "") + '">警告 <b>' + m.medium + "</b></span>" +
      '<span class="pill">最大制动 <b>' + m.maxBrakeDist.toFixed(2) + "m</b></span>" +
      '<span class="pill">全部停止 <b>' + m.allStopTime.toFixed(2) + "s</b></span>" +
      '<span class="pill">运动吊杆 <b>' + m.movingCount + "</b></span></div>";
    if (!m.total)
      html += '<div style="color:var(--accent2);padding:8px 0">✓ 该触发时刻下急停推演未发现风险。</div>';
    html += sim.warnings
      .map((w) => {
        const sel = state.selection.type === "warning" && state.selection.id === w.id;
        return (
          '<div class="warn-item ' + w.severity + (sel ? " selected" : "") +
          '" data-warn="' + w.id + '">' +
          '<div class="t"><span class="tag">' + (ES.TYPE_LABEL[w.type] || w.type) + "</span>" +
          esc(w.message) + "</div>" +
          '<div class="tm">' + w.start.toFixed(2) + "s – " + w.end.toFixed(2) + "s</div></div>"
        );
      })
      .join("");
    $("#pageCheck").innerHTML = html;
    $$("#pageCheck [data-warn]").forEach((n) =>
      n.addEventListener("click", () => {
        const w = sim.warnings.find((x) => x.id === n.dataset.warn);
        if (w) jumpToWarning(w);
      })
    );
  }

  // 点选警告：跳到相关吊杆与风险时刻
  function jumpToWarning(w) {
    state.selection = { type: "warning", id: w.id };
    if (w.battenIds && w.battenIds.length)
      state.selection = { type: "batten", id: w.battenIds[0], warnId: w.id };
    state.cursor = Math.max(0, w.start);
    render();
    ESChart.scrollToTime(w.start);
    toast("已定位风险时刻 " + w.start.toFixed(2) + "s");
  }

  // ---------------------------------------------------------------- 检查卡页
  function renderCardsTab() {
    const sim = state.sim;
    if (!sim) {
      $("#pageCards").innerHTML =
        '<div class="empty-hint">尚未读取沙盘数据，无法生成检查卡。</div>';
      return;
    }
    const frozen = state.status === "done";
    let html =
      '<div class="form-section"><h3>逐杆停车检查卡' +
      (frozen ? "（已冻结）" : "（草稿预览，确认后冻结）") + "</h3>";
    html +=
      '<p style="color:var(--muted)">触发 ' + sim.trigger.toFixed(1) + "s ｜ 总控响应 " +
      sim.responseDelay + "s ｜ 全部停止 +" + sim.summary.allStopTime.toFixed(2) + "s</p>";
    for (const c of sim.cards) {
      const sel = state.selection.type === "batten" && state.selection.id === c.battenId;
      html +=
        '<div class="estop-card lv-' + c.level + (sel ? " selected" : "") +
        '" data-pick-batten="' + c.battenId + '">' +
        '<div class="hd"><b>' + esc(c.name) + "</b>" +
        (c.propName ? "<span>" + esc(c.propName) + "</span>" : "<span>空杆</span>") +
        '<i class="lv">' + (c.level === "danger" ? "高危" : c.level === "warn" ? "注意" : "正常") + "</i></div>" +
        '<div class="grid">' +
        "<span>触发时</span><b>" + (c.moving ? c.posAtTrigger.toFixed(2) + "m · " + c.velAtTrigger.toFixed(2) + "m/s" : "静止 " + c.posAtTrigger.toFixed(2) + "m") + "</b>" +
        "<span>制动延迟/减速度</span><b>" + c.brakeDelay.toFixed(1) + "s · " + c.decel.toFixed(1) + "m/s²</b>" +
        "<span>制动距离</span><b>" + c.brakeDist.toFixed(2) + "m</b>" +
        "<span>停止时刻</span><b>" + c.stopTime.toFixed(2) + "s（+" + c.stopAfter.toFixed(2) + "s）</b>" +
        "<span>最终高度</span><b>" + c.finalPos.toFixed(2) + "m（吊物底 " + c.finalLowest.toFixed(2) + "m）" +
        (c.limit === "low" ? ' <em class="bad">越下限位</em>' : c.limit === "high" ? ' <em class="bad">越上限位</em>' : "") + "</b>" +
        "</div>";
      if (c.messages.length)
        html +=
          '<ul class="warns">' +
          c.messages.map((m) => "<li>" + esc(m) + "</li>").join("") + "</ul>";
      html +=
        '<ul class="checklist">' +
        "<li>☐ 制动器已完全抱闸，无溜钩</li>" +
        "<li>☐ 限位开关未触发，行程余量正常</li>" +
        "<li>☐ 吊物与吊挂无松脱、无摆动</li>" +
        "<li>☐ 联动组各杆高度已复核</li>" +
        "</ul></div>";
    }
    html += "</div>";
    $("#pageCards").innerHTML = html;
    $$("#pageCards [data-pick-batten]").forEach((n) =>
      n.addEventListener("click", () => {
        state.selection = { type: "batten", id: n.dataset.pickBatten };
        render();
      })
    );
  }

  // ---------------------------------------------------------------- 回放/对照页
  function renderReplayTab() {
    const sim = state.sim;
    const t0 = state.drill.trigger;
    const t1 = sim ? Math.max(sim.stoppedAt + 1, t0 + 1) : t0 + 5;
    let html =
      '<div class="form-section"><h3>急停回放</h3>' +
      '<div class="btn-row"><button id="btnPlay"' + (sim ? "" : " disabled") + ">" +
      (state.playing ? "⏸ 暂停" : "▶ 播放") + "</button>" +
      '<button id="btnToTrigger"' + (sim ? "" : " disabled") + ">回到触发</button>" +
      '<select id="replaySpeed" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:2px 4px">' +
      '<option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></div>' +
      '<input type="range" id="replaySlider" min="' + Math.round(t0 * 10) + '" max="' +
      Math.round(t1 * 10) + '" value="' + Math.round(state.cursor * 10) +
      '" style="width:100%"' + (sim ? "" : " disabled") + ">" +
      '<p style="color:var(--muted)">回放范围：触发 ' + t0.toFixed(1) + "s – " + t1.toFixed(1) +
      "s；侧视图中实杆为急停推演位置，紫虚影为原计划位置。已确认的历史演练单同样可在此回放。</p></div>";

    html += '<div class="form-section"><h3>历史演练单</h3><div id="esHistoryList">';
    html += state.drillList.length
      ? state.drillList
          .map((d) => {
            const m = d.metrics || {};
            return (
              '<div class="history-item"><span class="nm">' + esc(d.name) +
              '<br><span class="ts">' + (ES.STATUS_LABEL[d.status] || d.status) +
              " ｜ 触发 " + (m.trigger != null ? m.trigger.toFixed(1) + "s" : "-") +
              " ｜ 高危 " + (m.high != null ? m.high : "-") +
              " ｜ 制动 " + (m.maxBrakeDist != null ? m.maxBrakeDist.toFixed(2) + "m" : "-") +
              " ｜ 全停 " + (m.allStopTime != null ? m.allStopTime.toFixed(2) + "s" : "-") +
              "</span></span>" +
              '<button class="tiny" data-open-drill="' + d.id + '">打开</button>' +
              '<button class="tiny" data-compare-drill="' + d.id + '">对照</button></div>'
            );
          })
          .join("")
      : '<div class="empty-hint">还没有已保存的演练单。</div>';
    html += "</div></div>";
    $("#pageReplay").innerHTML = html;

    const playBtn = $("#btnPlay");
    if (playBtn) playBtn.onclick = togglePlay;
    const toT = $("#btnToTrigger");
    if (toT)
      toT.onclick = () => {
        stopPlay();
        state.cursor = state.drill.trigger;
        renderViewsOnly();
        renderReplayTab();
      };
    const slider = $("#replaySlider");
    if (slider)
      slider.oninput = () => {
        stopPlay();
        state.cursor = parseInt(slider.value, 10) / 10;
        renderViewsOnly();
      };
    $$("[data-open-drill]").forEach((b) =>
      b.addEventListener("click", () => loadDrill(parseInt(b.dataset.openDrill, 10)))
    );
    $$("[data-compare-drill]").forEach((b) =>
      b.addEventListener("click", () => openCompare(parseInt(b.dataset.compareDrill, 10)))
    );
  }

  function togglePlay() {
    if (state.playing) {
      stopPlay();
      renderReplayTab();
      return;
    }
    const sim = state.sim;
    if (!sim) return;
    const t0 = state.drill.trigger;
    const t1 = Math.max(sim.stoppedAt + 1, t0 + 1);
    if (state.cursor >= t1 - 0.05 || state.cursor < t0) state.cursor = t0;
    state.playing = true;
    const wall0 = performance.now();
    const c0 = state.cursor;
    const loop = (now) => {
      if (!state.playing) return;
      const speed = parseFloat(($("#replaySpeed") || { value: "1" }).value) || 1;
      state.cursor = Math.min(c0 + ((now - wall0) / 1000) * speed, t1);
      renderViewsOnly();
      if (state.cursor >= t1) {
        state.playing = false;
        renderReplayTab();
        return;
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    renderReplayTab();
  }
  function stopPlay() {
    state.playing = false;
    cancelAnimationFrame(rafId);
  }

  // ---------------------------------------------------------------- 对照
  async function openCompare(otherId) {
    try {
      const other = await API.getEstopDrill(otherId);
      const cur = {
        name: $("#drillName").value || "当前演练单",
        metrics: ES.metrics(state.drill),
        data: state.drill,
      };
      const sheets = [cur, { name: other.name, metrics: other.metrics, data: other.data }];
      const rows = [
        ["trigger", "触发时刻 s"], ["high", "高危"], ["medium", "警告"],
        ["maxBrakeDist", "最大制动距离 m"], ["allStopTime", "全部停止用时 s"],
      ];
      let html =
        '<table class="cmp-table"><tr><th></th>' +
        sheets.map((s) => "<th>" + esc(s.name) + "</th>").join("") + "</tr>";
      for (const [k, label] of rows) {
        html += "<tr><td>" + label + "</td>" +
          sheets
            .map((s) => {
              const v = s.metrics ? s.metrics[k] : null;
              return "<td>" + (v == null ? "-" : typeof v === "number" ? v.toFixed(2) : v) + "</td>";
            })
            .join("") + "</tr>";
      }
      html += "</table>";
      // 逐杆最终高度对照
      html += '<h4 style="margin:10px 0 6px">各杆急停最终高度对照</h4>' +
        '<table class="cmp-table"><tr><th>吊杆</th>' +
        sheets.map((s) => "<th>" + esc(s.name) + "</th>").join("") + "</tr>";
      const cardSets = sheets.map((s) => {
        const sim = ES.simulate(ES.normalize(s.data));
        const m = {};
        if (sim) for (const c of sim.cards) m[c.name] = c;
        return m;
      });
      const names = new Set();
      cardSets.forEach((m) => Object.keys(m).forEach((n) => names.add(n)));
      for (const nm of names) {
        html += "<tr><td>" + esc(nm) + "</td>" +
          cardSets
            .map((m) => {
              const c = m[nm];
              return "<td>" + (c ? c.finalPos.toFixed(2) + "m ｜ 制动 " + c.brakeDist.toFixed(2) + "m" : "-") + "</td>";
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

  // ---------------------------------------------------------------- 编辑后处理
  function afterEdit(label) {
    render();
    scheduleSave();
  }

  function setTrigger(t) {
    if (!editable()) {
      toast("已确认冻结的演练单不可修改触发时刻", true);
      return;
    }
    const p = proj();
    const h = p ? E.horizon(p) : 999;
    state.drill.trigger = ES.clamp(Math.round(t * 10) / 10, 0, Math.max(0, h - 0.1));
    state.cursor = state.drill.trigger;
    afterEdit("修改触发时刻");
  }

  // 统一数据绑定（触发参数页）
  $(".tab-body").addEventListener("change", (e) => {
    const node = e.target;
    const bind = node.dataset && node.dataset.bind;
    if (!bind || !editable()) return;
    const [root, key] = bind.split(".");
    if (root === "param") {
      if (key === "trigger") setTrigger(parseFloat(node.value) || 0);
      else {
        state.drill.params[key] = parseFloat(node.value) || 0;
        afterEdit("修改参数");
      }
    }
  });

  // ---------------------------------------------------------------- 视图回调
  ESStage.init($("#esStageSvg"), {
    onSelectBatten(id) {
      state.selection = { type: "batten", id };
      render();
    },
  });
  ESChart.init($("#esChartSvg"), $("#esChartScroll"), {
    onTrigger(t) {
      setTrigger(t);
    },
    onSeek(t) {
      stopPlay();
      state.cursor = t;
      renderViewsOnly();
      const slider = $("#replaySlider");
      if (slider) slider.value = String(Math.round(t * 10));
    },
    onSelectBatten(id) {
      state.selection = { type: "batten", id };
      render();
    },
    onSelectWarning(w) {
      jumpToWarning(w);
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
  $("#drillName").addEventListener("input", scheduleSave);
  $("#triggerNum").addEventListener("change", (e) => setTrigger(parseFloat(e.target.value) || 0));
  $("#respDelay").addEventListener("change", (e) => {
    if (!editable()) return;
    state.drill.params.responseDelay = Math.max(0, parseFloat(e.target.value) || 0);
    afterEdit("修改总控响应延迟");
  });
  $("#btnScan").onclick = runScan;
  $("#btnRecapture").onclick = async () => {
    if (!state.drill.projectId) return;
    await captureSource(state.drill.projectId, state.drill.versionId);
    render();
  };
  $("#drillSelect").addEventListener("change", async (e) => {
    stopPlay();
    if (e.target.value === "") {
      state.drillId = null;
      state.drill = demoDrill();
      state.status = "draft";
      $("#drillName").value = state.drill.name;
      state.selection = { type: null, id: null };
      state.scanResults = null;
      state.stale = false;
      state.cursor = state.drill.trigger;
      render();
    } else {
      await loadDrill(parseInt(e.target.value, 10));
    }
  });
  $("#btnDelete").onclick = async () => {
    if (state.drillId == null) {
      toast("内存草稿无需删除", true);
      return;
    }
    if (!confirm("确定删除演练单「" + $("#drillName").value + "」？此操作不可恢复。")) return;
    await API.deleteEstopDrill(state.drillId);
    state.drillId = null;
    await refreshDrillList();
    if (state.drillList.length) await loadDrill(state.drillList[0].id);
    else {
      state.drill = demoDrill();
      state.status = "draft";
      $("#drillName").value = state.drill.name;
      state.cursor = state.drill.trigger;
      render();
    }
    toast("已删除");
  };

  // ---------------------------------------------------------------- 新建
  function demoDrill() {
    const d = ES.newDrill("演示：一幕换景急停演练");
    const s = E.stageDefaults();
    Object.assign(s, { totalTime: 60, passageY: 2.5 });
    const p = { stage: s, battens: [], cues: [], occupancies: [] };
    const b1 = E.newBatten(2.0, 1);
    b1.id = "b1"; b1.name = "台口幕杆";
    Object.assign(b1, { length: 2.5, maxLoad: 250, lowLimit: 0.2, highLimit: 11, initialPos: 10.5 });
    b1.prop = Object.assign(E.newProp("curtain"), {
      id: "p1", name: "丝绒大幕", width: 2.5, height: 7.5, weight: 120, clearance: 0.3,
    });
    const b2 = E.newBatten(4.5, 2);
    b2.id = "b2"; b2.name = "布景杆 A";
    Object.assign(b2, { length: 6, maxLoad: 200, lowLimit: 0.3, highLimit: 11, initialPos: 10.5 });
    b2.prop = Object.assign(E.newProp("scenery"), {
      id: "p2", name: "城堡景片", width: 6, height: 4, weight: 150, clearance: 0.4,
    });
    const b3 = E.newBatten(11.0, 3);
    b3.id = "b3"; b3.name = "灯杆 B";
    Object.assign(b3, { length: 5, maxLoad: 120, lowLimit: 0.3, highLimit: 11.2, initialPos: 10.8 });
    b3.prop = Object.assign(E.newProp("light"), {
      id: "p3", name: "顶灯排", width: 5, height: 0.8, weight: 80, clearance: 0.3,
    });
    p.battens.push(b1, b2, b3);
    p.occupancies.push(E.newOcc({ id: "o1", name: "演员抢装通行", start: 4, duration: 12, x: 1.5, width: 7.5 }));
    p.cues.push(E.newCue({ id: "c1", battenId: "b1", name: "大幕下落", start: 0, duration: 9, fromPos: 10.5, toPos: 3, linkGroup: "幕组" }));
    p.cues.push(E.newCue({ id: "c2", battenId: "b3", name: "灯排联动", start: 0, duration: 7.8, fromPos: 10.8, toPos: 8.2, linkGroup: "幕组" }));
    p.cues.push(E.newCue({ id: "c3", battenId: "b2", name: "景片降落", start: 4, duration: 12, fromPos: 10.5, toPos: 0.2 }));
    p.cues.push(E.newCue({ id: "c4", battenId: "b2", name: "景片归位", start: 30, duration: 12, fromPos: 0.2, toPos: 10.5 }));
    d.project = E.normalizeProject(p);
    d.projectName = "演示沙盘（内置）";
    d.versionLabel = "内置演示数据";
    d.trigger = 5;
    d.params.responseDelay = 0.4;
    d.brakes = {
      b1: { delay: 0.2, decel: 1.0 },
      b2: { delay: 0.3, decel: 0.8 },
      b3: { delay: 0.6, decel: 1.5 },
    };
    d.fingerprint = ES.fingerprint(d.project);
    return ES.normalize(d);
  }

  $("#btnNewDrill").onclick = async () => {
    $("#newDrillName").value = "未命名演练单";
    const sel = $("#newDrillProject");
    sel.innerHTML =
      '<option value="">（不引用）</option>' +
      state.projects.map((p) => '<option value="' + p.id + '">' + esc(p.name) + "</option>").join("");
    await fillNewVersionSelect();
    $("#modalNew").classList.add("show");
  };
  $("#newDrillProject").addEventListener("change", fillNewVersionSelect);
  async function fillNewVersionSelect() {
    const pid = $("#newDrillProject").value;
    const sel = $("#newDrillVersion");
    let opts = '<option value="">（项目当前数据）</option>';
    if (pid) {
      try {
        const list = await API.listVersions(parseInt(pid, 10));
        opts += list.map((v) => '<option value="' + v.id + '">' + esc(v.label) + "</option>").join("");
      } catch (_) {}
    }
    sel.innerHTML = opts;
  }
  $("#btnConfirmNew").onclick = async () => {
    const name = $("#newDrillName").value.trim() || "未命名演练单";
    const tpl = $("#newDrillTpl").value;
    const pid = $("#newDrillProject").value ? parseInt($("#newDrillProject").value, 10) : null;
    const vid = $("#newDrillVersion").value ? parseInt($("#newDrillVersion").value, 10) : null;
    $("#modalNew").classList.remove("show");
    let data = tpl === "demo" ? demoDrill() : ES.newDrill(name);
    data.name = name;
    try {
      if (tpl !== "demo" && pid) {
        // 空白单：先读取来源版本再创建
        let src, label, projName = "";
        if (vid) {
          const v = await API.getVersion(vid);
          src = v.data;
          label = v.label;
          const pj = state.projects.find((p) => p.id === pid);
          projName = pj ? pj.name : "";
        } else {
          const r = await API.getProject(pid);
          src = r.data;
          label = "当前数据";
          projName = r.name;
        }
        data.project = E.normalizeProject(src);
        data.projectId = pid;
        data.projectName = projName;
        data.versionId = vid;
        data.versionLabel = label;
        data.fingerprint = ES.fingerprint(data.project);
      }
      const r = await API.createEstopDrill(name, data.projectId, data.versionId, data, ES.metrics(data));
      state.drillId = r.id;
      state.status = "draft";
      state.drill = ES.normalize(data);
      $("#drillName").value = name;
      state.selection = { type: null, id: null };
      state.scanResults = null;
      state.stale = false;
      state.cursor = state.drill.trigger;
      await refreshDrillList(r.id);
      render();
      toast("已创建演练单：" + name);
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
    if (e.code === "Space" && state.sim) {
      e.preventDefault();
      togglePlay();
    }
  });

  // ---------------------------------------------------------------- 启动
  async function boot() {
    try {
      state.projects = await API.listProjects();
    } catch (e) {
      toast("后端不可用，请先启动 app.py", true);
    }
    try {
      await refreshDrillList();
      if (state.drillList.length) {
        await loadDrill(state.drillList[0].id);
        return;
      }
    } catch (e) {
      toast("载入演练单失败：" + e.message, true);
    }
    // 无已存单据：内存演示
    state.drill = demoDrill();
    state.status = "draft";
    $("#drillName").value = state.drill.name;
    state.cursor = state.drill.trigger;
    render();
  }
  boot();
})();
