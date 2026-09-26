import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// 全部表结构以版本化迁移方式按序执行；每条语句幂等，重启重复执行不报错。
const MIGRATIONS = [
  `
CREATE TABLE IF NOT EXISTS service_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`,
  `
CREATE TABLE IF NOT EXISTS subjects (
  subject_ref TEXT PRIMARY KEY,
  birth_date TEXT NOT NULL,
  display_pseudonym TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
  `
CREATE TABLE IF NOT EXISTS guardian_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  guardian_ref TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(subject_ref, guardian_ref)
);`,
  `
CREATE TABLE IF NOT EXISTS teacher_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  teacher_ref TEXT NOT NULL,
  class_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(subject_ref, teacher_ref)
);`,
  `
CREATE TABLE IF NOT EXISTS trusted_adults (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  adult_ref TEXT NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(subject_ref, adult_ref)
);`,
  // 校方专业人员与学生的分派关系（心理人员、值班教师协调人等）。
  `
CREATE TABLE IF NOT EXISTS care_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  member_ref TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('psychologist','duty_teacher')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(subject_ref, member_ref, role)
);`,
  // 同意决定只追加：现状由同 scope 最新一行决定，历史永不被覆盖。
  `
CREATE TABLE IF NOT EXISTS consent_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  scope TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('grant','revoke')),
  decided_by TEXT NOT NULL CHECK(decided_by IN ('student','guardian')),
  actor_ref TEXT NOT NULL,
  age_at_decision INTEGER,
  basis TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_subject ON consent_decisions(subject_ref, scope, id);`,
  // 信号只存结构化特征与摘要，不存任何会话原文。
  `
CREATE TABLE IF NOT EXISTS signals (
  signal_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  family TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  features TEXT NOT NULL,
  feature_schema TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  event_id TEXT,
  UNIQUE(source_id, source_sequence)
);
CREATE INDEX IF NOT EXISTS idx_signals_event ON signals(event_id);`,
  `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  family TEXT NOT NULL,
  signal_fingerprint TEXT NOT NULL,
  level_code INTEGER NOT NULL CHECK(level_code BETWEEN 1 AND 4),
  rule_version TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  feature_schema TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','escalated','closed')),
  legal_basis TEXT NOT NULL DEFAULT 'consent' CHECK(legal_basis IN ('consent','emergency','student_request')),
  reasons TEXT NOT NULL,
  features TEXT NOT NULL,
  confidence REAL NOT NULL,
  headline TEXT NOT NULL,
  facts TEXT NOT NULL,
  first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  signal_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events(subject_ref, status);
-- 同一指纹在事件未关闭期间唯一：重复上报只能并入既有事件。
CREATE UNIQUE INDEX IF NOT EXISTS ux_events_open_fingerprint
  ON events(subject_ref, signal_fingerprint)
  WHERE status IN ('open','escalated');`,
  // 每次触发都追加一条不可改的版本快照：算法/规则升级后旧判断仍按旧版本呈现。
  `
CREATE TABLE IF NOT EXISTS event_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  signal_id TEXT NOT NULL,
  level_code INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  feature_schema TEXT NOT NULL,
  reasons TEXT NOT NULL,
  features TEXT NOT NULL,
  confidence REAL NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evaluations_event ON event_evaluations(event_id, id);`,
  `
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  from_level INTEGER,
  to_level INTEGER NOT NULL,
  action TEXT NOT NULL,
  decided_by_role TEXT NOT NULL,
  decided_by_ref TEXT,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_escalations_event ON escalations(event_id, id);`,
  // 每次对外披露登记：收件人、角色、字段清单、载荷摘要——最小化披露的凭证。
  `
CREATE TABLE IF NOT EXISTS disclosures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  escalation_id INTEGER REFERENCES escalations(id),
  recipient_ref TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  fields TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','failed','suppressed')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_disclosures_event ON disclosures(event_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_disclosures_once
  ON disclosures(event_id, recipient_ref, recipient_role, escalation_id);`,
  // 发件箱：服务中断/重启后 pending 行继续投递；status 翻转保证仅一次。
  `
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  disclosure_id INTEGER NOT NULL REFERENCES disclosures(id),
  channel TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
  last_error TEXT,
  run_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, run_after);`,
  // 实际投递落点：disclosure_id 唯一，重复补发不可能产生第二封。
  `
CREATE TABLE IF NOT EXISTS deliveries (
  disclosure_id INTEGER PRIMARY KEY REFERENCES disclosures(id),
  recipient_ref TEXT NOT NULL,
  recipient_role TEXT NOT NULL,
  channel TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);`,
  `
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  reviewer_ref TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('confirm','downgrade','close','escalate')),
  resulting_level INTEGER,
  note_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_event ON reviews(event_id, id);`,
  `
CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  statement_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','answered','rejected')),
  response_text TEXT,
  responded_by_ref TEXT,
  created_at TEXT NOT NULL,
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_subject ON appeals(subject_ref, id);`,
  `
CREATE TABLE IF NOT EXISTS deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_ref TEXT NOT NULL REFERENCES subjects(subject_ref),
  status TEXT NOT NULL CHECK(status IN ('pending','processing','completed')),
  progress INTEGER NOT NULL DEFAULT 0,
  routine_purged_at TEXT,
  retained_event_ids TEXT NOT NULL DEFAULT '[]',
  legal_hold_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deletion_subject ON deletion_requests(subject_ref, id);`,
  // 哈希链审计：任何越权/访问都留痕；删除或改写中间一行会断链，verify 可发现。
  `
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_ref TEXT,
  result TEXT NOT NULL CHECK(result IN ('allow','deny','error','system')),
  detail_digest TEXT,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);
-- 审计只追加：库层拒绝改写与删除。
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;`,
];

// 在事务中执行 fn；抛错时回滚。当前 node:sqlite 无 execTransaction，故手动包装。
export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  const applied = Number(db.prepare("PRAGMA user_version").get().user_version);
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
  }
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  db.prepare(
    `INSERT OR IGNORE INTO service_meta(key, value) VALUES('schema_version', '1')`,
  ).run();
  return db;
}
