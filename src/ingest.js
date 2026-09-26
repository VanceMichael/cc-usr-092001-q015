import {
  ALWAYS_ACCEPT_TYPES,
  DEDUP_WINDOW_HOURS,
  EMERGENCY_RETENTION_DAYS,
  FAMILY_LABEL,
  LEVELS,
  SIGNAL_SPEC,
} from "./config.js";
import { ApiError } from "./errors.js";
import { withTransaction } from "./db.js";
import { routineMonitoringAllowed } from "./consent.js";
import { CURRENT_RULE_VERSION, evaluateSignal } from "./rules.js";
import { appendAudit } from "./audit.js";
import { projectEventRow } from "./projection.js";
import {
  canonicalJson,
  newId,
  nowIso,
  parseIso,
  sha256,
} from "./util.js";

export class IngestError extends ApiError {
  constructor(code, message, status = 400) {
    super(code, message, status);
    this.name = "IngestError";
  }
}

// 入口硬黑名单：任何疑似原文/自由文本字段直接拒收，不入库、不落盘。
const PROHIBITED_KEYS = [
  "message", "messages", "text", "content", "conversation", "transcript",
  "chat", "utterance", "dialogue", "raw", "raw_text", "prompt", "reply",
  "snippet", "body",
];

export function validateSignal(input) {
  const errors = [];
  for (const k of ["signal_id", "source_id", "source_sequence", "subject_ref", "signal_type", "occurred_at"]) {
    if (input[k] === undefined) errors.push(`缺少字段 ${k}`);
  }
  if (input.signal_id !== undefined && typeof input.signal_id !== "string") errors.push("signal_id 必须是字符串");
  if (input.source_id !== undefined && typeof input.source_id !== "string") errors.push("source_id 必须是字符串");
  if (!Number.isInteger(input.source_sequence)) errors.push("source_sequence 必须是整数");
  if (input.subject_ref !== undefined && typeof input.subject_ref !== "string") errors.push("subject_ref 必须是字符串");
  let occurredMs = null;
  try {
    if (input.occurred_at !== undefined) occurredMs = parseIso(input.occurred_at);
  } catch {
    errors.push("occurred_at 必须是带偏移量的 ISO 8601 时间");
  }
  if (occurredMs !== null && occurredMs > Date.now() + 60_000) errors.push("occurred_at 不能是未来时间");

  const spec = SIGNAL_SPEC[input.signal_type];
  if (!spec) {
    errors.push(`未知 signal_type：${input.signal_type}`);
    return { errors };
  }

  const features = input.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    errors.push("features 必须是对象");
    return { errors };
  }
  for (const key of Object.keys(features)) {
    if (PROHIBITED_KEYS.includes(key.toLowerCase())) {
      throw new IngestError("prohibited_content", `禁止提交可还原谈话的字段：${key}`, 422);
    }
  }
  const clean = {};
  for (const [key, rule] of Object.entries(spec.features)) {
    if (features[key] === undefined) {
      errors.push(`features 缺少 ${key}`);
      continue;
    }
    const v = features[key];
    if (rule === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${key} 必须是数值`);
      else clean[key] = v;
    } else if (rule === "boolean") {
      if (typeof v !== "boolean") errors.push(`${key} 必须是布尔值`);
      else clean[key] = v;
    } else if (rule.enum) {
      if (!rule.enum.includes(v)) errors.push(`${key} 必须是 ${rule.enum.join("/")} 之一`);
      else clean[key] = v;
    } else if (rule.number) {
      const [min, max] = rule.number;
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
        errors.push(`${key} 必须是 ${min} 到 ${max} 之间的数值`);
      } else clean[key] = v;
    }
  }
  const unknown = Object.keys(features).filter((k) => !(k in spec.features));
  if (unknown.length) errors.push(`存在未登记的特征字段：${unknown.join(", ")}`);

  return { errors, features: clean, occurredMs };
}

// 摄入一条信号。返回 { outcome, ... }：
// - duplicate：来源序号重复，幂等忽略
// - ignored_below_threshold：规则未达到分级，仅留信号、不建事件
// - accepted：并入既有事件或新建事件
// - rejected_consent：撤回后非常规信号，拒收
export function ingestSignal(db, raw, { actorRef = "INGESTER" } = {}) {
  let checked;
  try {
    checked = validateSignal(raw);
  } catch (err) {
    if (err instanceof IngestError) {
      appendAudit(db, {
        actorRef, actorRole: "ingester", action: "signal.reject_prohibited",
        targetRef: raw.subject_ref ?? null, result: "deny", detail: { reason: err.code },
      });
    }
    throw err;
  }
  if (checked.errors.length) throw new IngestError("invalid_signal", checked.errors.join("；"), 400);
  const { features, occurredMs } = checked;

  const subject = db.prepare("SELECT * FROM subjects WHERE subject_ref = ?").get(raw.subject_ref);
  if (!subject) throw new IngestError("subject_unknown", "主体不存在", 404);

  // 第一层去重：同一来源的同一序号。
  const seen = db
    .prepare("SELECT signal_id, event_id FROM signals WHERE source_id = ? AND source_sequence = ?")
    .get(raw.source_id, raw.source_sequence);
  if (seen) {
    appendAudit(db, {
      actorRef, actorRole: "ingester", action: "signal.duplicate_source_seq",
      targetRef: raw.subject_ref, result: "allow",
      detail: { source_id: raw.source_id, source_sequence: raw.source_sequence },
    });
    return { outcome: "duplicate", signal_id: seen.signal_id, event_id: seen.event_id };
  }

  const isEmergency = raw.signal_type === "urgent_event";
  const isHelp = ALWAYS_ACCEPT_TYPES.has(raw.signal_type);
  const gate = routineMonitoringAllowed(db, raw.subject_ref, occurredMs);
  if (!gate.allowed && !isEmergency && !isHelp) {
    appendAudit(db, {
      actorRef, actorRole: "ingester", action: "signal.reject_no_consent",
      targetRef: raw.subject_ref, result: "deny",
      detail: { signal_type: raw.signal_type, reason: gate.reason },
    });
    return { outcome: "rejected_consent", reason: gate.reason };
  }

  const detectorVersion = raw.detector_version ?? "unknown";
  const featureSchema = raw.feature_schema ?? `${raw.signal_type}@1`;
  const payloadDigest = raw.payload_digest ?? `sha256:${sha256(canonicalJson({ ...raw, received_note: undefined }))}`;

  const signalId = raw.signal_id;
  const receivedAt = nowIso();

  const verdict = evaluateSignal(raw.signal_type, features, raw.rule_version ?? CURRENT_RULE_VERSION);

  const result = withTransaction(db, () => {
    db.prepare(
      `INSERT INTO signals(signal_id, source_id, source_sequence, subject_ref, family, signal_type,
         features, feature_schema, detector_version, occurred_at, received_at, payload_digest, event_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).run(
      signalId, raw.source_id, raw.source_sequence, raw.subject_ref,
      raw.signal_type, raw.signal_type, canonicalJson(features), featureSchema,
      detectorVersion, raw.occurred_at, receivedAt, payloadDigest,
    );

    if (!verdict) {
      appendAudit(db, {
        actorRef, actorRole: "ingester", action: "signal.below_threshold",
        targetRef: raw.subject_ref, result: "allow", detail: { signal_id: signalId },
      });
      return { outcome: "ignored_below_threshold", signal_id: signalId };
    }

    // 第二层去重：同主体 + 同特征语义指纹，在去重时间窗内的未关闭事件。
    // 指纹按时间窗分桶：窗外重复属于新的发作（新 episode），允许建立新事件。
    const windowHours = DEDUP_WINDOW_HOURS[raw.signal_type] ?? 24;
    const bucket = Math.floor(occurredMs / (windowHours * 3_600_000));
    const fingerprint = fingerprintFor(raw.subject_ref, raw.signal_type, features, bucket);
    const existing = db
      .prepare(
        `SELECT * FROM events WHERE subject_ref = ? AND signal_fingerprint = ?
           AND status IN ('open','escalated')
           AND last_occurred_at >= ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(raw.subject_ref, fingerprint, new Date(occurredMs - windowHours * 3_600_000).toISOString());

    let event;
    if (existing) {
      event = existing;
      // 重复信号并入同一事件：只追加计数、时间与一次版本快照，不产生新事件。
      // 分级取最高（只升不降）；降级只能由人工复核完成。
      const newLevel = Math.max(Number(event.level_code), verdict.level);
      db.prepare(
        `UPDATE events SET last_occurred_at = ?, signal_count = signal_count + 1,
           level_code = ?, status = CASE WHEN ? > level_code THEN 'escalated' ELSE status END
         WHERE event_id = ?`,
      ).run(raw.occurred_at, newLevel, verdict.level, event.event_id);
      db.prepare("UPDATE signals SET event_id = ? WHERE signal_id = ?").run(event.event_id, signalId);
      appendEvaluation(db, { event, signalId, verdict, features, detectorVersion, featureSchema });
      if (newLevel > Number(event.level_code)) {
        dispatch(db, reloadEvent(db, event.event_id), {
          fromLevel: Number(event.level_code), toLevel: newLevel, trigger: "auto", actorRef,
        });
      } else {
        appendAudit(db, {
          actorRef, actorRole: "ingester", action: "signal.dedup_merge",
          targetRef: raw.subject_ref, result: "allow",
          detail: { event_id: event.event_id, signal_id: signalId },
        });
      }
      return {
        outcome: "accepted", merged: true, signal_id: signalId,
        event_id: event.event_id, level: newLevel,
      };
    }

    // 新建事件。
    const eventId = newId("EVT");
    const legalBasis = isEmergency ? "emergency" : isHelp ? "student_request" : "consent";
    const facts = studentFacts(raw.signal_type, features, verdict);
    const now = nowIso();
    db.prepare(
      `INSERT INTO events(event_id, subject_ref, family, signal_fingerprint, level_code,
         rule_version, detector_version, feature_schema, status, legal_basis,
         reasons, features, confidence, headline, facts,
         first_occurred_at, last_occurred_at, signal_count, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    ).run(
      eventId, raw.subject_ref, raw.signal_type, fingerprint, verdict.level,
      raw.rule_version ?? CURRENT_RULE_VERSION, detectorVersion, featureSchema,
      "open", legalBasis, canonicalJson(verdict.reasons), canonicalJson(features),
      verdict.confidence, facts.headline, canonicalJson(facts),
      raw.occurred_at, raw.occurred_at, now,
    );
    db.prepare("UPDATE signals SET event_id = ? WHERE signal_id = ?").run(eventId, signalId);
    const created = reloadEvent(db, eventId);
    appendEvaluation(db, { event: created, signalId, verdict, features, detectorVersion, featureSchema });
    dispatch(db, created, { fromLevel: null, toLevel: verdict.level, trigger: "open", actorRef });
    return {
      outcome: "accepted", merged: false, signal_id: signalId,
      event_id: eventId, level: verdict.level, legal_basis: legalBasis,
    };
  });

  return result;
}

