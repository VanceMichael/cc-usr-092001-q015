import assert from "node:assert/strict";
import test from "node:test";

import { ingestSignal } from "../src/ingest.js";
import { pumpOutbox } from "../src/cases.js";
import {
  answerAppeal,
  explainEvent,
  fileAppeal,
  getDeletion,
  listAppeals,
  requestDeletion,
} from "../src/cases.js";
import { recordConsent } from "../src/consent.js";
import { FEATURES, freshDb, setupWorld, signal } from "./helpers.js";

test("学生获得可理解的决定说明：用了什么、没用什么、哪个版本", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestSignal(db, signal({ features: FEATURES.dep_high }));
  const ex = explainEvent(db, "S_CHILD", r.event_id);
  assert.ok(ex.headline.includes("一般依赖"));
  assert.ok(ex.what_happened.length > 0);
  assert.ok(ex.data_not_used.some((t) => t.includes("聊天原文")));
  assert.ok(ex.rule_version.startsWith("bridge-rules-"));
  assert.ok(ex.version_promise.includes("不会改写"));
  assert.ok(ex.your_options.includes("appeal"));
});

test("申诉：学生提交、心理人员应答，接受后事件关闭", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestSignal(db, signal({ features: FEATURES.dep_high }));
  const filed = fileAppeal(db, "S_CHILD", r.event_id, "我那天只是在听故事，没有一直聊天");
  assert.equal(filed.status, "pending");

  const pending = listAppeals(db, "psychologist", "P_S_CHILD");
  assert.ok(pending.some((a) => a.id === filed.appeal_id));

  const answered = answerAppeal(db, "P_S_CHILD", filed.appeal_id, {
    accept: true,
    response: "已复核，关闭该事件",
  });
  assert.equal(answered.status, "answered");
  assert.equal(
    db.prepare("SELECT status FROM events WHERE event_id=?").get(r.event_id).status,
    "closed",
  );
  const mine = listAppeals(db, "student", "S_CHILD");
  assert.equal(mine[0].response_text, "已复核，关闭该事件");
});

test("删除进度：常规事件特征被清除，L4 保留最小法律壳", () => {
  const db = freshDb();
  setupWorld(db);
  const routine = ingestSignal(db, signal({ features: FEATURES.dep_high }));
  pumpOutbox(db);
  fileAppeal(db, "S_CHILD", routine.event_id, "我那段对话其实是在做英语作业");
  const urgent = ingestSignal(db, signal({ signal_type: "urgent_event", features: FEATURES.urgent }));
  pumpOutbox(db);

  const progress = requestDeletion(db, "S_CHILD");
  assert.equal(progress.status, "completed");
  assert.equal(progress.progress, 100);
  assert.ok(progress.routine_purged_at);
  assert.deepEqual(progress.retained_event_ids, [urgent.event_id]);
  assert.ok(progress.legal_hold_until);

  const routineEvent = db.prepare("SELECT * FROM events WHERE event_id=?").get(routine.event_id);
  assert.equal(routineEvent.features, "{}");
  assert.equal(routineEvent.reasons, "[]");
  assert.equal(routineEvent.detector_version, "erased");
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM signals WHERE event_id=?").get(routine.event_id).c,
    0,
  );
  // 披露载荷投影同样被清空。
  const erasedDisclosure = db
    .prepare("SELECT fields, payload_digest FROM disclosures WHERE event_id=?")
    .all(routine.event_id)[0];
  assert.equal(erasedDisclosure.fields, "[]");
  // 学生申诉原文随删除请求擦除。
  const erasedAppeal = db.prepare("SELECT statement_text FROM appeals WHERE subject_ref='S_CHILD'").get();
  assert.equal(erasedAppeal.statement_text, "(已删除)");

  const urgentEvent = db.prepare("SELECT * FROM events WHERE event_id=?").get(urgent.event_id);
  assert.equal(urgentEvent.level_code, 4);
  assert.equal(urgentEvent.legal_basis, "emergency");
  assert.equal(urgentEvent.features, "{}");
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM signals WHERE event_id=?").get(urgent.event_id).c,
    0,
  );

  // 进度可再次查询。
  const again = getDeletion(db, "S_CHILD");
  assert.equal(again.progress, 100);
  assert.deepEqual(again.retained_event_ids, [urgent.event_id]);
});

test("删除后常规监测停止，但紧急信号仍按法律处理", () => {
  const db = freshDb();
  setupWorld(db);
  requestDeletion(db, "S_CHILD");
  const dep = ingestSignal(db, signal({ features: FEATURES.dep_high }));
  assert.equal(dep.outcome, "rejected_consent");
  const urgent = ingestSignal(db, signal({ signal_type: "urgent_event", features: FEATURES.urgent }));
  assert.equal(urgent.outcome, "accepted");
  assert.equal(urgent.legal_basis, "emergency");
});

test("成年学生可自行撤回并删除，无需监护人", () => {
  const db = freshDb();
  setupWorld(db);
  recordConsent(db, {
    subjectRef: "S_ADULT",
    decision: "revoke",
    decidedBy: "student",
    actorRef: "S_ADULT",
    occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const dep = ingestSignal(db, signal({ subjectRef: "S_ADULT", features: FEATURES.dep_high }));
  assert.equal(dep.outcome, "rejected_consent");
  const progress = requestDeletion(db, "S_ADULT");
  assert.equal(progress.status, "completed");
});
