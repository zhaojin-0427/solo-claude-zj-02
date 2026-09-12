# -*- coding: utf-8 -*-
"""舞台吊杆换景沙盘 —— 离线 Flask 后端。

仅依赖 Flask 标准库，数据保存在本地 SQLite（instance/sandbox.db）。
前端为原生 HTML/CSS/JS + SVG，不访问任何在线服务。
"""
import json
import os
import sqlite3
import time

from flask import Flask, g, jsonify, render_template, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get(
    "SANDBOX_DB", os.path.join(BASE_DIR, "instance", "sandbox.db")
)

app = Flask(__name__, template_folder="templates", static_folder="static")


# --------------------------------------------------------------------------
# 数据库
# --------------------------------------------------------------------------
def get_db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            data_json   TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS versions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            label       TEXT NOT NULL,
            data_json   TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rehearsals (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            data_json    TEXT NOT NULL,
            metrics_json TEXT NOT NULL,
            created_at   INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cw_sheets (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT NOT NULL,
            scene        TEXT NOT NULL DEFAULT '',
            status       TEXT NOT NULL DEFAULT 'draft',
            project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            data_json    TEXT NOT NULL,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def row_to_project(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "data": json.loads(row["data_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# --------------------------------------------------------------------------
# 页面
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/cw")
def counterweight():
    return render_template("counterweight.html")


# --------------------------------------------------------------------------
# 项目
# --------------------------------------------------------------------------
@app.get("/api/projects")
def list_projects():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC"
    ).fetchall()
    return jsonify(
        [{"id": r["id"], "name": r["name"], "updatedAt": r["updated_at"]} for r in rows]
    )


@app.post("/api/projects")
def create_project():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "未命名剧目").strip()[:80]
    data = body.get("data") or {}
    now = int(time.time() * 1000)
    db = get_db()
    cur = db.execute(
        "INSERT INTO projects (name, data_json, created_at, updated_at) VALUES (?,?,?,?)",
        (name, json.dumps(data, ensure_ascii=False), now, now),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "data": data})


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    db = get_db()
    row = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if row is None:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify(row_to_project(row))


@app.put("/api/projects/<int:pid>")
def update_project(pid):
    body = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if row is None:
        return jsonify({"error": "项目不存在"}), 404
    name = (body.get("name") or row["name"])[:80]
    data = body.get("data", json.loads(row["data_json"]))
    now = int(time.time() * 1000)
    db.execute(
        "UPDATE projects SET name=?, data_json=?, updated_at=? WHERE id=?",
        (name, json.dumps(data, ensure_ascii=False), now, pid),
    )
    db.commit()
    return jsonify({"ok": True, "updatedAt": now})


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    db = get_db()
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# 版本快照
# --------------------------------------------------------------------------
@app.get("/api/projects/<int:pid>/versions")
def list_versions(pid):
    db = get_db()
    rows = db.execute(
        "SELECT id, label, created_at FROM versions WHERE project_id=? ORDER BY created_at DESC",
        (pid,),
    ).fetchall()
    return jsonify(
        [{"id": r["id"], "label": r["label"], "createdAt": r["created_at"]} for r in rows]
    )


@app.post("/api/projects/<int:pid>/versions")
def create_version(pid):
    body = request.get_json(force=True) or {}
    label = (body.get("label") or "快照")[:80]
    data = body.get("data") or {}
    now = int(time.time() * 1000)
    db = get_db()
    cur = db.execute(
        "INSERT INTO versions (project_id, label, data_json, created_at) VALUES (?,?,?,?)",
        (pid, label, json.dumps(data, ensure_ascii=False), now),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "label": label, "createdAt": now})


@app.get("/api/versions/<int:vid>")
def get_version(vid):
    db = get_db()
    row = db.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if row is None:
        return jsonify({"error": "版本不存在"}), 404
    return jsonify(
        {"id": row["id"], "label": row["label"], "data": json.loads(row["data_json"]),
         "createdAt": row["created_at"]}
    )


@app.delete("/api/versions/<int:vid>")
def delete_version(vid):
    db = get_db()
    db.execute("DELETE FROM versions WHERE id=?", (vid,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# 演练结果
# --------------------------------------------------------------------------
@app.get("/api/projects/<int:pid>/rehearsals")
def list_rehearsals(pid):
    db = get_db()
    rows = db.execute(
        "SELECT id, name, metrics_json, created_at FROM rehearsals "
        "WHERE project_id=? ORDER BY created_at DESC",
        (pid,),
    ).fetchall()
    return jsonify(
        [
            {"id": r["id"], "name": r["name"], "metrics": json.loads(r["metrics_json"]),
             "createdAt": r["created_at"]}
            for r in rows
        ]
    )


@app.post("/api/projects/<int:pid>/rehearsals")
def create_rehearsal(pid):
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "演练")[:80]
    data = body.get("data") or {}
    metrics = body.get("metrics") or {}
    now = int(time.time() * 1000)
    db = get_db()
    cur = db.execute(
        "INSERT INTO rehearsals (project_id, name, data_json, metrics_json, created_at) "
        "VALUES (?,?,?,?,?)",
        (pid, name, json.dumps(data, ensure_ascii=False),
         json.dumps(metrics, ensure_ascii=False), now),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "metrics": metrics, "createdAt": now})


@app.get("/api/rehearsals/<int:rid>")
def get_rehearsal(rid):
    db = get_db()
    row = db.execute("SELECT * FROM rehearsals WHERE id=?", (rid,)).fetchone()
    if row is None:
        return jsonify({"error": "演练不存在"}), 404
    return jsonify(
        {"id": row["id"], "name": row["name"], "data": json.loads(row["data_json"]),
         "metrics": json.loads(row["metrics_json"]), "createdAt": row["created_at"]}
    )


@app.delete("/api/rehearsals/<int:rid>")
def delete_rehearsal(rid):
    db = get_db()
    db.execute("DELETE FROM rehearsals WHERE id=?", (rid,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------
# 配重换装单
# --------------------------------------------------------------------------
CW_STATUS = ("draft", "checked", "running", "done")
# 允许的状态流转：草稿↔已核对→执行中→完成；完成为终态
CW_TRANSITIONS = {
    "draft": {"checked"},
    "checked": {"draft", "running"},
    "running": {"checked", "done"},
    "done": set(),
}


def row_to_sheet(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "scene": row["scene"],
        "status": row["status"],
        "projectId": row["project_id"],
        "data": json.loads(row["data_json"]),
        "metrics": json.loads(row["metrics_json"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def get_sheet_row(db, sid):
    return db.execute("SELECT * FROM cw_sheets WHERE id=?", (sid,)).fetchone()


def canon(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def done_steps_intact(old_data, new_data):
    """执行中：已完成步骤（含其确认时间）不得被改写或删除。"""
    new_by_id = {s.get("id"): s for s in (new_data.get("steps") or [])}
    for s in old_data.get("steps") or []:
        if s.get("status") != "done":
            continue
        n = new_by_id.get(s.get("id"))
        if n is None or n.get("status") != "done":
            return False
        for k in ("kind", "lineId", "count", "station", "start", "duration", "doneAt"):
            if n.get(k) != s.get(k):
                return False
    return True


@app.get("/api/cw/sheets")
def list_cw_sheets():
    db = get_db()
    rows = db.execute(
        "SELECT id, name, scene, status, project_id, metrics_json, updated_at "
        "FROM cw_sheets ORDER BY updated_at DESC"
    ).fetchall()
    return jsonify(
        [
            {
                "id": r["id"],
                "name": r["name"],
                "scene": r["scene"],
                "status": r["status"],
                "projectId": r["project_id"],
                "metrics": json.loads(r["metrics_json"]),
                "updatedAt": r["updated_at"],
            }
            for r in rows
        ]
    )


@app.post("/api/cw/sheets")
def create_cw_sheet():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "未命名换装单").strip()[:80]
    scene = (body.get("scene") or "").strip()[:80]
    data = body.get("data") or {}
    metrics = body.get("metrics") or {}
    project_id = body.get("projectId")
    now = int(time.time() * 1000)
    db = get_db()
    cur = db.execute(
        "INSERT INTO cw_sheets (name, scene, status, project_id, data_json, "
        "metrics_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
        (
            name,
            scene,
            "draft",
            project_id,
            json.dumps(data, ensure_ascii=False),
            json.dumps(metrics, ensure_ascii=False),
            now,
            now,
        ),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "status": "draft"})


@app.get("/api/cw/sheets/<int:sid>")
def get_cw_sheet(sid):
    db = get_db()
    row = get_sheet_row(db, sid)
    if row is None:
        return jsonify({"error": "换装单不存在"}), 404
    return jsonify(row_to_sheet(row))


@app.put("/api/cw/sheets/<int:sid>")
def update_cw_sheet(sid):
    body = request.get_json(force=True) or {}
    db = get_db()
    row = get_sheet_row(db, sid)
    if row is None:
        return jsonify({"error": "换装单不存在"}), 404
    cur_status = row["status"]
    if cur_status == "done":
        return jsonify({"error": "换装单已完成归档，不可改写"}), 409

    old_data = json.loads(row["data_json"])
    new_status = body.get("status") or cur_status
    if new_status not in CW_STATUS:
        return jsonify({"error": "未知状态：" + str(new_status)}), 400
    if new_status != cur_status and new_status not in CW_TRANSITIONS[cur_status]:
        return jsonify(
            {"error": "不允许从「%s」直接流转到「%s」" % (cur_status, new_status)}
        ), 409

    new_data = body.get("data", old_data)
    data_changed = "data" in body and canon(new_data) != canon(old_data)

    if data_changed and cur_status == "checked":
        return jsonify({"error": "已核对状态下不可修改内容，请先退回草稿"}), 409
    if data_changed and cur_status == "running" and not done_steps_intact(old_data, new_data):
        return jsonify({"error": "执行中不可改写或删除已完成步骤"}), 409

    if new_status == "done":
        steps = (new_data.get("steps") or []) if isinstance(new_data, dict) else []
        if any(s.get("status") != "done" for s in steps):
            return jsonify({"error": "仍有未执行的步骤，不能归档完成"}), 409

    name = (body.get("name") or row["name"])[:80]
    scene = (body.get("scene", row["scene"]) or "")[:80]
    metrics = body.get("metrics", json.loads(row["metrics_json"]))
    project_id = body.get("projectId", row["project_id"])
    now = int(time.time() * 1000)
    db.execute(
        "UPDATE cw_sheets SET name=?, scene=?, status=?, project_id=?, data_json=?, "
        "metrics_json=?, updated_at=? WHERE id=?",
        (
            name,
            scene,
            new_status,
            project_id,
            json.dumps(new_data, ensure_ascii=False),
            json.dumps(metrics, ensure_ascii=False),
            now,
            sid,
        ),
    )
    db.commit()
    return jsonify({"ok": True, "status": new_status, "updatedAt": now})


@app.delete("/api/cw/sheets/<int:sid>")
def delete_cw_sheet(sid):
    db = get_db()
    db.execute("DELETE FROM cw_sheets WHERE id=?", (sid,))
    db.commit()
    return jsonify({"ok": True})


def _step_order_key(step):
    return (float(step.get("start") or 0),)


@app.post("/api/cw/sheets/<int:sid>/confirm")
def confirm_cw_step(sid):
    """执行中顺序确认：只允许确认时间轴上最早的一个待执行步骤。"""
    db = get_db()
    row = get_sheet_row(db, sid)
    if row is None:
        return jsonify({"error": "换装单不存在"}), 404
    if row["status"] != "running":
        return jsonify({"error": "仅执行中的换装单可确认步骤"}), 409
    data = json.loads(row["data_json"])
    steps = data.get("steps") or []
    pending = [s for s in steps if s.get("status") != "done"]
    if not pending:
        return jsonify({"error": "没有待执行的步骤"}), 409
    nxt = min(pending, key=_step_order_key)
    nxt["status"] = "done"
    nxt["doneAt"] = int(time.time() * 1000)
    now = int(time.time() * 1000)
    db.execute(
        "UPDATE cw_sheets SET data_json=?, updated_at=? WHERE id=?",
        (json.dumps(data, ensure_ascii=False), now, sid),
    )
    db.commit()
    return jsonify({"ok": True, "stepId": nxt.get("id"), "data": data})


@app.post("/api/cw/sheets/<int:sid>/undo")
def undo_cw_step(sid):
    """执行中撤回：只允许撤回最近一次确认的步骤。"""
    db = get_db()
    row = get_sheet_row(db, sid)
    if row is None:
        return jsonify({"error": "换装单不存在"}), 404
    if row["status"] != "running":
        return jsonify({"error": "仅执行中的换装单可撤回步骤"}), 409
    data = json.loads(row["data_json"])
    steps = data.get("steps") or []
    done = [s for s in steps if s.get("status") == "done"]
    if not done:
        return jsonify({"error": "没有可撤回的步骤"}), 409
    last = max(done, key=lambda s: float(s.get("doneAt") or 0))
    last["status"] = "pending"
    last.pop("doneAt", None)
    now = int(time.time() * 1000)
    db.execute(
        "UPDATE cw_sheets SET data_json=?, updated_at=? WHERE id=?",
        (json.dumps(data, ensure_ascii=False), now, sid),
    )
    db.commit()
    return jsonify({"ok": True, "stepId": last.get("id"), "data": data})


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