function reloadEvent(db, eventId) {
  return db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
}

function appendEvaluation(db, { event, signalId, verdict, features, detectorVersion, featureSchema }) {
  db.prepare(
    `INSERT INTO event_evaluations(event_id, signal_id, level_code, rule_version,
       detector_version, feature_schema, reasons, features, confidence, evaluated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    event.event_id, signalId, verdict.level,
    verdict.ruleVersion ?? event.rule_version, detectorVersion, featureSchema,
    canonicalJson(verdict.reasons), canonicalJson(features), verdict.confidence, nowIso(),
  );
}

function fingerprintFor(subjectRef, type, features, bucket) {
  // 不含时间与计数：同一语义、同一时间窗分桶内的重复信号共享指纹。
  return sha256(canonicalJson({ s: subjectRef, t: type, f: features, b: bucket }));
}

function studentFacts(type, features, verdict) {
  const label = FAMILY_LABEL[type];
  const points = verdict.reasons.map((r) => r.text);
  const headline = `【${label}】${LEVELS[verdict.level].label}`;
  return { headline, family_label: label, level_label: LEVELS[verdict.level].label, points };
}

// 分级 → 动作 → 最小字段披露。所有外发行先进 disclosures/outbox（事务内），
// 由投递器在事务外翻转状态：崩溃后 pending 继续投，已 sent 绝不重投。
export function dispatch(db, event, { fromLevel, toLevel, trigger, actorRef }) {
  const action = LEVELS[toLevel].action;
  const now = nowIso();
  const escInfo = db.prepare(
    `INSERT INTO escalations(event_id, from_level, to_level, action, decided_by_role, decided_by_ref, rationale, created_at)
     VALUES(?,?,?,?,'system',NULL,?,?)`,
  ).run(
    event.event_id, fromLevel, toLevel, action,
    trigger === "open" ? `信号达到 ${LEVELS[toLevel].code}，首次建立事件` : `信号达到更高等级 ${LEVELS[toLevel].code}，自动升级`,
    now,
  );
  const escalationId = Number(escInfo.lastInsertRowid);

  const recipients = resolveRecipients(db, event, action);
  // 先在披露行落库前为每个收件人生成载荷快照，保证摘要只取决于事件与白名单，
  // 与落库顺序、投递进度无关（可被复核者逐字节复算）。
  const planned = recipients.map((recipient) => {
    const payload = projectEventRow(db, event, recipient.role);
    return {
      recipient,
      payload,
      fields: Object.keys(payload),
      digest: `sha256:${sha256(canonicalJson(payload))}`,
    };
  });
  for (const { recipient, fields, digest } of planned) {
    const dInfo = db.prepare(
      `INSERT INTO disclosures(event_id, escalation_id, recipient_ref, recipient_role, fields, payload_digest, status, created_at)
       VALUES(?,?,?,?,?,?,'pending',?)`,
    ).run(event.event_id, escalationId, recipient.ref, recipient.role, canonicalJson(fields), digest, now);
    db.prepare(
      `INSERT INTO outbox(disclosure_id, channel, status, run_after, created_at, updated_at)
       VALUES(?,?,'pending',?,?,?)`,
    ).run(Number(dInfo.lastInsertRowid), recipient.channel, now, now, now);
  }
  appendAudit(db, {
    actorRef, actorRole: "ingester",
    action: fromLevel === null ? "event.open" : "event.escalate",
    targetRef: event.event_id, result: "allow",
    detail: {
      event_id: event.event_id, level: toLevel, action,
      recipients: recipients.map((r) => ({ role: r.role, ref: r.ref })),
      rule_version: event.rule_version,
    },
  });
}

function resolveRecipients(db, event, action) {
  const out = [];
  const add = (role, ref, channel = "bridge_mailbox") => {
    if (ref && !out.some((o) => o.role === role && o.ref === ref)) {
      out.push({ role, ref, channel });
    }
  };

  if (action === "self_reminder") {
    add("student", event.subject_ref, "in_app_reminder");
    return out;
  }

  if (action === "contact_trusted_adult") {
    add("student", event.subject_ref, "in_app_reminder");
    const adults = db
      .prepare("SELECT adult_ref FROM trusted_adults WHERE subject_ref = ? AND active = 1")
      .all(event.subject_ref);
    for (const a of adults) add("trusted_adult", a.adult_ref);
    if (adults.length === 0) {
      const g = db
        .prepare("SELECT guardian_ref FROM guardian_relations WHERE subject_ref = ? AND verified = 1 LIMIT 1")
        .get(event.subject_ref);
      if (g) add("guardian", g.guardian_ref);
    }
    return out;
  }

  if (action === "professional_review") {
    const psy = db
      .prepare("SELECT member_ref FROM care_team WHERE subject_ref = ? AND role = 'psychologist' AND active = 1")
      .all(event.subject_ref);
    for (const p of psy) add("psychologist", p.member_ref, "professional_queue");
    return out;
  }

  if (action === "immediate_response") {
    add("student", event.subject_ref, "in_app_reminder");
    for (const p of db
      .prepare("SELECT member_ref FROM care_team WHERE subject_ref = ? AND role = 'psychologist' AND active = 1")
      .all(event.subject_ref)) {
      add("psychologist", p.member_ref, "professional_queue");
    }
    for (const p of db
      .prepare("SELECT member_ref FROM care_team WHERE subject_ref = ? AND role = 'duty_teacher' AND active = 1")
      .all(event.subject_ref)) {
      add("duty_teacher", p.member_ref, "emergency_hotline");
    }
    for (const g of db
      .prepare("SELECT guardian_ref FROM guardian_relations WHERE subject_ref = ? AND verified = 1")
      .all(event.subject_ref)) {
      add("guardian", g.guardian_ref, "emergency_hotline");
    }
    return out;
  }
  return out;
}
