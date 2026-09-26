import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS service_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  consent_id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL,
  age_band TEXT NOT NULL CHECK (age_band IN ('under_14', '14_to_16', '16_to_18')),
  guardian_ref TEXT NOT NULL,
  guardian_relation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'withdrawn')),
  granted_at TEXT NOT NULL,
  withdrawn_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_consents_subject ON consents(subject_ref);

-- 规则集整体不可变：版本一旦写入即冻结，旧判断永远引用旧版本。
CREATE TABLE IF NOT EXISTS rule_sets (
  version TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  activated_at TEXT NOT NULL
);

-- 只保存本地处理后的信号指标与摘要，不存在任何可还原谈话的字段。
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('risk_signal', 'usage', 'help_request')),
  signal_type TEXT NOT NULL,
  metrics TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  received_at TEXT NOT NULL
);
-- 同一信号的物理去重：即使来源换了 event_id 也只产生一次事件。
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_natural
  ON events(subject_ref, signal_type, payload_digest, occurred_at);

-- 判断记录不可变：rule_version 冻结了作出判断时的算法版本。
CREATE TABLE IF NOT EXISTS assessments (
  assessment_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  subject_ref TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('dependence', 'isolation', 'harm_clue', 'emergency')),
  action TEXT NOT NULL CHECK (action IN ('self_reminder', 'trusted_adult', 'professional_review', 'immediate')),
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL UNIQUE REFERENCES assessments(assessment_id),
  subject_ref TEXT NOT NULL,
  level TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'in_review', 'resolved')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appeals (
  appeal_id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(assessment_id),
  subject_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'under_review', 'upheld', 'overturned')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS deletion_requests (
  deletion_id TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
  steps TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 审计日志采用哈希链，任何篡改都会破坏后续条目。
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_ref TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  detail TEXT,
  at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);

-- 披露回执：每次查看案件时记录实际给出的字段集合与内容摘要，
-- 复核者据此证明一次升级没有暴露多余内容。
CREATE TABLE IF NOT EXISTS disclosure_receipts (
  receipt_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id),
  actor_ref TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  fields TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec(SCHEMA);
  database
    .prepare("INSERT OR IGNORE INTO service_meta(key, value) VALUES(?, ?)")
    .run("schema_version", "2");
  return database;
}
