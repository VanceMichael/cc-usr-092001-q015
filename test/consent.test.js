import assert from "node:assert/strict";
import test from "node:test";

import { ConsentError, recordConsent, routineMonitoringAllowed } from "../src/consent.js";
import { freshDb, setupWorld } from "./helpers.js";

test("未满14岁：无同意拒收常规信号，监护人同意后放行，撤回后停止", () => {
  const db = freshDb();
  setupWorld(db, { consent: false });

  assert.equal(routineMonitoringAllowed(db, "S_CHILD").allowed, false);
  assert.equal(
    routineMonitoringAllowed(db, "S_CHILD").reason,
    "guardian_consent_missing",
  );

  assert.throws(
    () =>
      recordConsent(db, {
        subjectRef: "S_CHILD",
        decision: "grant",
        decidedBy: "student",
        actorRef: "S_CHILD",
      }),
    ConsentError,
  );

  recordConsent(db, {
    subjectRef: "S_CHILD",
    decision: "grant",
    decidedBy: "guardian",
    actorRef: "G_CHILD",
  });
  assert.equal(routineMonitoringAllowed(db, "S_CHILD").allowed, true);

  recordConsent(db, {
    subjectRef: "S_CHILD",
    decision: "revoke",
    decidedBy: "guardian",
    actorRef: "G_CHILD",
  });
  const gate = routineMonitoringAllowed(db, "S_CHILD");
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "consent_revoked");

  // 历史同意行仍保留（只追加）。
  const history = db
    .prepare("SELECT decision FROM consent_decisions WHERE subject_ref='S_CHILD' ORDER BY id")
    .all();
  assert.deepEqual(history.map((r) => r.decision), ["grant", "revoke"]);
});

test("14–17岁：需学生与监护人共同同意，任一方撤回即停", () => {
  const db = freshDb();
  setupWorld(db, { consent: false });

  recordConsent(db, {
    subjectRef: "S_TEEN",
    decision: "grant",
    decidedBy: "student",
    actorRef: "S_TEEN",
  });
  assert.equal(routineMonitoringAllowed(db, "S_TEEN").reason, "joint_consent_incomplete");

  // 监护人不能跳过学生先行同意。
  const db2 = freshDb();
  setupWorld(db2, { consent: false });
  assert.throws(
    () =>
      recordConsent(db2, {
        subjectRef: "S_TEEN",
        decision: "grant",
        decidedBy: "guardian",
        actorRef: "G_TEEN",
      }),
    ConsentError,
  );

  recordConsent(db, {
    subjectRef: "S_TEEN",
    decision: "grant",
    decidedBy: "guardian",
    actorRef: "G_TEEN",
  });
  assert.equal(routineMonitoringAllowed(db, "S_TEEN").reason, "joint_grant");

  recordConsent(db, {
    subjectRef: "S_TEEN",
    decision: "revoke",
    decidedBy: "student",
    actorRef: "S_TEEN",
  });
  assert.equal(routineMonitoringAllowed(db, "S_TEEN").reason, "consent_revoked");
});

test("成年学生：本人同意即可", () => {
  const db = freshDb();
  setupWorld(db, { consent: false });
  assert.equal(routineMonitoringAllowed(db, "S_ADULT").reason, "self_consent_missing");
  recordConsent(db, {
    subjectRef: "S_ADULT",
    decision: "grant",
    decidedBy: "student",
    actorRef: "S_ADULT",
  });
  assert.equal(routineMonitoringAllowed(db, "S_ADULT").reason, "adult_self_grant");
});

test("未验证监护人不能代决", () => {
  const db = freshDb();
  setupWorld(db, { consent: false });
  assert.throws(
    () =>
      recordConsent(db, {
        subjectRef: "S_CHILD",
        decision: "grant",
        decidedBy: "guardian",
        actorRef: "G_SOMEBODY_ELSE",
      }),
    /未经验证/,
  );
});
