import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { DEFAULT_RULESET } from "../src/rules.js";
import {
  activateRuleSet,
  advanceDeletion,
  caseProof,
  createAppeal,
  getDeletion,
  ingestEvent,
  registerConsent,
  requestDeletion,
  resolveAppeal,
  verifyAuditChain,
  viewCase,
  withdrawConsent,
} from "../src/service.js";

const ADMIN = { ref: "admin-1", role: "admin" };
const COUNSELOR = { ref: "counselor-1", role: "counselor" };

function freshDb() {
  const db = openDatabase(":memory:");
  activateRuleSet(db, DEFAULT_RULESET, ADMIN);
  return db;
}

function grantConsent(db, subjectRef = "SUBJ-1", guardianRef = "GUARD-1") {
  return registerConsent(db, {
    subject_ref: subjectRef,
    age_band: "14_to_16",
    guardian_ref: guardianRef,
    guardian_relation: "parent",
  });
}

function eventBody(overrides = {}) {
  return {
    event_id: `EVT-${Math.random()}`,
    subject_ref: "SUBJ-1",
    kind: "risk_signal",
    signal_type: "usage_pattern",
    metrics: { consecutive_days: 20, late_night_minutes: 90 },
    payload_digest: "sha256:abc",
    occurred_at: "2026-09-20T23:10:00+08:00",
    source_sequence: 1,
    ...overrides,
  };
}

test("同一信号重复上报只产生一次事件和一次判断", () => {
  const db = freshDb();
  grantConsent(db);
  const body = eventBody({ event_id: "EVT-DUP" });
  const first = ingestEvent(db, body);
  assert.equal(first.status, "stored");
  assert.ok(first.assessment);

  const again = ingestEvent(db, body);
  assert.equal(again.status, "duplicate");
  assert.equal(again.assessment.assessment_id, first.assessment.assessment_id);

  // 换了 event_id 的同一物理信号（同摘要同时间）仍然去重。
  const renamed = ingestEvent(db, { ...body, event_id: "EVT-DUP-2" });
  assert.equal(renamed.status, "duplicate");

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assessments").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cases").get().n, 1);
});

