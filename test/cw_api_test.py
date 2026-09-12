# -*- coding: utf-8 -*-
"""配重换装单 API 状态机测试：python3 test/cw_api_test.py"""
import json
import os
import sys
import tempfile

os.environ["SANDBOX_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import app  # noqa: E402

c = app.test_client()
passed = failed = 0


def ok(cond, msg):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print("  ✗ " + msg)


def sheet_data():
    return {
        "scene": "一幕→二幕",
        "projectId": None,
        "projectName": "",
        "params": {
            "stationCount": 2, "maxImbalance": 25, "loadingPos": 1.0,
            "posTolerance": 0.05, "bricksPerStep": 2, "stepBase": 15,
            "stepPerBrick": 6, "reviewSeconds": 20, "testSeconds": 30,
        },
        "bricks": [{"id": "bk1", "name": "铁砖", "weight": 25, "count": 20}],
        "lines": [{
            "id": "L1", "name": "1号杆", "battenId": "", "cueId": "",
            "pipeWeight": 40, "propName": "幕", "propWeight": 110,
            "propLocked": False, "arborCapacity": 300, "brickId": "bk1",
            "initialBricks": 2, "targetBricks": None, "bricksLocked": False,
            "braked": True, "arborPos": 1.0,
        }],
        "steps": [
            {"id": "s1", "kind": "add", "lineId": "L1", "count": 2, "station": 1,
             "start": 0, "duration": 27, "status": "pending", "auto": True},
            {"id": "s2", "kind": "add", "lineId": "L1", "count": 2, "station": 1,
             "start": 27, "duration": 27, "status": "pending", "auto": True},
            {"id": "s3", "kind": "review", "lineId": "L1", "count": 1, "station": 1,
             "start": 54, "duration": 20, "status": "pending", "auto": True},
        ],
    }


# 创建
r = c.post("/api/cw/sheets", json={"name": "测试单", "scene": "一幕", "data": sheet_data()})
ok(r.status_code == 200, "创建换装单")
sid = r.get_json()["id"]

r = c.get("/api/cw/sheets/%d" % sid)
ok(r.get_json()["status"] == "draft", "初始为草稿")

# 非法流转：draft → running / done
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "running"})
ok(r.status_code == 409, "草稿不可直接执行（%s）" % r.status_code)
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "done"})
ok(r.status_code == 409, "草稿不可直接完成")

# draft → checked
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "checked"})
ok(r.status_code == 200 and r.get_json()["status"] == "checked", "草稿→已核对")

# checked 下内容不可改
d = sheet_data()
d["lines"][0]["propWeight"] = 999
r = c.put("/api/cw/sheets/%d" % sid, json={"data": d})
ok(r.status_code == 409, "已核对状态拒绝内容修改")

# checked → running
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "running"})
ok(r.status_code == 200, "已核对→执行中")

# 顺序确认：confirm 应确认 s1（最早）
r = c.post("/api/cw/sheets/%d/confirm" % sid)
j = r.get_json()
ok(r.status_code == 200 and j["stepId"] == "s1", "确认最早步骤 s1")
steps = {s["id"]: s for s in j["data"]["steps"]}
ok(steps["s1"]["status"] == "done" and steps["s1"].get("doneAt"), "s1 标记完成且带时间戳")

# 执行中改写已完成步骤 → 拒绝
import copy
d2 = copy.deepcopy(j["data"])
for s in d2["steps"]:
    if s["id"] == "s1":
        s["count"] = 99
r = c.put("/api/cw/sheets/%d" % sid, json={"data": d2})
ok(r.status_code == 409, "执行中改写已完成步骤被拒绝")

# 执行中删除已完成步骤 → 拒绝
d3 = copy.deepcopy(j["data"])
d3["steps"] = [s for s in d3["steps"] if s["id"] != "s1"]
r = c.put("/api/cw/sheets/%d" % sid, json={"data": d3})
ok(r.status_code == 409, "执行中删除已完成步骤被拒绝")

# 执行中临时变更吊物（保留已完成步骤）→ 允许，并重排未完成
d4 = copy.deepcopy(j["data"])
d4["lines"][0]["propWeight"] = 160
d4["steps"] = [s for s in d4["steps"] if s["status"] == "done"] + [
    {"id": "s2b", "kind": "add", "lineId": "L1", "count": 2, "station": 1,
     "start": 27, "duration": 27, "status": "pending", "auto": True},
    {"id": "s3b", "kind": "add", "lineId": "L1", "count": 2, "station": 1,
     "start": 54, "duration": 27, "status": "pending", "auto": True},
    {"id": "s4b", "kind": "add", "lineId": "L1", "count": 2, "station": 1,
     "start": 81, "duration": 27, "status": "pending", "auto": True},
    {"id": "s5b", "kind": "review", "lineId": "L1", "count": 1, "station": 1,
     "start": 108, "duration": 20, "status": "pending", "auto": True},
]
r = c.put("/api/cw/sheets/%d" % sid, json={"data": d4})
ok(r.status_code == 200, "执行中临时变更吊物+重排未完成步骤被允许")

# 撤回：应撤回 s1（唯一已完成）
r = c.post("/api/cw/sheets/%d/undo" % sid)
j = r.get_json()
ok(r.status_code == 200 and j["stepId"] == "s1", "撤回最近确认的步骤 s1")
steps = {s["id"]: s for s in j["data"]["steps"]}
ok(steps["s1"]["status"] == "pending" and not steps["s1"].get("doneAt"), "s1 回到待执行")

# 未全部完成不可归档
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "done"})
ok(r.status_code == 409, "有未执行步骤时不可归档完成")

# 依次确认全部步骤 → 归档
for _ in range(5):
    r = c.post("/api/cw/sheets/%d/confirm" % sid)
    ok(r.status_code == 200, "顺序确认步骤")
r = c.post("/api/cw/sheets/%d/confirm" % sid)
ok(r.status_code == 409, "无待执行步骤时确认报错")
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "done"})
ok(r.status_code == 200, "全部完成后归档")

# 完成后不可改写
r = c.put("/api/cw/sheets/%d" % sid, json={"data": sheet_data()})
ok(r.status_code == 409, "完成后拒绝内容修改")
r = c.put("/api/cw/sheets/%d" % sid, json={"status": "draft"})
ok(r.status_code == 409, "完成后拒绝状态回退")
r = c.post("/api/cw/sheets/%d/confirm" % sid)
ok(r.status_code == 409, "完成后不可再确认步骤")

# 列表与删除
r = c.get("/api/cw/sheets")
ok(any(s["id"] == sid and s["status"] == "done" for s in r.get_json()), "列表可见已完成单据")
r = c.delete("/api/cw/sheets/%d" % sid)
ok(r.status_code == 200, "删除换装单")

print("\n通过 %d，失败 %d" % (passed, failed))
sys.exit(1 if failed else 0)
