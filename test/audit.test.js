import assert from "node:assert/strict";
import test from "node:test";

import { ingestSignal } from "../src/ingest.js";
import { pumpOutbox, readEvent } from "../src/cases.js";
import { appendAudit, verifyAudit } from "../src/audit.js";
import { FEATURES, freshDb, setupWorld, signal } from "./helpers.js";

test("正常运行后审计链完整可验证", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestSignal(db, signal({ signal_type: "harm_cue", features: FEATURES.harm_plan }));
  pumpOutbox(db);
  readEvent(db, "psychologist", "P_S_CHILD", r.event_id);
  assert.throws(() => readEvent(db, "guardian", "G_S_TEEN", r.event_id));

  const result = verifyAudit(db);
  assert.equal(result.ok, true);
  assert.ok(result.entries >= 5);
});

test("审计行在库层禁止改写与删除", () => {
  const db = freshDb();
  setupWorld(db);
  appendAudit(db, { actorRef: "X", actorRole: "student", action: "t", result: "allow" });
  assert.throws(
    () => db.exec("UPDATE audit_log SET action='hacked' WHERE seq=1"),
    /append-only/,
  );
  assert.throws(() => db.exec("DELETE FROM audit_log WHERE seq=1"), /append-only/);
  assert.equal(verifyAudit(db).ok, true);
});

test("伪造一条哈希不匹配的审计行，验链立即发现断点", () => {
  const db = freshDb();
  setupWorld(db);
  appendAudit(db, { actorRef: "X", actorRole: "student", action: "t1", result: "allow" });
  // 绕过 appendAudit 直接插入一条内容与哈希不符的记录。
  db.prepare(
    `INSERT INTO audit_log(ts, actor_ref, actor_role, action, target_ref, result, detail_digest, prev_hash, entry_hash)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run("2026-01-01T00:00:00Z", "FORGE", "student", "t2", null, "allow", null, "WRONG", "sha256:deadbeef");
  const result = verifyAudit(db);
  assert.equal(result.ok, false);
  // setupWorld 已写入 4 条同意审计 + t1，伪造行位于 seq 6。
  assert.equal(result.brokenAt, 6);
});

test("所有越权访问均产生 deny 留痕", () => {
  const db = freshDb();
  setupWorld(db);
  const r = ingestSignal(db, signal({ signal_type: "urgent_event", features: FEATURES.urgent }));
  pumpOutbox(db);
  for (let i = 0; i < 3; i++) {
    assert.throws(() => readEvent(db, "guardian", "G_S_TEEN", r.event_id));
  }
  const denies = db
    .prepare("SELECT action, COUNT(*) c FROM audit_log WHERE result='deny' GROUP BY action")
    .all();
  assert.ok(denies.some((d) => d.action === "event.read_denied" && d.c >= 3));
});