test("拒绝任何可还原谈话内容的字段", () => {
  const db = freshDb();
  grantConsent(db);
  assert.throws(
    () => ingestEvent(db, eventBody({ metrics: { consecutive_days: 20, content: "聊天原文" } })),
    /不允许上传可还原谈话内容/,
  );
  assert.throws(
    () => ingestEvent(db, eventBody({ transcript: "..." })),
    /不允许上传可还原谈话内容/,
  );
  assert.throws(
    () => ingestEvent(db, eventBody({ metrics: { unknown_metric: 1 } })),
    /未登记的指标字段/,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("规则版本变化不改写旧判断", () => {
  const db = freshDb();
  grantConsent(db);
  const first = ingestEvent(db, eventBody({ event_id: "EVT-V1" }));
  assert.equal(first.assessment.rule_version, "v1");
  assert.equal(first.assessment.level, "dependence");

  // 新版本把依赖阈值改得更宽松，并改写说明文案。
  const v2 = {
    version: "v2",
    rules: DEFAULT_RULESET.rules.map((rule) =>
      rule.name === "general-dependence"
        ? {
            ...rule,
            conditions: [{ field: "consecutive_days", op: "gte", value: 3 }],
            explanation: "新版本文案",
          }
        : rule,
    ),
  };
  activateRuleSet(db, v2, ADMIN);

  const second = ingestEvent(
    db,
    eventBody({
      event_id: "EVT-V2",
      metrics: { consecutive_days: 5 },
      payload_digest: "sha256:other",
      occurred_at: "2026-09-21T23:10:00+08:00",
    }),
  );
  assert.equal(second.assessment.rule_version, "v2");
  assert.equal(second.assessment.explanation, "新版本文案");

  const old = db.prepare("SELECT * FROM assessments WHERE event_id = 'EVT-V1'").get();
  assert.equal(old.rule_version, "v1");
  assert.notEqual(old.explanation, "新版本文案");

  // 已写入的规则集版本不可被覆盖。
  assert.throws(() => activateRuleSet(db, v2, ADMIN), /不可修改/);
});

test("四级信号分别触发四级处置", () => {
  const db = freshDb();
  grantConsent(db);
  const cases = [
    [{ consecutive_days: 20, late_night_minutes: 90 }, "dependence", "self_reminder"],
    [{ isolation_days: 30 }, "isolation", "trusted_adult"],
    [{ harm_clue: true }, "harm_clue", "professional_review"],
    [{ emergency: true }, "emergency", "immediate"],
  ];
  cases.forEach(([metrics, level, action], index) => {
    const result = ingestEvent(
      db,
      eventBody({
        event_id: `EVT-L${index}`,
        metrics,
        payload_digest: `sha256:l${index}`,
        occurred_at: `2026-09-2${index}T10:00:00+08:00`,
      }),
    );
    assert.equal(result.assessment.level, level);
    assert.equal(result.assessment.action, action);
    assert.ok(result.assessment.explanation.length > 0);
  });
});

test("撤回授权后停止常规监测，但紧急信号与主动求助仍被受理", () => {
  const db = freshDb();
  const consent = grantConsent(db);
  withdrawConsent(db, consent.consent_id, { ref: "SUBJ-1", role: "student" });

  const routine = ingestEvent(db, eventBody({ event_id: "EVT-R" }));
  assert.equal(routine.status, "dropped");
  assert.equal(routine.reason, "consent_withdrawn");

  const emergency = ingestEvent(
    db,
    eventBody({ event_id: "EVT-E", metrics: { emergency: true }, payload_digest: "sha256:e" }),
  );
  assert.equal(emergency.status, "stored");
  assert.equal(emergency.assessment.action, "immediate");

  const help = ingestEvent(
    db,
    eventBody({
      event_id: "EVT-H",
      kind: "help_request",
      metrics: {},
      payload_digest: "sha256:h",
    }),
  );
  assert.equal(help.status, "stored");
  assert.equal(help.assessment.action, "professional_review");

  // 无关人员不能撤回授权，且越权尝试被留痕。
  const consent2 = grantConsent(db, "SUBJ-2", "GUARD-2");
  assert.throws(
    () => withdrawConsent(db, consent2.consent_id, { ref: "stranger", role: "guardian" }),
    /监护人可以撤回授权/,
  );
  const denied = db
    .prepare("SELECT * FROM audit_log WHERE action = 'consent_withdraw' AND outcome = 'denied'")
    .all();
  assert.equal(denied.length, 1);
});

test("不同角色看到的案件字段不同，越权访问留痕", () => {
  const db = freshDb();
  grantConsent(db);
  const stored = ingestEvent(db, eventBody({ metrics: { harm_clue: true } }));
  const caseId = db
    .prepare("SELECT case_id FROM cases WHERE assessment_id = ?")
    .get(stored.assessment.assessment_id).case_id;

  const counselorView = viewCase(db, caseId, COUNSELOR);
  assert.ok("metrics" in counselorView && "signal_type" in counselorView);

  const guardianView = viewCase(db, caseId, { ref: "GUARD-1", role: "guardian" });
  assert.ok("explanation" in guardianView);
  assert.ok(!("metrics" in guardianView) && !("subject_ref" in guardianView));

  const teacherView = viewCase(db, caseId, { ref: "TEACHER-1", role: "teacher" });
  assert.deepEqual(Object.keys(teacherView).sort(), [
    "case_id",
    "occurred_on",
    "status",
    "support_recommended",
  ]);

  const studentView = viewCase(db, caseId, { ref: "SUBJ-1", role: "student" });
  assert.ok(studentView.appeal_path.includes(stored.assessment.assessment_id));

  // 非登记监护人访问被拒并留痕。
  assert.throws(
    () => viewCase(db, caseId, { ref: "GUARD-X", role: "guardian" }),
    /监护关系不匹配/,
  );
  const denied = db
    .prepare("SELECT * FROM audit_log WHERE action = 'case_view' AND outcome = 'denied'")
    .all();
  assert.equal(denied.length, 1);
  assert.equal(denied[0].actor_ref, "GUARD-X");
});

test("复核者可凭披露回执证明升级未暴露多余内容", () => {
  const db = freshDb();
  grantConsent(db);
  const stored = ingestEvent(db, eventBody({ metrics: { emergency: true } }));
  const caseId = db
    .prepare("SELECT case_id FROM cases WHERE assessment_id = ?")
    .get(stored.assessment.assessment_id).case_id;

  viewCase(db, caseId, { ref: "TEACHER-1", role: "teacher" });
  viewCase(db, caseId, { ref: "GUARD-1", role: "guardian" });

  const proof = caseProof(db, caseId, COUNSELOR);
  assert.equal(proof.level, "emergency");
  assert.equal(proof.action, "immediate");
  assert.equal(proof.disclosures.length, 2);
  const teacherReceipt = proof.disclosures.find((item) => item.actor_role === "teacher");
  assert.deepEqual(teacherReceipt.fields.sort(), [
    "case_id",
    "occurred_on",
    "status",
    "support_recommended",
  ]);
  // 教师视图不含任何指标、摘要或说明文字。
  assert.ok(!teacherReceipt.fields.includes("metrics"));
  assert.ok(!teacherReceipt.fields.includes("explanation"));

  assert.throws(() => caseProof(db, caseId, { ref: "T", role: "teacher" }), /无权/);
});

test("申诉可提交并由心理人员复核，推翻后关闭案件但保留原判断", () => {
  const db = freshDb();
  grantConsent(db);
  const stored = ingestEvent(db, eventBody({ metrics: { isolation_days: 40 } }));

  assert.throws(
    () => createAppeal(db, stored.assessment.assessment_id, { subject_ref: "SUBJ-X", reason: "r" }),
    /只能对涉及自己的判断/,
  );
  const appeal = createAppeal(db, stored.assessment.assessment_id, {
    subject_ref: "SUBJ-1",
    reason: "那段时间住校，并非孤立",
  });
  assert.equal(appeal.status, "submitted");

  const resolved = resolveAppeal(db, appeal.appeal_id, "overturned", COUNSELOR);
  assert.equal(resolved.status, "overturned");

  const caseRow = db
    .prepare("SELECT status FROM cases WHERE assessment_id = ?")
    .get(stored.assessment.assessment_id);
  assert.equal(caseRow.status, "resolved");
  // 原判断记录保持不可变。
  const assessment = db
    .prepare("SELECT * FROM assessments WHERE assessment_id = ?")
    .get(stored.assessment.assessment_id);
  assert.equal(assessment.level, "isolation");
});

test("数据删除按步骤推进，未结紧急事件按策略保留", () => {
  const db = freshDb();
  grantConsent(db);
  ingestEvent(db, eventBody({ event_id: "EVT-D1", metrics: { emergency: true } }));
  ingestEvent(
    db,
    eventBody({
      event_id: "EVT-D2",
      metrics: { consecutive_days: 20, late_night_minutes: 90 },
      payload_digest: "sha256:d2",
      occurred_at: "2026-09-22T10:00:00+08:00",
    }),
  );

  const request = requestDeletion(db, "SUBJ-1", { ref: "SUBJ-1", role: "student" });
  assert.equal(request.status, "pending");
  assert.equal(request.steps.length, 5);

  let current = request;
  for (let i = 0; i < 5; i += 1) current = advanceDeletion(db, current.deletion_id);
  assert.equal(current.status, "completed");
  assert.ok(current.steps.every((step) => step.status === "completed" && step.at));

  const progress = getDeletion(db, request.deletion_id);
  assert.equal(progress.status, "completed");

  // 事件内容已抹除（只留不含个人信息的墓碑行），未结紧急案件按策略保留并注明。
  const remaining = db.prepare("SELECT * FROM events WHERE subject_ref = 'SUBJ-1'").all();
  assert.equal(remaining.length, 0);
  const tombstones = db.prepare("SELECT * FROM events").all();
  assert.ok(tombstones.every((row) => row.metrics === "{}" && row.payload_digest.startsWith("erased:")));
  const emergencyCase = db.prepare("SELECT * FROM cases WHERE level = 'emergency'").get();
  assert.equal(emergencyCase.subject_ref, "SUBJ-1");
  const retainedNote = progress.steps.find((step) => step.name === "cases_anonymized").note;
  assert.match(retainedNote, /保留 1 件未结紧急事件/);
});

test("审计日志哈希链完整可验证", () => {
  const db = freshDb();
  grantConsent(db);
  ingestEvent(db, eventBody());
  const result = verifyAuditChain(db);
  assert.equal(result.intact, true);
  assert.ok(result.entries > 0);
});
