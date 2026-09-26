import assert from "node:assert/strict";
import test from "node:test";

import { recordConsent, routineMonitoringAllowed } from "../src/consent.js";
import { ingestSignal, IngestError } from "../src/ingest.js";
import { FEATURES, freshDb, setupWorld, signal } from "./helpers.js";

test("入口拒绝任何疑似谈话原文字段，不产生信号记录", () => {
  const db = freshDb();
  setupWorld(db);
  const payload = signal({
    signal_type: "harm_cue",
    features: { ...FEATURES.harm_plan, transcript: "我今天说……" },
  });
  assert.throws(() => ingestSignal(db, payload), (err) => {
    assert.ok(err instanceof IngestError);
    assert.equal(err.code, "prohibited_content");
    assert.equal(err.status, 422);
    return true;
  });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM signals").get().c, 0);
});

test("拒绝未登记的特征字段与越界数值", () => {
  const db = freshDb();
  setupWorld(db);
  assert.throws(
    () =>
      ingestSignal(db, signal({ features: { ...FEATURES.dep_high, mood_text: "烦" } })),
    /未登记的特征字段/,
  );
  assert.throws(
    () =>
      ingestSignal(db, signal({ features: { ...FEATURES.dep_high, dependency_score: 5 } })),
    /dependency_score/,
  );
});

test("四级分级：L1 依赖、L2 孤立、L3 伤害线索、L4 紧急", () => {
  const db = freshDb();
  setupWorld(db);
  const l1 = ingestSignal(db, signal({ features: FEATURES.dep_high }));
  const l2 = ingestSignal(db, signal({ signal_type: "social_isolation", features: FEATURES.iso_long }));
  const l3 = ingestSignal(db, signal({ signal_type: "harm_cue", features: FEATURES.harm_plan }));
  const l4 = ingestSignal(db, signal({ signal_type: "urgent_event", features: FEATURES.urgent }));
  assert.equal(l1.level, 1);
  assert.equal(l2.level, 2);
  assert.equal(l3.level, 3);
  assert.equal(l4.level, 4);
  assert.equal(l4.legal_basis, "emergency");

  const levels = db.prepare("SELECT level_code, legal_basis FROM events ORDER BY rowid").all();
  assert.deepEqual(levels.map((x) => x.level_code), [1, 2, 3, 4]);
  assert.equal(levels[3].legal_basis, "emergency");
});

test("低于阈值的信号只记录不建事件", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestSignal(db, signal({ features: FEATURES.dep_low }));
  assert.equal(r.outcome, "ignored_below_threshold");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM signals").get().c, 1);
});

