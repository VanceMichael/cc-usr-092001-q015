import {
  GUARDIAN_RECOMMENDATION,
  LEVELS,
  ROLE_EVENT_FIELDS,
  TEACHER_ACTION,
  WELFARE_BAND,
} from "./config.js";

// 按角色白名单投影事件。投影是唯一允许对外返回事件数据的出口：
// 不在白名单中的列永远不会出现在载荷里，保证“升级不暴露多余内容”。
export function projectEvent(db, eventId, role) {
  const event = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) return null;
  return projectEventRow(db, event, role);
}

export function projectEventRow(db, event, role) {
  const allowed = ROLE_EVENT_FIELDS[role];
  if (!allowed) throw new Error(`未知角色：${role}`);

  const full = buildFullView(db, event);
  const out = {};
  for (const key of allowed) out[key] = full[key];
  return out;
}

function buildFullView(db, e) {
  const level = Number(e.level_code);
  const evaluations = db
    .prepare(
      `SELECT level_code, rule_version, detector_version, feature_schema, reasons, confidence, evaluated_at
       FROM event_evaluations WHERE event_id = ? ORDER BY id`,
    )
    .all(e.event_id)
    .map((row) => ({
      ...row,
      level_code: Number(row.level_code),
      reasons: JSON.parse(row.reasons),
    }));

  const sentActions = db
    .prepare(
      `SELECT DISTINCT esc.action, esc.created_at
         FROM escalations esc JOIN disclosures d ON d.escalation_id = esc.id
        WHERE d.event_id = ? AND d.status = 'sent'
       UNION
       SELECT 'self_reminder', d.sent_at FROM disclosures d
        WHERE d.event_id = ? AND d.recipient_role = 'student' AND d.status = 'sent'
        ORDER BY 2`,
    )
    .all(e.event_id, e.event_id);

  const appeal = db
    .prepare("SELECT id, status FROM appeals WHERE event_id = ? ORDER BY id DESC LIMIT 1")
    .get(e.event_id);

  return {
    event_id: e.event_id,
    subject_ref: e.subject_ref,
    family: e.family,
    family_label: JSON.parse(e.facts).family_label,
    level_code: LEVELS[level].code,
    level_label: LEVELS[level].label,
    status: e.status,
    reasons: JSON.parse(e.reasons),
    features: JSON.parse(e.features),
    confidence: e.confidence,
    detector_version: e.detector_version,
    feature_schema: e.feature_schema,
    rule_version: e.rule_version,
    first_occurred_at: e.first_occurred_at,
    last_occurred_at: e.last_occurred_at,
    signal_count: e.signal_count,
    evaluations,
    welfare_band: WELFARE_BAND[level],
    headline: e.headline,
    facts: summarizeForStudent(e),
    recommendation: GUARDIAN_RECOMMENDATION[level] ?? defaultRecommendation(level),
    suggested_school_action: TEACHER_ACTION[level] ?? null,
    contact_status: contactStatus(db, e.event_id),
    actions_taken: sentActions.map((a) => ({ action: a.action, at: a.created_at })),
    options: studentOptions(appeal),
    created_at: e.created_at,
    updated_at: e.last_occurred_at,
  };
}

function summarizeForStudent(e) {
  const facts = JSON.parse(e.facts);
  return {
    family_label: facts.family_label,
    level_label: facts.level_label,
    points: facts.points,
  };
}

function defaultRecommendation(level) {
  if (level === 1) return "系统已向孩子发送自我提醒；暂无需要您采取的行动。";
  if (level === 3) return "心理专业人员正在复核，请等待心理中心与您联系。";
  return null;
}

function contactStatus(db, eventId) {
  const rows = db
    .prepare(
      `SELECT recipient_role, status FROM disclosures WHERE event_id = ?`,
    )
    .all(eventId);
  const summary = {};
  for (const row of rows) {
    // 仅统计已完成触达：pending 不反映“联系状态”，且保证派发时载荷快照稳定可复算。
    if (row.status === "sent") summary[row.recipient_role] = "已联系";
  }
  return summary;
}

export function studentOptions(appeal) {
  const options = ["request_explanation", "appeal", "request_deletion"];
  if (appeal) options.push(`appeal_${appeal.status}`);
  return options;
}

export function fieldsForRole(role) {
  return ROLE_EVENT_FIELDS[role] ?? null;
}
