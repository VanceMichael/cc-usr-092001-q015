import assert from "node:assert/strict";
import test from "node:test";

import { ingestSignal } from "../src/ingest.js";
import {
  mailbox,
  pumpOutbox,
  readEvent,
  recordReview,
  ServiceError,
} from "../src/cases.js";
import { fieldsForRole, projectEvent } from "../src/projection.js";
import { sha256Canonical } from "../src/util.js";
import { FEATURES, freshDb, setupWorld, signal } from "./helpers.js";

function ingestAndPump(db, over) {
  const r = ingestSignal(db, signal(over));
  pumpOutbox(db);
  return r;
}

test("L1 只通知学生本人（自我提醒）", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestAndPump(db, { subjectRef: "S_CHILD", features: FEATURES.dep_high });
  assert.equal(mailbox(db, "student", "S_CHILD").some((m) => m.event_id === r.event_id), true);
  assert.equal(mailbox(db, "guardian", "G_CHILD").length, 0);
  assert.equal(mailbox(db, "psychologist", "P_S_CHILD").length, 0);
});

test("L2 联系学生指定的可信成年人，且不暴露任何特征字段", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "social_isolation",
    features: FEATURES.iso_long,
  });
  const adult = mailbox(db, "trusted_adult", "A_S_CHILD");
  assert.equal(adult.some((m) => m.event_id === r.event_id), true);
  // 监护人不直接被打扰（有可信成年人时）。
  assert.equal(mailbox(db, "guardian", "G_CHILD").length, 0);
  for (const m of adult) {
    assert.ok(!m.fields.includes("features"));
    assert.ok(!m.fields.includes("reasons"));
    assert.ok(m.fields.includes("recommendation"));
  }
});

test("L3 只进入被分派心理人员的复核队列", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "harm_cue",
    features: FEATURES.harm_plan,
  });
  const psy = mailbox(db, "psychologist", "P_S_CHILD");
  assert.equal(psy.some((m) => m.event_id === r.event_id), true);
  // 其他学生的心理人员看不到。
  assert.equal(mailbox(db, "psychologist", "P_S_TEEN").length, 0);
  // 心理人员载荷含版本与特征（复核需要）。
  const mine = psy.find((m) => m.event_id === r.event_id);
  assert.ok(mine.fields.includes("features"));
  assert.ok(mine.fields.includes("rule_version"));
  assert.ok(mine.fields.includes("evaluations"));
});

test("L4 即时处置：心理人员、值班教师、监护人均触达，普通教师不收通知", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "urgent_event",
    features: FEATURES.urgent,
  });
  assert.ok(mailbox(db, "psychologist", "P_S_CHILD").some((m) => m.event_id === r.event_id));
  assert.ok(mailbox(db, "duty_teacher", "D_S_CHILD").some((m) => m.event_id === r.event_id));
  assert.ok(mailbox(db, "guardian", "G_CHILD").some((m) => m.event_id === r.event_id));
  assert.equal(mailbox(db, "teacher", "T_S_CHILD").length, 0);
});

test("投递仅一次：反复 pump 不产生第二封", () => {
  const db = freshDb();
  setupWorld(db);
  ingestSignal(db, signal({ features: FEATURES.dep_high }));
  pumpOutbox(db);
  const afterFirst = db.prepare("SELECT COUNT(*) c FROM deliveries").get().c;
  assert.ok(afterFirst > 0);
  pumpOutbox(db);
  pumpOutbox(db);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM deliveries").get().c, afterFirst);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM outbox WHERE status='pending'").get().c, 0);
});

