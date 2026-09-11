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
  };
})(window);
