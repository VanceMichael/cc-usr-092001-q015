import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { DEFAULT_RULESET } from "../src/rules.js";
import {
  activateRuleSet,
  caseProof,
  ingestEvent,
  registerConsent,
  viewCase,
} from "../src/service.js";

const ADMIN = { ref: "admin-1", role: "admin" };

test("升级记录与披露回执在服务重启后不丢失", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-bridge-"));
  const databasePath = path.join(dir, "app.sqlite3");

  // 第一次运行：写入紧急事件并产生一次披露。
  let db = openDatabase(databasePath);
  activateRuleSet(db, DEFAULT_RULESET, ADMIN);
  registerConsent(db, {
    subject_ref: "SUBJ-1",
    age_band: "under_14",
    guardian_ref: "GUARD-1",
    guardian_relation: "parent",
  });
  const stored = ingestEvent(db, {
    event_id: "EVT-RESTART",
    subject_ref: "SUBJ-1",
    kind: "risk_signal",
    signal_type: "crisis",
    metrics: { emergency: true },
    payload_digest: "sha256:restart",
    occurred_at: "2026-09-25T22:40:00+08:00",
    source_sequence: 1,
  });
  const caseId = db
    .prepare("SELECT case_id FROM cases WHERE assessment_id = ?")
    .get(stored.assessment.assessment_id).case_id;
  viewCase(db, caseId, { ref: "counselor-1", role: "counselor" });
  db.close();

  // 模拟服务重启：重新打开同一数据文件。
  db = openDatabase(databasePath);
  const proof = caseProof(db, caseId, { ref: "counselor-1", role: "counselor" });
  assert.equal(proof.level, "emergency");
  assert.equal(proof.action, "immediate");
  assert.equal(proof.rule_version, "v1");
  assert.equal(proof.disclosures.length, 1);
  assert.equal(proof.disclosures[0].actor_role, "counselor");
  db.close();

  fs.rmSync(dir, { recursive: true, force: true });
});
