import crypto from "node:crypto";

import { evaluateRules } from "./rules.js";

export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 任何可能还原谈话内容的字段都拒绝入库。
const FORBIDDEN_KEYS = new Set([
  "content",
  "text",
  "transcript",
  "message",
  "messages",
  "conversation",
  "chat",
  "raw",
]);

// 只允许本地处理后的数值/布尔指标进入系统。
const ALLOWED_METRIC_KEYS = new Set([
  "duration_minutes",
  "session_count",
  "consecutive_days",
  "late_night_minutes",
  "isolation_days",
  "severity",
  "harm_clue",
  "emergency",
]);

const EVENT_KINDS = new Set(["risk_signal", "usage", "help_request"]);
const AGE_BANDS = new Set(["under_14", "14_to_16", "16_to_18"]);

// 不同角色看到的案件字段必须不同，且只增不减地在此显式声明。
const CASE_VIEWS = {
  counselor: (record) => ({
    case_id: record.case_id,
    subject_ref: record.subject_ref,
    level: record.level,
    action: record.action,
    status: record.status,
    signal_type: record.signal_type,
    metrics: JSON.parse(record.metrics),
    occurred_at: record.occurred_at,
    explanation: record.explanation,
    rule_version: record.rule_version,
    created_at: record.created_at,
  }),
  guardian: (record) => ({
    case_id: record.case_id,
    level: record.level,
    action: record.action,
    status: record.status,
    occurred_at: record.occurred_at,
    explanation: record.explanation,
  }),
  teacher: (record) => ({
    case_id: record.case_id,
    status: record.status,
    support_recommended: record.level !== "dependence",
    occurred_on: record.occurred_at.slice(0, 10),
  }),
  student: (record) => ({
    case_id: record.case_id,
    level: record.level,
    action: record.action,
    explanation: record.explanation,
    appeal_path: `/assessments/${record.assessment_id}/appeals`,
  }),
};

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// 审计日志追加一条哈希链记录，越权访问同样留痕。
export function appendAudit(db, entry) {
  const prev = db
    .prepare("SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1")
    .get();
  const record = {
    audit_id: newId("audit"),
    actor_ref: entry.actor_ref,
    actor_role: entry.actor_role,
    action: entry.action,
    target_ref: entry.target_ref,
    outcome: entry.outcome,
    detail: entry.detail ?? null,
    at: nowIso(),
    prev_hash: prev ? prev.entry_hash : "GENESIS",
  };
  record.entry_hash = sha256(
    record.prev_hash +
      JSON.stringify([
        record.audit_id,
        record.actor_ref,
        record.actor_role,
        record.action,
        record.target_ref,
        record.outcome,
        record.detail,
        record.at,
      ]),
  );
  db.prepare(
    `INSERT INTO audit_log(audit_id, actor_ref, actor_role, action, target_ref, outcome, detail, at, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.audit_id,
    record.actor_ref,
    record.actor_role,
    record.action,
    record.target_ref,
    record.outcome,
    record.detail,
    record.at,
    record.prev_hash,
    record.entry_hash,
  );
  return record;
}

export function verifyAuditChain(db) {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY rowid ASC").all();
  let prevHash = "GENESIS";
  for (const row of rows) {
    const expect = sha256(
      prevHash +
        JSON.stringify([
          row.audit_id,
          row.actor_ref,
          row.actor_role,
          row.action,
          row.target_ref,
          row.outcome,
          row.detail,
          row.at,
        ]),
    );
    if (row.prev_hash !== prevHash || row.entry_hash !== expect) {
      return { intact: false, broken_at: row.audit_id };
    }
    prevHash = row.entry_hash;
  }
  return { intact: true, entries: rows.length };
}

export function listAudit(db, actor) {
  requireRole(actor, ["counselor", "admin"]);
  return db.prepare("SELECT * FROM audit_log ORDER BY rowid ASC").all();
}

// ---------- 同意管理 ----------

export function registerConsent(db, input) {
  for (const key of ["subject_ref", "age_band", "guardian_ref", "guardian_relation"]) {
    if (typeof input[key] !== "string" || input[key] === "") {
      throw new ServiceError(422, "invalid_consent", `缺少或非法字段：${key}`);
    }
  }
  if (!AGE_BANDS.has(input.age_band)) {
    throw new ServiceError(422, "invalid_age_band", "年龄段必须是 under_14 / 14_to_16 / 16_to_18");
  }
  const record = {
    consent_id: newId("consent"),
    subject_ref: input.subject_ref,
    age_band: input.age_band,
    guardian_ref: input.guardian_ref,
    guardian_relation: input.guardian_relation,
    status: "active",
    granted_at: input.granted_at ?? nowIso(),
    withdrawn_at: null,
  };
  db.prepare(
    `INSERT INTO consents(consent_id, subject_ref, age_band, guardian_ref, guardian_relation, status, granted_at, withdrawn_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.consent_id,
    record.subject_ref,
    record.age_band,
    record.guardian_ref,
    record.guardian_relation,
    record.status,
    record.granted_at,
    record.withdrawn_at,
  );
  appendAudit(db, {
    actor_ref: input.guardian_ref,
    actor_role: "guardian",
    action: "consent_granted",
    target_ref: record.subject_ref,
    outcome: "allowed",
    detail: `age_band=${record.age_band}`,
  });
  return record;
}

export function withdrawConsent(db, consentId, actor) {
  const consent = db.prepare("SELECT * FROM consents WHERE consent_id = ?").get(consentId);
  if (!consent) throw new ServiceError(404, "consent_not_found", "同意记录不存在");
  const isStudent = actor.role === "student" && actor.ref === consent.subject_ref;
  const isGuardian = actor.role === "guardian" && actor.ref === consent.guardian_ref;
  if (!isStudent && !isGuardian) {
    appendAudit(db, {
      actor_ref: actor.ref,
      actor_role: actor.role,
      action: "consent_withdraw",
      target_ref: consent.subject_ref,
      outcome: "denied",
      detail: "只有学生本人或登记的监护人可以撤回授权",
    });
    throw new ServiceError(403, "forbidden", "只有学生本人或登记的监护人可以撤回授权");
  }
  if (consent.status === "withdrawn") return consent;
  const at = nowIso();
  db.prepare("UPDATE consents SET status = 'withdrawn', withdrawn_at = ? WHERE consent_id = ?").run(
    at,
    consentId,
  );
  appendAudit(db, {
    actor_ref: actor.ref,
    actor_role: actor.role,
    action: "consent_withdraw",
    target_ref: consent.subject_ref,
    outcome: "allowed",
  });
  return { ...consent, status: "withdrawn", withdrawn_at: at };
}

function latestConsent(db, subjectRef) {
  return db
    .prepare("SELECT * FROM consents WHERE subject_ref = ? ORDER BY rowid DESC LIMIT 1")
    .get(subjectRef);
}

// ---------- 规则集管理 ----------

export function activateRuleSet(db, definition, actor) {
  requireRole(actor, ["admin", "counselor"]);
  if (!definition || typeof definition.version !== "string" || !Array.isArray(definition.rules)) {
    throw new ServiceError(422, "invalid_ruleset", "规则集必须包含 version 与 rules 数组");
  }
  const existing = db
    .prepare("SELECT version FROM rule_sets WHERE version = ?")
    .get(definition.version);
  if (existing) {
    throw new ServiceError(409, "ruleset_immutable", "规则集版本一旦写入不可修改");
  }
  const at = nowIso();
  db.prepare("UPDATE rule_sets SET status = 'retired' WHERE status = 'active'").run();
  db.prepare(
    "INSERT INTO rule_sets(version, definition, status, activated_at) VALUES (?, ?, 'active', ?)",
  ).run(definition.version, JSON.stringify(definition), at);
  appendAudit(db, {
    actor_ref: actor.ref,
    actor_role: actor.role,
    action: "ruleset_activated",
    target_ref: definition.version,
    outcome: "allowed",
  });
  return { version: definition.version, status: "active", activated_at: at };
}

export function activeRuleSet(db) {
  const row = db.prepare("SELECT * FROM rule_sets WHERE status = 'active'").get();
  return row ? { ...row, definition: JSON.parse(row.definition) } : null;
}

// ---------- 信号接收 ----------

function assertEventShape(body) {
  for (const key of [
    "event_id",
    "subject_ref",
    "kind",
    "signal_type",
    "occurred_at",
    "payload_digest",
  ]) {
    if (typeof body[key] !== "string" || body[key] === "") {
      throw new ServiceError(422, "invalid_event", `缺少或非法字段：${key}`);
    }
  }
  if (!EVENT_KINDS.has(body.kind)) {
    throw new ServiceError(422, "invalid_kind", "kind 必须是 risk_signal / usage / help_request");
  }
  if (!Number.isInteger(body.source_sequence) || body.source_sequence < 1) {
    throw new ServiceError(422, "invalid_sequence", "source_sequence 必须是正整数");
  }
  if (typeof body.metrics !== "object" || body.metrics === null || Array.isArray(body.metrics)) {
    throw new ServiceError(422, "invalid_metrics", "metrics 必须是对象");
  }
  const scan = (value) => {
    if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
        if (scan(inner)) return true;
      }
    }
    return false;
  };
  if (scan(body)) {
    throw new ServiceError(422, "raw_content_rejected", "不允许上传可还原谈话内容，只接受本地处理后的信号");
  }
  for (const [key, value] of Object.entries(body.metrics)) {
    if (!ALLOWED_METRIC_KEYS.has(key)) {
      throw new ServiceError(422, "unknown_metric", `未登记的指标字段：${key}`);
    }
    if (typeof value !== "number" && typeof value !== "boolean") {
      throw new ServiceError(422, "invalid_metric_value", `指标 ${key} 必须是数值或布尔值`);
    }
  }
}