test("重启不丢：未投递的 pending 在新数据库句柄上继续补发", async () => {
  // 用文件库模拟进程重启：先只摄入不 pump，关闭；重新打开后补发。
  const tmp = new URL(`../data/restart-test-${process.pid}.sqlite3`, import.meta.url);
  const fs = await import("node:fs");
  try {
    fs.rmSync(tmp, { force: true });
    const { openDatabase } = await import("../src/db.js");
    let db = openDatabase(new URL(tmp).pathname);
    setupWorld(db);
    const r = ingestSignal(db, signal({ features: FEATURES.dep_high }));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM deliveries").get().c, 0);
    db.close();

    db = openDatabase(new URL(tmp).pathname);
    pumpOutbox(db);
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM deliveries WHERE recipient_role='student'").get().c,
      1,
    );
    // 再重启一次也不会重复投递。
    db.close();
    db = openDatabase(new URL(tmp).pathname);
    pumpOutbox(db);
    assert.equal(
      db.prepare("SELECT COUNT(*) c FROM deliveries WHERE recipient_role='student'").get().c,
      1,
    );
    void r;
    db.close();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("角色字段投影：三角色看到的字段严格不同且互为白名单子集", async () => {
  const db = freshDb();
  setupWorld(db);
  const { fieldsForRole } = await import("../src/projection.js");
  const l3 = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "harm_cue",
    features: FEATURES.harm_plan,
  });
  const psy = readEvent(db, "psychologist", "P_S_CHILD", l3.event_id);
  // L3 不向监护人披露；监护人视图在 L4 即时处置时产生。
  const l4 = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "urgent_event",
    features: FEATURES.urgent,
  });
  const guardian = readEvent(db, "guardian", "G_CHILD", l4.event_id);

  assert.deepEqual(Object.keys(psy).sort(), [...fieldsForRole("psychologist")].sort());
  assert.deepEqual(Object.keys(guardian).sort(), [...fieldsForRole("guardian")].sort());
  assert.ok(!("features" in guardian));
  assert.ok(!("reasons" in guardian));
  assert.ok(!("rule_version" in guardian));
  assert.ok("recommendation" in guardian);

  // L1 是私密级别：即使是监护人也读不到。
  const dep = ingestAndPump(db, { subjectRef: "S_TEEN", features: FEATURES.dep_high });
  assert.throws(
    () => readEvent(db, "guardian", "G_TEEN", dep.event_id),
    (e) => e.status === 403,
  );
});

test("越权访问被拒绝并留痕", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "harm_cue",
    features: FEATURES.harm_plan,
  });
  // 别的学生的监护人无权查看。
  assert.throws(
    () => readEvent(db, "guardian", "G_S_TEEN", r.event_id),
    (err) => err instanceof ServiceError && err.status === 403,
  );
  // 普通教师不能读 L4。
  const l4 = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "urgent_event",
    features: FEATURES.urgent,
  });
  assert.throws(() => readEvent(db, "teacher", "T_S_CHILD", l4.event_id), /无权访问/);
  const denied = db
    .prepare("SELECT COUNT(*) c FROM audit_log WHERE result='deny'")
    .get().c;
  assert.ok(denied >= 2);
});

test("人工复核：确认、关闭、降级路径；自动流程不会自行降级", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "harm_cue",
    features: FEATURES.harm_plan,
  });
  assert.equal(
    db.prepare("SELECT level_code FROM events WHERE event_id=?").get(r.event_id).level_code,
    3,
  );
  const result = recordReview(db, "P_S_CHILD", r.event_id, {
    decision: "downgrade",
    newLevel: 2,
    note: "线索经核实为作业内容",
  });
  assert.equal(result.resulting_level, 2);
  assert.equal(
    db.prepare("SELECT level_code FROM events WHERE event_id=?").get(r.event_id).level_code,
    2,
  );
  assert.throws(
    () =>
      recordReview(db, "P_S_CHILD", r.event_id, { decision: "downgrade", newLevel: 3 }),
    /降级目标等级必须低于/,
  );
  const close = recordReview(db, "P_S_CHILD", r.event_id, { decision: "close" });
  assert.ok(close);
  assert.equal(
    db.prepare("SELECT status FROM events WHERE event_id=?").get(r.event_id).status,
    "closed",
  );
});

