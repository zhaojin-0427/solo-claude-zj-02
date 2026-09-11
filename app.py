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


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
