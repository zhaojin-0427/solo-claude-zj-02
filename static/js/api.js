/* api.js —— 本地后端 REST 封装（全部走 127.0.0.1，无外部服务） */
(function (global) {
  "use strict";
  async function req(url, opts) {
    const r = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || ("请求失败 " + r.status));
    return body;
  }
  global.API = {
    listProjects: () => req("/api/projects"),
    createProject: (name, data) =>
      req("/api/projects", { method: "POST", body: JSON.stringify({ name, data }) }),
    getProject: (id) => req("/api/projects/" + id),
    saveProject: (id, name, data) =>
      req("/api/projects/" + id, { method: "PUT", body: JSON.stringify({ name, data }) }),
    deleteProject: (id) => req("/api/projects/" + id, { method: "DELETE" }),

    listVersions: (pid) => req("/api/projects/" + pid + "/versions"),
    saveVersion: (pid, label, data) =>
      req("/api/projects/" + pid + "/versions", {
        method: "POST",
        body: JSON.stringify({ label, data }),
      }),
    getVersion: (vid) => req("/api/versions/" + vid),
    deleteVersion: (vid) => req("/api/versions/" + vid, { method: "DELETE" }),

    listRehearsals: (pid) => req("/api/projects/" + pid + "/rehearsals"),
    saveRehearsal: (pid, name, data, metrics) =>
      req("/api/projects/" + pid + "/rehearsals", {
        method: "POST",
        body: JSON.stringify({ name, data, metrics }),
      }),
    getRehearsal: (rid) => req("/api/rehearsals/" + rid),
    deleteRehearsal: (rid) => req("/api/rehearsals/" + rid, { method: "DELETE" }),

    // ---- 配重换装单 ----
    listCwSheets: () => req("/api/cw/sheets"),
    createCwSheet: (name, scene, projectId, data, metrics) =>
      req("/api/cw/sheets", {
        method: "POST",
        body: JSON.stringify({ name, scene, projectId, data, metrics }),
      }),
    getCwSheet: (id) => req("/api/cw/sheets/" + id),
    saveCwSheet: (id, payload) =>
      req("/api/cw/sheets/" + id, { method: "PUT", body: JSON.stringify(payload) }),
    deleteCwSheet: (id) => req("/api/cw/sheets/" + id, { method: "DELETE" }),
    confirmCwStep: (id) => req("/api/cw/sheets/" + id + "/confirm", { method: "POST" }),
    undoCwStep: (id) => req("/api/cw/sheets/" + id + "/undo", { method: "POST" }),

    // ---- 紧急停车演练单 ----
    listEstopDrills: () => req("/api/estop/drills"),
    createEstopDrill: (name, projectId, versionId, data, metrics) =>
      req("/api/estop/drills", {
        method: "POST",
        body: JSON.stringify({ name, projectId, versionId, data, metrics }),
      }),
    getEstopDrill: (id) => req("/api/estop/drills/" + id),
    saveEstopDrill: (id, payload) =>
      req("/api/estop/drills/" + id, { method: "PUT", body: JSON.stringify(payload) }),
    deleteEstopDrill: (id) => req("/api/estop/drills/" + id, { method: "DELETE" }),
  };
})(window);