test("披露登记可证明最小化：字段清单=角色白名单，摘要=按白名单投影的载荷", () => {
  const db = freshDb();
  setupWorld(db);
  // 注意：不 pump——投递前所有披露行为 pending，投影状态与派发时完全一致。
  const r = ingestSignal(db, signal({
    subjectRef: "S_CHILD",
    signal_type: "urgent_event",
    features: FEATURES.urgent,
  }));

  const rows = db
    .prepare("SELECT recipient_ref, recipient_role, fields, payload_digest FROM disclosures WHERE event_id=?")
    .all(r.event_id);
  const roles = rows.map((x) => x.recipient_role).sort();
  assert.deepEqual(roles, ["duty_teacher", "guardian", "psychologist", "student"]);

  for (const row of rows) {
    const whitelist = fieldsForRole(row.recipient_role);
    const recordedFields = JSON.parse(row.fields).sort();
    assert.deepEqual(recordedFields, [...whitelist].sort(), `${row.recipient_role} 字段必须恰好等于白名单`);

    const payload = projectEvent(db, r.event_id, row.recipient_role);
    assert.deepEqual(Object.keys(payload).sort(), recordedFields);
    assert.equal(sha256Canonical(payload), row.payload_digest, "登记摘要必须可由白名单投影重算");
  }

  // 监护人载荷中绝不能出现心理人员字段。
  const guardianRow = rows.find((x) => x.recipient_role === "guardian");
  const guardianPayload = JSON.parse(
    JSON.stringify(projectEvent(db, r.event_id, "guardian")),
  );
  assert.ok(!("features" in guardianPayload));
  assert.ok(!("reasons" in guardianPayload));
  assert.equal(guardianPayload.subject_ref, "S_CHILD");
  void guardianRow;
});

test("人工升级触发新一轮最小披露：普通教师仍不收通知，监护人只收监护视图", () => {
  const db = freshDb();
  setupWorld(db);
  const l3 = ingestAndPump(db, {
    subjectRef: "S_CHILD",
    signal_type: "harm_cue",
    features: FEATURES.harm_plan,
  });
  const before = mailbox(db, "guardian", "G_CHILD").length;
  assert.equal(before, 0);

  const result = recordReview(db, "P_S_CHILD", l3.event_id, {
    decision: "escalate",
    newLevel: 4,
    note: "复核确认存在紧迫风险",
  });
  pumpOutbox(db);
  assert.equal(result.resulting_level, 4);

  assert.equal(mailbox(db, "teacher", "T_S_CHILD").length, 0);
  const guardianMail = mailbox(db, "guardian", "G_CHILD");
  assert.ok(guardianMail.some((m) => m.event_id === l3.event_id));
  for (const m of guardianMail) {
    assert.ok(!m.fields.includes("features"));
    assert.ok(!m.fields.includes("evaluations"));
    assert.ok(m.fields.includes("welfare_band"));
  }
  assert.ok(mailbox(db, "duty_teacher", "D_S_CHILD").some((m) => m.event_id === l3.event_id));

  // 非分派心理人员不能复核。
  const other = ingestSignal(db, signal({
    subjectRef: "S_TEEN",
    signal_type: "harm_cue",
    features: FEATURES.harm_plan,
  }));
  assert.throws(
    () => recordReview(db, "P_S_CHILD", other.event_id, { decision: "confirm" }),
    (e) => e.status === 403,
  );
});

test("主动求助同样两级去重：两小时窗内重复只算一次事件", () => {
  const db = freshDb();
  setupWorld(db);
  const a = ingestSignal(db, signal({
    signal_type: "help_request",
    features: FEATURES.help_talk,
    minutesAgo: 60,
  }));
  const b = ingestSignal(db, signal({
    signal_type: "help_request",
    features: FEATURES.help_talk,
    minutesAgo: 30,
  }));
  assert.equal(a.level, 2);
  assert.equal(b.merged, true);
  assert.equal(b.event_id, a.event_id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 1);
});
