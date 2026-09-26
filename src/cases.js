import {
  EMERGENCY_RETENTION_DAYS,
  LEVELS,
  POLICY_VERSION,
} from "./config.js";
import { withTransaction } from "./db.js";
import { appendAudit } from "./audit.js";
import { ApiError } from "./errors.js";
import { dispatch } from "./ingest.js";
import { projectEventRow, studentOptions } from "./projection.js";
import { canonicalJson, daysBetween, nowIso, sha256 } from "./util.js";

export class ServiceError extends ApiError {
  constructor(code, message, status = 400) {
    super(code, message, status);
    this.name = "ServiceError";
  }
}

// ---------- 发件箱投递：崩溃/重启安全的仅一次投递 ----------

// 每个待投递披露在一个事务内完成“落入收件箱 + 翻转状态”。
// deliveries 以 disclosure_id 为主键：重启后重复 pump 时，已落箱的行不会产生第二封。
export function pumpOutbox(db) {
  const due = db
    .prepare(
      `SELECT o.id AS outbox_id, o.disclosure_id, d.event_id, d.recipient_ref, d.recipient_role, d.fields
         FROM outbox o JOIN disclosures d ON d.id = o.disclosure_id
        WHERE o.status = 'pending' AND o.run_after <= ?
        ORDER BY o.id`,
    )
    .all(nowIso());
  const sent = [];
  for (const row of due) {
    const outcome = withTransaction(db, () => {
      const already = db
        .prepare("SELECT 1 FROM deliveries WHERE disclosure_id = ?")
        .get(row.disclosure_id);
      if (already) {
        // 上次在落箱后、翻转前崩溃：事实已投递，只补齐状态。
        markSent(db, row);
        return "recovered";
      }
      const d = db.prepare("SELECT * FROM disclosures WHERE id = ?").get(row.disclosure_id);
      db.prepare(
        `INSERT INTO deliveries(disclosure_id, recipient_ref, recipient_role, channel, payload_digest, delivered_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(d.id, d.recipient_ref, d.recipient_role, channelFor(d.recipient_role), d.payload_digest, nowIso());
      markSent(db, row);
      return "sent";
    });
    sent.push({ disclosure_id: row.disclosure_id, recipient: row.recipient_role, outcome });
  }
  return { processed: due.length, sent };
}

function markSent(db, row) {
  const now = nowIso();
  db.prepare("UPDATE outbox SET status = 'sent', updated_at = ? WHERE id = ?").run(now, row.outbox_id);
  db.prepare("UPDATE disclosures SET status = 'sent', sent_at = ? WHERE id = ?").run(now, row.disclosure_id);
}

function channelFor(role) {
  if (role === "student") return "in_app_reminder";
  if (role === "psychologist") return "professional_queue";
  if (role === "duty_teacher") return "emergency_hotline";
  if (role === "guardian") return "guardian_mailbox";
  return "bridge_mailbox";
}

// 收件箱：各角色只能取走自己的通知，载荷即当时按其字段白名单生成的投影。
export function mailbox(db, role, actorRef) {
  const rows = db
    .prepare(
      `SELECT d.id, d.event_id, d.fields, d.payload_digest, dl.delivered_at
         FROM deliveries dl JOIN disclosures d ON d.id = dl.disclosure_id
        WHERE dl.recipient_role = ? AND dl.recipient_ref = ?
        ORDER BY d.id`,
    )
    .all(role, actorRef);
  return rows.map((r) => ({
    disclosure_id: r.id,
    event_id: r.event_id,
    fields: JSON.parse(r.fields),
    payload_digest: r.payload_digest,
    delivered_at: r.delivered_at,
  }));
}

// ---------- 访问授权：角色 + 关系双重校验 ----------

export function authorizeEventAccess(db, role, actorRef, event) {
  switch (role) {
    case "student":
      return event.subject_ref === actorRef;
    case "guardian": {
      // 监护人只能看到确实向其披露过的事件：
      // L1 自我提醒仅对学生；L2 若由学生指定的可信成年人承接也不扩散到监护人。
      const relation = db
        .prepare(
          "SELECT 1 FROM guardian_relations WHERE subject_ref=? AND guardian_ref=? AND verified=1",
        )
        .get(event.subject_ref, actorRef);
      if (!relation) return false;
      if (Number(event.level_code) === 1) return false;
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM disclosures WHERE event_id=? AND recipient_ref=? AND recipient_role='guardian'",
          )
          .get(event.event_id, actorRef),
      );
    }
    case "teacher":
      // L4 仅值班教师可见；普通教师只能看到 L2/L3。
      if (Number(event.level_code) === 4) return false;
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM teacher_relations WHERE subject_ref=? AND teacher_ref=? AND active=1",
          )
          .get(event.subject_ref, actorRef),
      );
    case "trusted_adult":
      // 仅当该事件确实向其披露（L2 联系动作）时可见。
      return Boolean(
        db
          .prepare(
            `SELECT 1 FROM disclosures WHERE event_id=? AND recipient_ref=? AND recipient_role='trusted_adult'`,
          )
          .get(event.event_id, actorRef),
      );
    case "duty_teacher":
      if (Number(event.level_code) !== 4) return false;
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM care_team WHERE subject_ref=? AND member_ref=? AND role='duty_teacher' AND active=1",
          )
          .get(event.subject_ref, actorRef),
      );
    case "psychologist": {
      const level = Number(event.level_code);
      const assigned =
        level >= 3 &&
        db
          .prepare(
            "SELECT 1 FROM care_team WHERE subject_ref=? AND member_ref=? AND role='psychologist' AND active=1",
          )
          .get(event.subject_ref, actorRef);
      if (assigned) return true;
      // 或该事件曾明确派发给此心理人员（如人工升级后的复核人）。
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM disclosures WHERE event_id=? AND recipient_ref=? AND recipient_role='psychologist'",
          )
          .get(event.event_id, actorRef),
      );
    }
    default:
      return false;
  }
}

// 读取事件：成功/失败都写审计；返回按角色投影后的字段。
export function readEvent(db, role, actorRef, eventId) {
  const event = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) {
    appendAudit(db, {
      actorRef, actorRole: role, action: "event.read_missing",
      targetRef: eventId, result: "deny",
    });
    throw new ServiceError("event_not_found", "事件不存在", 404);
  }
  if (!authorizeEventAccess(db, role, actorRef, event)) {
    appendAudit(db, {
      actorRef, actorRole: role, action: "event.read_denied",
      targetRef: eventId, result: "deny",
      detail: { subject_ref: event.subject_ref },
    });
    throw new ServiceError("forbidden", "无权访问该事件；本次越权已留痕", 403);
  }
  const view = projectEventRow(db, event, role);
  appendAudit(db, {
    actorRef, actorRole: role, action: "event.read",
    targetRef: eventId, result: "allow",
    detail: { fields: Object.keys(view), digest: sha256(canonicalJson(view)) },
  });
  return view;
}

export function listEvents(db, role, actorRef) {
  let rows;
  if (role === "student") {
    rows = db.prepare("SELECT * FROM events WHERE subject_ref=? ORDER BY rowid DESC").all(actorRef);
  } else if (role === "guardian") {
    rows = db
      .prepare(
        `SELECT DISTINCT e.* FROM events e
           JOIN guardian_relations g ON g.subject_ref = e.subject_ref
           JOIN disclosures d ON d.event_id = e.event_id
          WHERE g.guardian_ref=? AND g.verified=1
            AND d.recipient_ref=? AND d.recipient_role='guardian'
          ORDER BY e.rowid DESC`,
      )
      .all(actorRef, actorRef);
  } else if (role === "teacher") {
    rows = db
      .prepare(
        `SELECT e.* FROM events e JOIN teacher_relations t ON t.subject_ref = e.subject_ref
          WHERE t.teacher_ref=? AND t.active=1 AND e.level_code IN (2,3) ORDER BY e.rowid DESC`,
      )
      .all(actorRef);
  } else if (role === "psychologist") {
    rows = db
      .prepare(
        `SELECT e.* FROM events e JOIN care_team c ON c.subject_ref = e.subject_ref
          WHERE c.member_ref=? AND c.role='psychologist' AND c.active=1
            AND e.level_code >= 3
          ORDER BY e.rowid DESC`,
      )
      .all(actorRef);
  } else if (role === "duty_teacher" || role === "trusted_adult") {
    // 只列实际向其披露过的事件（值班教师=L4；可信成年人=L2）。
    rows = db
      .prepare(
        `SELECT DISTINCT e.* FROM events e JOIN disclosures d ON d.event_id = e.event_id
          WHERE d.recipient_ref=? AND d.recipient_role=? ORDER BY e.rowid DESC`,
      )
      .all(actorRef, role);
  } else {
    rows = [];
  }
  appendAudit(db, {
    actorRef, actorRole: role, action: "event.list",
    targetRef: actorRef, result: "allow", detail: { count: rows.length },
  });
  return rows.map((e) => projectEventRow(db, e, role));
}

// ---------- 人工复核与人工升级/降级 ----------

export function recordReview(db, actorRef, eventId, { decision, note, newLevel }) {
  const event = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) throw new ServiceError("event_not_found", "事件不存在", 404);
  // 复核必须由该学生照护团队中的心理人员执行；越权尝试留痕。
  if (!authorizeEventAccess(db, "psychologist", actorRef, event)) {
    appendAudit(db, {
      actorRef, actorRole: "psychologist", action: "review.denied",
      targetRef: eventId, result: "deny", detail: { subject_ref: event.subject_ref },
    });
    throw new ServiceError("forbidden", "无权复核该事件；本次越权已留痕", 403);
  }

  return withTransaction(db, () => {
    let resultingLevel = Number(event.level_code);
    if (decision === "confirm") resultingLevel = Number(event.level_code);
    if (decision === "close") {
      db.prepare("UPDATE events SET status='closed', closed_at=? WHERE event_id=?").run(nowIso(), eventId);
    }
    if (decision === "downgrade") {
      if (!Number.isInteger(newLevel) || newLevel < 1 || newLevel >= resultingLevel) {
        throw new ServiceError("invalid_level", "降级目标等级必须低于当前等级", 422);
      }
      resultingLevel = newLevel;
      db.prepare("UPDATE events SET level_code=? WHERE event_id=?").run(newLevel, eventId);
    }
    if (decision === "escalate") {
      if (!Number.isInteger(newLevel) || newLevel <= resultingLevel || newLevel > 4) {
        throw new ServiceError("invalid_level", "升级目标等级必须高于当前等级且不超过 4", 422);
      }
      resultingLevel = newLevel;
    }
    db.prepare(
      `INSERT INTO reviews(event_id, reviewer_ref, decision, resulting_level, note_digest, created_at)
       VALUES(?,?,?,?,?,?)`,
    ).run(eventId, actorRef, decision, resultingLevel, note ? `sha256:${sha256(note)}` : null, nowIso());

    if (decision === "escalate") {
      const fresh = db.prepare("SELECT * FROM events WHERE event_id=?").get(eventId);
      dispatch(db, fresh, {
        fromLevel: Number(event.level_code), toLevel: newLevel, trigger: "manual", actorRef,
      });
    }
    appendAudit(db, {
      actorRef, actorRole: "psychologist", action: `review.${decision}`,
      targetRef: eventId, result: "allow",
      detail: { resulting_level: resultingLevel, rule_version_at_open: event.rule_version },
    });
    return { decision, resulting_level: resultingLevel };
  });
}

// ---------- 学生：可理解决定说明 ----------

export function explainEvent(db, actorRef, eventId) {
  const event = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) throw new ServiceError("event_not_found", "事件不存在", 404);
  if (event.subject_ref !== actorRef) {
    appendAudit(db, {
      actorRef, actorRole: "student", action: "explanation.denied",
      targetRef: eventId, result: "deny",
    });
    throw new ServiceError("forbidden", "只能查看本人事件的说明", 403);
  }
  const evaluation = db
    .prepare("SELECT * FROM event_evaluations WHERE event_id=? ORDER BY id LIMIT 1")
    .get(eventId);
  const explanation = {
    event_id: eventId,
    headline: event.headline,
    what_happened: JSON.parse(event.facts).points,
    data_used: [
      "你设备端在本地算出的使用特征（如使用分钟数）",
      "本地风险评估输出的类别与置信程度",
      "你主动发起的求助类型",
    ],
    data_not_used: ["你的聊天原文不会上传，也无法被任何人在本系统中查看"],
    decided_by: `规则版本 ${event.rule_version}（评估器版本 ${event.detector_version}）`,
    version_promise: "本判断永久按当时的规则版本呈现，后续算法升级不会改写它。",
    action_taken: LEVELS[event.level_code].label + " → " + LEVELS[event.level_code].action,
    your_options: studentOptions(
      db.prepare("SELECT id FROM appeals WHERE event_id=? ORDER BY id DESC LIMIT 1").get(eventId),
    ),
    option_labels: {
      request_explanation: "查看本次决定的详细说明",
      appeal: "如认为判断有误，可以发起申诉",
      request_deletion: "申请删除你的常规监测数据",
      emergency_help: "紧急情况下使用一键求助",
    },
    first_occurred_at: event.first_occurred_at,
    detector_version: event.detector_version,
    rule_version: evaluation.rule_version,
  };
  appendAudit(db, {
    actorRef, actorRole: "student", action: "explanation.read",
    targetRef: eventId, result: "allow",
  });
  return explanation;
}

// ---------- 申诉 ----------

export function fileAppeal(db, actorRef, eventId, statement) {
  const event = db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId);
  if (!event) throw new ServiceError("event_not_found", "事件不存在", 404);
  if (event.subject_ref !== actorRef) throw new ServiceError("forbidden", "只能对本人事件申诉", 403);
  if (typeof statement !== "string" || statement.trim().length < 2) {
    throw new ServiceError("invalid_appeal", "申诉说明过短", 422);
  }
  const info = db
    .prepare(
      `INSERT INTO appeals(event_id, subject_ref, statement_text, status, created_at)
       VALUES(?,?,?,'pending',?)`,
    )
    .run(eventId, actorRef, statement.trim(), nowIso());
  appendAudit(db, {
    actorRef, actorRole: "student", action: "appeal.file",
    targetRef: eventId, result: "allow", detail: { appeal_id: Number(info.lastInsertRowid) },
  });
  return { appeal_id: Number(info.lastInsertRowid), status: "pending" };
}

export function answerAppeal(db, reviewerRef, appealId, { accept, response }) {
  const appeal = db.prepare("SELECT * FROM appeals WHERE id=?").get(appealId);
  if (!appeal) throw new ServiceError("appeal_not_found", "申诉不存在", 404);
  const event = db.prepare("SELECT * FROM events WHERE event_id=?").get(appeal.event_id);
  // 申诉应答是心理人员的独立职责：对其照护名单内学生的任何级别事件均可处理，
  // 不要求该事件曾以 L3+ 派发给本人（L1/L2 事件学生同样有权申诉）。
  const assigned = db
    .prepare(
      "SELECT 1 FROM care_team WHERE subject_ref=? AND member_ref=? AND role='psychologist' AND active=1",
    )
    .get(event.subject_ref, reviewerRef);
  if (!assigned) {
    appendAudit(db, {
      actorRef: reviewerRef, actorRole: "psychologist", action: "appeal.answer_denied",
      targetRef: appeal.event_id, result: "deny",
    });
    throw new ServiceError("forbidden", "无权应答该申诉", 403);
  }
  const status = accept ? "answered" : "rejected";
  db.prepare(
    "UPDATE appeals SET status=?, response_text=?, responded_by_ref=?, responded_at=? WHERE id=?",
  ).run(status, response ?? null, reviewerRef, nowIso(), appealId);
  if (accept) {
    // 接受申诉 = 人工复核关闭该事件（关闭后同指纹可重新开始计数）。
    db.prepare("UPDATE events SET status='closed', closed_at=? WHERE event_id=?").run(nowIso(), appeal.event_id);
  }
  appendAudit(db, {
    actorRef: reviewerRef, actorRole: "psychologist", action: "appeal.answer",
    targetRef: appeal.event_id, result: "allow", detail: { status },
  });
  return { appeal_id: appealId, status };
}

export function listAppeals(db, role, actorRef, { subjectRef } = {}) {
  if (role === "student") {
    return db
      .prepare(
        `SELECT id, event_id, status, created_at, responded_at, response_text
           FROM appeals WHERE subject_ref=? ORDER BY id DESC`,
      )
      .all(actorRef);
  }
  if (role === "psychologist") {
    return db
      .prepare(
        `SELECT a.id, a.event_id, a.subject_ref, a.status, a.created_at, a.statement_text
           FROM appeals a JOIN care_team c ON c.subject_ref = a.subject_ref
          WHERE c.member_ref=:actorRef AND c.role='psychologist' AND c.active=1
            AND (:subjectRef IS NULL OR a.subject_ref = :subjectRef)
          ORDER BY a.id DESC`,
      )
      .all({ actorRef, subjectRef: subjectRef ?? null });
  }
  throw new ServiceError("forbidden", "该角色不能查看申诉列表", 403);
}

// ---------- 数据删除：常规数据清除 + 紧急事件最小法律壳 + 进度 ----------

export function requestDeletion(db, actorRef) {
  const subject = db.prepare("SELECT * FROM subjects WHERE subject_ref=?").get(actorRef);
  if (!subject) throw new ServiceError("subject_not_found", "主体不存在", 404);
  return withTransaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM deletion_requests WHERE subject_ref=? ORDER BY id DESC LIMIT 1")
      .get(actorRef);
    if (existing && existing.status !== "completed") {
      return existing;
    }
    const info = db
      .prepare(
        `INSERT INTO deletion_requests(subject_ref, status, progress, created_at, updated_at)
         VALUES(?, 'processing', 0, ?, ?)`,
      )
      .run(actorRef, nowIso(), nowIso());
    const reqId = Number(info.lastInsertRowid);

    // 步骤 1：撤回常规监测同意（法律上删除请求即停止后续常规处理）。
    db.prepare(
      `INSERT INTO consent_decisions(subject_ref, scope, decision, decided_by, actor_ref, age_at_decision, basis, policy_version, occurred_at, recorded_at)
       VALUES(?, 'routine_monitoring', 'revoke', 'student', ?, NULL, '数据删除请求同时撤回常规监测同意', ?, ?, ?)`,
    ).run(actorRef, actorRef, POLICY_VERSION, nowIso(), nowIso());
    bumpProgress(db, reqId, 20);

    const allEvents = db.prepare("SELECT * FROM events WHERE subject_ref=?").all(actorRef);
    const retained = [];
    const purgeIds = [];
    for (const e of allEvents) {
      const ageDays = daysBetween(e.created_at);
      const hold = e.level_code === 4 && ageDays < EMERGENCY_RETENTION_DAYS;
      if (hold) {
        retained.push(e.event_id);
      } else {
        purgeIds.push(e.event_id);
      }
    }

    // 步骤 2：清除常规/已过期事件的信号原文特征与评估明细。
    for (const id of purgeIds) {
      db.prepare("DELETE FROM signals WHERE event_id=?").run(id);
      db.prepare("DELETE FROM event_evaluations WHERE event_id=?").run(id);
      db.prepare(
        `UPDATE events SET features='{}', reasons='[]', facts='{}', headline='(已删除)',
           confidence=0, detector_version='erased', signal_fingerprint='erased:'||event_id
         WHERE event_id=?`,
      ).run(id);
    }
    bumpProgress(db, reqId, 55);

    // 步骤 3：紧急事件保留最小法律壳：去掉所有特征/理由/信号，仅留等级、状态、时间、法律依据。
    for (const id of retained) {
      db.prepare("DELETE FROM signals WHERE event_id=?").run(id);
      db.prepare("DELETE FROM event_evaluations WHERE event_id=?").run(id);
      db.prepare(
        `UPDATE events SET features='{}', reasons='[]', facts='{}', headline='(依法最小保留)',
           confidence=0, detector_version='erased'
         WHERE event_id=?`,
      ).run(id);
    }
    bumpProgress(db, reqId, 80);

    // 步骤 4：删除常规事件的披露载荷投影（收件箱条目保留状态，字段摘要置空）。
    // 学生行使删除权时，其本人提供的申诉原文一并擦除（专业答复作为处置记录保留）。
    db.prepare("UPDATE appeals SET statement_text='(已删除)' WHERE subject_ref=?").run(actorRef);
    const ph = purgeIds.map(() => "?").join(",");
    if (purgeIds.length) {
      db.prepare(
        `UPDATE disclosures SET fields='[]', payload_digest='sha256:erased' WHERE event_id IN (${ph})`,
      ).run(...purgeIds);
      db.prepare(
        `UPDATE deliveries SET payload_digest='sha256:erased'
          WHERE disclosure_id IN (SELECT id FROM disclosures WHERE event_id IN (${ph}))`,
      ).run(...purgeIds);
    }
    bumpProgress(db, reqId, 95);

    const holdUntil = retained.length
      ? new Date(Date.now() + EMERGENCY_RETENTION_DAYS * 86_400_000).toISOString()
      : null;
    db.prepare(
      `UPDATE deletion_requests SET status='completed', progress=100, routine_purged_at=?,
         retained_event_ids=?, legal_hold_until=?, updated_at=? WHERE id=?`,
    ).run(
      nowIso(),
      canonicalJson(retained),
      holdUntil,
      nowIso(),
      reqId,
    );
    appendAudit(db, {
      actorRef, actorRole: "student", action: "deletion.completed",
      targetRef: actorRef, result: "allow",
      detail: { purged: purgeIds.length, retained_count: retained.length },
    });
    return getDeletion(db, actorRef);
  });
}

function bumpProgress(db, reqId, progress) {
  db.prepare("UPDATE deletion_requests SET progress=?, updated_at=? WHERE id=?").run(progress, nowIso(), reqId);
}

export function getDeletion(db, actorRef) {
  const row = db
    .prepare("SELECT * FROM deletion_requests WHERE subject_ref=? ORDER BY id DESC LIMIT 1")
    .get(actorRef);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    routine_purged_at: row.routine_purged_at,
    retained_event_ids: JSON.parse(row.retained_event_ids),
    legal_hold_until: row.legal_hold_until,
    updated_at: row.updated_at,
  };
}