function assessmentForEvent(db, eventId) {
  return db.prepare("SELECT * FROM assessments WHERE event_id = ?").get(eventId) ?? null;
}

export function ingestEvent(db, body) {
  assertEventShape(body);

  // 幂等：同一 event_id 或同一物理信号重复上报，只产生一次事件与一次判断。
  const byId = db.prepare("SELECT * FROM events WHERE event_id = ?").get(body.event_id);
  if (byId) {
    return { status: "duplicate", event_id: byId.event_id, assessment: assessmentForEvent(db, byId.event_id) };
  }
  const natural = db
    .prepare(
      "SELECT * FROM events WHERE subject_ref = ? AND signal_type = ? AND payload_digest = ? AND occurred_at = ?",
    )
    .get(body.subject_ref, body.signal_type, body.payload_digest, body.occurred_at);
  if (natural) {
    return { status: "duplicate", event_id: natural.event_id, assessment: assessmentForEvent(db, natural.event_id) };
  }

  const consent = latestConsent(db, body.subject_ref);
  const consentActive = consent?.status === "active";
  const isEmergency = body.metrics.emergency === true;
  const isHelpRequest = body.kind === "help_request";

  // 撤回授权后停止常规监测；紧急信号与学生主动求助仍按既定策略受理。
  if (!consentActive && !isEmergency && !isHelpRequest) {
    appendAudit(db, {
      actor_ref: "ingest",
      actor_role: "system",
      action: "event_dropped",
      target_ref: body.subject_ref,
      outcome: "denied",
      detail: consent ? "consent_withdrawn" : "no_consent",
    });
    return { status: "dropped", reason: consent ? "consent_withdrawn" : "no_consent" };
  }

  db.prepare(
    `INSERT INTO events(event_id, subject_ref, kind, signal_type, metrics, payload_digest, occurred_at, source_sequence, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    body.event_id,
    body.subject_ref,
    body.kind,
    body.signal_type,
    JSON.stringify(body.metrics),
    body.payload_digest,
    body.occurred_at,
    body.source_sequence,
    nowIso(),
  );

  const ruleSet = activeRuleSet(db);
  let assessment = null;
  if (ruleSet) {
    const context = {
      kind: body.kind,
      signal_type: body.signal_type,
      age_band: consent?.age_band ?? "unknown",
      ...body.metrics,
    };
    const rule = evaluateRules(ruleSet.definition, context);
    if (rule) {
      assessment = {
        assessment_id: newId("assess"),
        event_id: body.event_id,
        subject_ref: body.subject_ref,
        rule_version: ruleSet.version,
        level: rule.level,
        action: rule.action,
        explanation: rule.explanation,
        created_at: nowIso(),
      };
      db.prepare(
        `INSERT INTO assessments(assessment_id, event_id, subject_ref, rule_version, level, action, explanation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        assessment.assessment_id,
        assessment.event_id,
        assessment.subject_ref,
        assessment.rule_version,
        assessment.level,
        assessment.action,
        assessment.explanation,
        assessment.created_at,
      );
      db.prepare(
        `INSERT INTO cases(case_id, assessment_id, subject_ref, level, action, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      ).run(
        newId("case"),
        assessment.assessment_id,
        assessment.subject_ref,
        assessment.level,
        assessment.action,
        assessment.created_at,
      );
    }
  }

  appendAudit(db, {
    actor_ref: "ingest",
    actor_role: "system",
    action: "event_ingested",
    target_ref: body.subject_ref,
    outcome: "allowed",
    detail: `event_id=${body.event_id}`,
  });
  return { status: "stored", event_id: body.event_id, assessment };
}

// ---------- 分级查看与披露回执 ----------

function requireRole(actor, roles) {
  if (!actor || !roles.includes(actor.role)) {
    throw new ServiceError(403, "forbidden", "当前角色无权执行此操作");
  }
}

function loadCaseRecord(db, caseId) {
  return db
    .prepare(
      `SELECT cases.case_id, cases.status, cases.subject_ref, cases.created_at,
              assessments.assessment_id, assessments.level, assessments.action,
              assessments.explanation, assessments.rule_version,
              events.signal_type, events.metrics, events.occurred_at
       FROM cases JOIN assessments ON cases.assessment_id = assessments.assessment_id
                  JOIN events ON assessments.event_id = events.event_id
       WHERE cases.case_id = ?`,
    )
    .get(caseId);
}

export function viewCase(db, caseId, actor) {
  const record = loadCaseRecord(db, caseId);
  if (!record) throw new ServiceError(404, "case_not_found", "案件不存在");
  const build = CASE_VIEWS[actor.role];

  let deniedReason = null;
  if (!build) {
    deniedReason = "未知角色";
  } else if (actor.role === "guardian") {
    const consent = latestConsent(db, record.subject_ref);
    if (!consent || consent.guardian_ref !== actor.ref) {
      deniedReason = "监护关系不匹配";
    }
  } else if (actor.role === "student" && actor.ref !== record.subject_ref) {
    deniedReason = "学生只能查看自己的案件";
  }

  if (deniedReason) {
    appendAudit(db, {
      actor_ref: actor.ref,
      actor_role: actor.role,
      action: "case_view",
      target_ref: caseId,
      outcome: "denied",
      detail: deniedReason,
    });
    throw new ServiceError(403, "forbidden", `无权查看该案件：${deniedReason}`);
  }

  const view = build(record);
  const receipt = {
    receipt_id: newId("receipt"),
    case_id: caseId,
    actor_ref: actor.ref,
    actor_role: actor.role,
    fields: Object.keys(view),
    content_hash: sha256(JSON.stringify(view)),
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO disclosure_receipts(receipt_id, case_id, actor_ref, actor_role, fields, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.receipt_id,
    receipt.case_id,
    receipt.actor_ref,
    receipt.actor_role,
    JSON.stringify(receipt.fields),
    receipt.content_hash,
    receipt.created_at,
  );
  appendAudit(db, {
    actor_ref: actor.ref,
    actor_role: actor.role,
    action: "case_view",
    target_ref: caseId,
    outcome: "allowed",
    detail: `fields=${receipt.fields.join(",")}`,
  });
  return view;
}

// 复核者的升级证明：案件持久化事实 + 每次披露的确切字段集合。
export function caseProof(db, caseId, actor) {
  requireRole(actor, ["counselor", "admin"]);
  const record = loadCaseRecord(db, caseId);
  if (!record) throw new ServiceError(404, "case_not_found", "案件不存在");
  const receipts = db
    .prepare("SELECT * FROM disclosure_receipts WHERE case_id = ? ORDER BY rowid ASC")
    .all(caseId)
    .map((row) => ({ ...row, fields: JSON.parse(row.fields) }));
  return {
    case_id: caseId,
    level: record.level,
    action: record.action,
    rule_version: record.rule_version,
    persisted_at: record.created_at,
    disclosures: receipts,
  };
}

// ---------- 申诉 ----------

export function createAppeal(db, assessmentId, input) {
  const assessment = db
    .prepare("SELECT * FROM assessments WHERE assessment_id = ?")
    .get(assessmentId);
  if (!assessment) throw new ServiceError(404, "assessment_not_found", "判断记录不存在");
  if (input.subject_ref !== assessment.subject_ref) {
    appendAudit(db, {
      actor_ref: input.subject_ref ?? "unknown",
      actor_role: "student",
      action: "appeal_create",
      target_ref: assessmentId,
      outcome: "denied",
      detail: "只能对涉及自己的判断提出申诉",
    });
    throw new ServiceError(403, "forbidden", "只能对涉及自己的判断提出申诉");
  }
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw new ServiceError(422, "invalid_appeal", "申诉必须说明理由");
  }
  const appeal = {
    appeal_id: newId("appeal"),
    assessment_id: assessmentId,
    subject_ref: input.subject_ref,
    reason: input.reason,
    status: "submitted",
    created_at: nowIso(),
    resolved_at: null,
  };
  db.prepare(
    `INSERT INTO appeals(appeal_id, assessment_id, subject_ref, reason, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    appeal.appeal_id,
    appeal.assessment_id,
    appeal.subject_ref,
    appeal.reason,
    appeal.status,
    appeal.created_at,
    appeal.resolved_at,
  );
  appendAudit(db, {
    actor_ref: input.subject_ref,
    actor_role: "student",
    action: "appeal_create",
    target_ref: assessmentId,
    outcome: "allowed",
  });
  return appeal;
}

export function resolveAppeal(db, appealId, decision, actor) {
  requireRole(actor, ["counselor"]);
  if (!["upheld", "overturned"].includes(decision)) {
    throw new ServiceError(422, "invalid_decision", "复核结论必须是 upheld 或 overturned");
  }
  const appeal = db.prepare("SELECT * FROM appeals WHERE appeal_id = ?").get(appealId);
  if (!appeal) throw new ServiceError(404, "appeal_not_found", "申诉不存在");
  if (appeal.status === "upheld" || appeal.status === "overturned") {
    throw new ServiceError(409, "appeal_closed", "申诉已有复核结论");
  }
  const at = nowIso();
  db.prepare("UPDATE appeals SET status = ?, resolved_at = ? WHERE appeal_id = ?").run(
    decision,
    at,
    appealId,
  );
  if (decision === "overturned") {
    // 原判断保持不可变，仅关闭其触发的案件。
    db.prepare("UPDATE cases SET status = 'resolved' WHERE assessment_id = ?").run(
      appeal.assessment_id,
    );
  }
  appendAudit(db, {
    actor_ref: actor.ref,
    actor_role: actor.role,
    action: "appeal_resolve",
    target_ref: appealId,
    outcome: "allowed",
    detail: decision,
  });
  return { ...appeal, status: decision, resolved_at: at };
}

// ---------- 数据删除 ----------

const DELETION_STEPS = [
  "consent_closed",
  "events_erased",
  "assessments_anonymized",
  "cases_anonymized",
  "receipts_and_audit_retained",
];

export function requestDeletion(db, subjectRef, actor) {
  const isSelf = actor.role === "student" && actor.ref === subjectRef;
  const consent = latestConsent(db, subjectRef);
  const isGuardian = actor.role === "guardian" && consent?.guardian_ref === actor.ref;
  if (!isSelf && !isGuardian) {
    appendAudit(db, {
      actor_ref: actor.ref,
      actor_role: actor.role,
      action: "deletion_request",
      target_ref: subjectRef,
      outcome: "denied",
    });
    throw new ServiceError(403, "forbidden", "只有学生本人或登记的监护人可以申请删除");
  }
  const at = nowIso();
  const request = {
    deletion_id: newId("del"),
    subject_ref: subjectRef,
    status: "pending",
    steps: DELETION_STEPS.map((name) => ({ name, status: "pending", at: null, note: null })),
    requested_at: at,
    updated_at: at,
  };
  db.prepare(
    `INSERT INTO deletion_requests(deletion_id, subject_ref, status, steps, requested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    request.deletion_id,
    request.subject_ref,
    request.status,
    JSON.stringify(request.steps),
    request.requested_at,
    request.updated_at,
  );
  appendAudit(db, {
    actor_ref: actor.ref,
    actor_role: actor.role,
    action: "deletion_request",
    target_ref: subjectRef,
    outcome: "allowed",
  });
  return request;
}

export function getDeletion(db, deletionId) {
  const row = db.prepare("SELECT * FROM deletion_requests WHERE deletion_id = ?").get(deletionId);
  if (!row) throw new ServiceError(404, "deletion_not_found", "删除申请不存在");
  return { ...row, steps: JSON.parse(row.steps) };
}

function runDeletionStep(db, subjectRef, step) {
  const anonRef = `deleted:${sha256(subjectRef).slice(0, 16)}`;
  switch (step.name) {
    case "consent_closed":
      db.prepare(
        "UPDATE consents SET status = 'withdrawn', withdrawn_at = ? WHERE subject_ref = ? AND status = 'active'",
      ).run(nowIso(), subjectRef);
      return null;
    case "events_erased":
      // 判断记录引用事件行，物理删除会破坏可追溯性；
      // 这里抹除全部个人信息与指标，只留不含内容的墓碑行。
      db.prepare(
        "UPDATE events SET subject_ref = ?, metrics = '{}', payload_digest = 'erased:' || event_id WHERE subject_ref = ?",
      ).run(anonRef, subjectRef);
      return null;
    case "assessments_anonymized":
      db.prepare("UPDATE assessments SET subject_ref = ? WHERE subject_ref = ?").run(
        anonRef,
        subjectRef,
      );
      return null;
    case "cases_anonymized": {
      // 已经触发且尚未结案的紧急事件按法律与既定策略继续处理，不随删除中断。
      const openEmergency = db
        .prepare(
          "SELECT COUNT(*) AS n FROM cases WHERE subject_ref = ? AND level = 'emergency' AND status != 'resolved'",
        )
        .get(subjectRef).n;
      db.prepare("UPDATE cases SET subject_ref = ? WHERE subject_ref = ? AND NOT (level = 'emergency' AND status != 'resolved')").run(
        anonRef,
        subjectRef,
      );
      return openEmergency > 0 ? `保留 ${openEmergency} 件未结紧急事件直至处置完成` : null;
    }
    case "receipts_and_audit_retained":
      return "披露回执与审计日志不含谈话内容，按留存策略保留";
    default:
      return null;
  }
}

// 每调用一次推进一个步骤，让学生可以看到删除进度。
export function advanceDeletion(db, deletionId) {
  const request = getDeletion(db, deletionId);
  if (request.status === "completed") return request;
  const step = request.steps.find((item) => item.status === "pending");
  if (!step) {
    db.prepare("UPDATE deletion_requests SET status = 'completed', updated_at = ? WHERE deletion_id = ?").run(
      nowIso(),
      deletionId,
    );
    return getDeletion(db, deletionId);
  }
  step.note = runDeletionStep(db, request.subject_ref, step);
  step.status = "completed";
  step.at = nowIso();
  const done = request.steps.every((item) => item.status === "completed");
  db.prepare("UPDATE deletion_requests SET status = ?, steps = ?, updated_at = ? WHERE deletion_id = ?").run(
    done ? "completed" : "processing",
    JSON.stringify(request.steps),
    nowIso(),
    deletionId,
  );
  return getDeletion(db, deletionId);
}