test("第一层去重：同一来源同一序号重传被幂等忽略", () => {
  const db = freshDb();
  setupWorld(db);
  const p = signal({ features: FEATURES.dep_high });
  const a = ingestSignal(db, p);
  const b = ingestSignal(db, { ...p, signal_id: "SIG-DIFFERENT-ID" });
  assert.equal(a.outcome, "accepted");
  assert.equal(b.outcome, "duplicate");
  assert.equal(b.event_id, a.event_id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM signals").get().c, 1);
});

test("第二层去重：同语义重复上报只并入一次事件，只追加评估快照", () => {
  const db = freshDb();
  setupWorld(db);
  const a = ingestSignal(db, signal({ features: FEATURES.dep_high, minutesAgo: 60 }));
  const b = ingestSignal(db, signal({ features: FEATURES.dep_high, minutesAgo: 30 }));
  const c = ingestSignal(db, signal({ features: FEATURES.dep_high, minutesAgo: 5 }));
  assert.equal(b.outcome, "accepted");
  assert.equal(b.merged, true);
  assert.equal(b.event_id, a.event_id);
  assert.equal(c.event_id, a.event_id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 1);
  const e = db.prepare("SELECT * FROM events WHERE event_id=?").get(a.event_id);
  assert.equal(e.signal_count, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM event_evaluations WHERE event_id=?").get(a.event_id).c,
    3,
  );
});

test("撤回同意后：常规信号拒收，紧急事件仍依法处理，主动求助始终接收", () => {
  const db = freshDb();
  setupWorld(db);
  recordConsent(db, {
    subjectRef: "S_CHILD",
    decision: "revoke",
    decidedBy: "guardian",
    actorRef: "G_CHILD",
    occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  assert.equal(routineMonitoringAllowed(db, "S_CHILD").allowed, false);

  const dep = ingestSignal(db, signal({ features: FEATURES.dep_high }));
  assert.equal(dep.outcome, "rejected_consent");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM signals").get().c, 0);

  const urgent = ingestSignal(db, signal({ signal_type: "urgent_event", features: FEATURES.urgent }));
  assert.equal(urgent.outcome, "accepted");
  assert.equal(urgent.level, 4);
  assert.equal(urgent.legal_basis, "emergency");

  const help = ingestSignal(db, signal({ signal_type: "help_request", features: FEATURES.help_talk }));
  assert.equal(help.outcome, "accepted");
  assert.equal(help.legal_basis, "student_request");
});

test("时间窗之外的重复信号构成新的发作（新事件）", () => {
  const db = freshDb();
  setupWorld(db);
  const a = ingestSignal(
    db,
    signal({ features: FEATURES.dep_high, occurred_at: "2026-09-20T10:00:00+08:00" }),
  );
  const b = ingestSignal(
    db,
    signal({ features: FEATURES.dep_high, occurred_at: "2026-09-25T10:00:00+08:00" }),
  );
  assert.notEqual(a.event_id, b.event_id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM events").get().c, 2);
});

test("事件保存建事件时的规则版本，后续评估追加新版本快照", async () => {
  const db = freshDb();
  setupWorld(db);
  const { registerRuleVersion, CURRENT_RULE_VERSION } = await import("../src/rules.js");
  const NEW_VERSION = "bridge-rules-9999-test-v2";
  registerRuleVersion(NEW_VERSION, {
    evaluate: () => ({
      level: 2,
      confidence: 0.5,
      reasons: [{ code: "dep_score", text: "新规则下的解释" }],
    }),
  });

  const a = ingestSignal(db, signal({ features: FEATURES.dep_high, minutesAgo: 40 }));
  const eventV1 = db.prepare("SELECT rule_version, level_code FROM events WHERE event_id=?").get(a.event_id);
  assert.equal(eventV1.rule_version, CURRENT_RULE_VERSION);
  assert.equal(eventV1.level_code, 1);

  // 新规则版本上线后再次上报：事件发生自动升级，但建事件版本仍为旧版。
  const b = ingestSignal(
    db,
    signal({ features: FEATURES.dep_high, minutesAgo: 10, extra: { rule_version: NEW_VERSION } }),
  );
  assert.equal(b.event_id, a.event_id);
  const eventAfter = db.prepare("SELECT rule_version, level_code FROM events WHERE event_id=?").get(a.event_id);
  assert.equal(eventAfter.rule_version, CURRENT_RULE_VERSION, "事件锚定版本不被改写");
  assert.equal(eventAfter.level_code, 2, "按新规则评估并升级");

  const snaps = db
    .prepare("SELECT level_code, rule_version FROM event_evaluations WHERE event_id=? ORDER BY id")
    .all(a.event_id);
  assert.deepEqual(
    snaps.map((s) => [s.level_code, s.rule_version]),
    [
      [1, CURRENT_RULE_VERSION],
      [2, NEW_VERSION],
    ],
  );
});

test("规则版本注册表只追加：重复登记同版本号被拒绝", async () => {
  const { registerRuleVersion, CURRENT_RULE_VERSION } = await import("../src/rules.js");
  assert.throws(
    () => registerRuleVersion(CURRENT_RULE_VERSION, { evaluate: () => null }),
    /禁止覆盖/,
  );
  assert.throws(
    () => registerRuleVersion("bad-version", {}),
    /evaluate 函数/,
  );
});
