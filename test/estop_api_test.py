# -*- coding: utf-8 -*-
"""紧急停车演练单 API 状态机测试：python3 test/estop_api_test.py"""
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


def drill_data():
    return {
        "name": "测试演练单",
        "projectId": None,
        "projectName": "测试剧目",
        "versionId": None,
        "versionLabel": "当前数据",
        "fingerprint": "abc123",
        "project": {
            "stage": {"depth": 14, "height": 12, "passageY": 2.5, "totalTime": 60},
            "battens": [{
                "id": "b1", "name": "1号杆", "x": 3, "length": 6, "maxLoad": 200,
                "vmax": 1.2, "amax": 0.5, "lowLimit": 0.3, "highLimit": 11,
                "initialPos": 10.5, "prop": None,
            }],
            "cues": [{
                "id": "c1", "battenId": "b1", "name": "降", "start": 0,
                "duration": 8, "fromPos": 10.5, "toPos": 3, "linkGroup": "",
                "locked": False, "dwell": False,
            }],
            "occupancies": [],
        },
        "trigger": 4.0,
        "params": {"responseDelay": 0.4, "brakeDelay": 0.3, "decel": 1.2},
        "brakes": {"b1": {"delay": 0.2, "decel": 1.0}},
        "snapshot": None,
    }


# 创建
r = c.post("/api/estop/drills", json={
    "name": "急停演练A", "projectId": None, "versionId": None,
    "data": drill_data(), "metrics": {"trigger": 4.0, "high": 1},
})
ok(r.status_code == 200, "创建演练单")
did = r.get_json()["id"]

r = c.get("/api/estop/drills/%d" % did)
ok(r.status_code == 200 and r.get_json()["status"] == "draft", "初始为草稿")
ok(r.get_json()["data"]["trigger"] == 4.0, "触发时刻已保存")

# 草稿可改数据
d = drill_data()
d["trigger"] = 6.5
r = c.put("/api/estop/drills/%d" % did, json={"data": d})
ok(r.status_code == 200, "草稿可修改触发时刻")
r = c.get("/api/estop/drills/%d" % did)
ok(r.get_json()["data"]["trigger"] == 6.5, "修改已生效")

# 非法状态
r = c.put("/api/estop/drills/%d" % did, json={"status": "running"})
ok(r.status_code == 400, "未知状态被拒绝（%s）" % r.status_code)

# 无沙盘数据不可确认
r = c.post("/api/estop/drills", json={"name": "空单", "data": {"name": "空单"}})
empty_id = r.get_json()["id"]
r = c.put("/api/estop/drills/%d" % empty_id, json={"status": "done"})
ok(r.status_code == 400, "缺少沙盘数据不能确认冻结")

# 确认冻结：服务端写入输入快照
r = c.put("/api/estop/drills/%d" % did, json={"status": "done"})
ok(r.status_code == 200 and r.get_json()["status"] == "done", "草稿→已确认")
r = c.get("/api/estop/drills/%d" % did)
j = r.get_json()
snap = j["data"].get("snapshot") or {}
ok(snap.get("trigger") == 6.5, "冻结快照记录触发时刻")
ok(snap.get("frozenAt"), "冻结快照记录时间戳")
ok(snap.get("fingerprint") == "abc123", "冻结快照记录来源指纹")
ok((snap.get("brakes") or {}).get("b1", {}).get("decel") == 1.0, "冻结快照记录各杆制动参数")

# 已确认：数据与状态均不可改写
r = c.put("/api/estop/drills/%d" % did, json={"data": drill_data()})
ok(r.status_code == 409, "已确认拒绝数据改写")
r = c.put("/api/estop/drills/%d" % did, json={"status": "draft"})
ok(r.status_code == 409, "已确认拒绝状态回退")
r = c.put("/api/estop/drills/%d" % did, json={"metrics": {"high": 0}})
ok(r.status_code == 409, "已确认拒绝指标改写")

# 列表与指标
r = c.get("/api/estop/drills")
lst = r.get_json()
ok(any(x["id"] == did and x["status"] == "done" for x in lst), "列表可见已确认演练单")
ok(any(x["id"] == did and x["metrics"].get("trigger") == 4.0 for x in lst), "列表携带指标")

# 删除
r = c.delete("/api/estop/drills/%d" % did)
ok(r.status_code == 200, "删除演练单")
r = c.get("/api/estop/drills/%d" % did)
ok(r.status_code == 404, "删除后不可读取")
r = c.delete("/api/estop/drills/%d" % empty_id)
ok(r.status_code == 200, "删除空单")

print("\n通过 %d，失败 %d" % (passed, failed))
sys.exit(1 if failed else 0)
