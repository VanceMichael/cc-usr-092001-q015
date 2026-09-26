import {
  ADULT_AGE,
  GUARDIAN_AGE,
  POLICY_VERSION,
  SCOPE_ROUTINE,
} from "./config.js";
import { ageAt, nowIso, parseIso } from "./util.js";
import { appendAudit } from "./audit.js";
import { ApiError } from "./errors.js";

export class ConsentError extends ApiError {
  constructor(message) {
    super("consent_invalid", message, 400);
    this.name = "ConsentError";
  }
}

export function registerSubject(db, { subjectRef, birthDate, displayPseudonym }) {
  const existing = db.prepare("SELECT 1 FROM subjects WHERE subject_ref = ?").get(subjectRef);
  if (existing) throw new ConsentError("主体编号已存在");
  db.prepare(
    "INSERT INTO subjects(subject_ref, birth_date, display_pseudonym, created_at) VALUES(?,?,?,?)",
  ).run(subjectRef, birthDate, displayPseudonym, nowIso());
}

export function addRelation(db, kind, { subjectRef, ref, label, classId }) {
  const now = nowIso();
  if (kind === "guardian") {
    db.prepare(
      `INSERT OR IGNORE INTO guardian_relations(subject_ref, guardian_ref, verified, created_at)
       VALUES(?,?,1,?)`,
    ).run(subjectRef, ref, now);
  } else if (kind === "teacher") {
    db.prepare(
      `INSERT OR IGNORE INTO teacher_relations(subject_ref, teacher_ref, class_id, active, created_at)
       VALUES(?,?,?,1,?)`,
    ).run(subjectRef, ref, classId ?? "default", now);
  } else if (kind === "trusted_adult") {
    db.prepare(
      `INSERT OR IGNORE INTO trusted_adults(subject_ref, adult_ref, label, active, created_at)
       VALUES(?,?,?,1,?)`,
    ).run(subjectRef, ref, label ?? "可信成年人", now);
  } else if (kind === "care_team") {
    db.prepare(
      `INSERT OR IGNORE INTO care_team(subject_ref, member_ref, role, active, created_at)
       VALUES(?,?,?,1,?)`,
    ).run(subjectRef, ref, label ?? "psychologist", now);
  } else {
    throw new ConsentError(`未知关系类型：${kind}`);
  }
}

// 同 scope 最新一行决定现状；历史行全部保留。
export function latestConsent(db, subjectRef, scope = SCOPE_ROUTINE) {
  return db
    .prepare(
      `SELECT * FROM consent_decisions WHERE subject_ref = ? AND scope = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(subjectRef, scope);
}

export function isGranted(db, subjectRef, scope = SCOPE_ROUTINE, atMs = Date.now()) {
  const row = latestConsent(db, subjectRef, scope);
  if (!row || row.decision !== "grant") return false;
  // 撤回之后发生的检查点不获授权（occurred_at 是真实决定时间，不是入库时间）。
  return parseIso(row.occurred_at) <= atMs;
}

// 记录一次同意决定，并校验决定人是否有资格（年龄 + 监护关系）。
export function recordConsent(db, input) {
  const {
    subjectRef,
    decision,
    decidedBy,
    actorRef,
    scope = SCOPE_ROUTINE,
    occurredAt = nowIso(),
  } = input;
  const subject = db
    .prepare("SELECT * FROM subjects WHERE subject_ref = ?")
    .get(subjectRef);
  if (!subject) throw new ConsentError("主体不存在");

  const age = ageAt(subject.birth_date, parseIso(occurredAt));
  const basis = validateAuthority(db, { subjectRef, decision, decidedBy, actorRef, age });

  db.prepare(
    `INSERT INTO consent_decisions
       (subject_ref, scope, decision, decided_by, actor_ref, age_at_decision, basis, policy_version, occurred_at, recorded_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    subjectRef,
    scope,
    decision,
    decidedBy,
    actorRef,
    age,
    basis,
    POLICY_VERSION,
    occurredAt,
    nowIso(),
  );
  appendAudit(db, {
    actorRef,
    actorRole: decidedBy === "guardian" ? "guardian" : "student",
    action: `consent.${decision}`,
    targetRef: subjectRef,
    result: "allow",
    detail: { scope, age, basis },
  });
  return { subjectRef, scope, decision, age, basis, occurredAt };
}

function validateAuthority(db, { subjectRef, decision, decidedBy, actorRef, age }) {
  if (!["grant", "revoke"].includes(decision)) throw new ConsentError("决定必须是 grant 或 revoke");
  if (!["student", "guardian"].includes(decidedBy)) throw new ConsentError("决定人身份非法");

  if (decidedBy === "guardian") {
    const rel = db
      .prepare(
        "SELECT 1 FROM guardian_relations WHERE subject_ref = ? AND guardian_ref = ? AND verified = 1",
      )
      .get(subjectRef, actorRef);
    if (!rel) throw new ConsentError("该监护人未经验证，不能代为决定");
    if (age >= ADULT_AGE) throw new ConsentError("学生已成年，监护同意不再适用");
    if (age < GUARDIAN_AGE) {
      return decision === "grant"
        ? `未满${GUARDIAN_AGE}周岁，由验证监护人代为同意`
        : `未满${GUARDIAN_AGE}周岁，监护人撤回同意`;
    }
    // 14–17 岁：授予需学生与监护人共同决定；撤回监护人一方即可提出。
    if (decision === "grant") {
      const studentRow = db
        .prepare(
          `SELECT decision FROM consent_decisions
            WHERE subject_ref=? AND scope=? AND decided_by='student'
            ORDER BY id DESC LIMIT 1`,
        )
        .get(subjectRef, SCOPE_ROUTINE);
      if (!studentRow || studentRow.decision !== "grant") {
        throw new ConsentError(`已满${GUARDIAN_AGE}周岁，需学生本人先同意，监护人同意方可共同生效`);
      }
      return `已满${GUARDIAN_AGE}周岁，学生与监护人共同同意`;
    }
    return `已满${GUARDIAN_AGE}周岁，监护人撤回（生效前应听取学生意见）`;
  }

  // 学生本人
  if (decision === "grant" && age < GUARDIAN_AGE) {
    throw new ConsentError(`未满${GUARDIAN_AGE}周岁，常规监测需监护人代为同意`);
  }
  if (age >= ADULT_AGE) return "成年学生自行同意";
  if (age >= GUARDIAN_AGE) {
    // 学生同意在 14–17 岁区间先登记，但需监护人共同同意后才生效（摄入侧查双方记录）。
    return decision === "grant"
      ? `已满${GUARDIAN_AGE}周岁，学生本人同意（待监护人共同同意生效）`
      : "学生本人撤回";
  }
  throw new ConsentError("不支持的决定情形");
}

// 14–17 岁要求双方都存在未被后续撤回覆盖的同意。
export function consentParties(db, subjectRef, atMs = Date.now()) {
  const subject = db.prepare("SELECT * FROM subjects WHERE subject_ref = ?").get(subjectRef);
  const age = subject ? ageAt(subject.birth_date, atMs) : null;
  const rows = db
    .prepare(
      `SELECT * FROM consent_decisions WHERE subject_ref = ? AND scope = ?
       ORDER BY id ASC`,
    )
    .all(subjectRef, SCOPE_ROUTINE);
  const latestBy = {};
  for (const row of rows) {
    if (parseIso(row.occurred_at) <= atMs) latestBy[row.decided_by] = row;
  }
  return { age, latestBy };
}

// 摄入侧使用的综合判定。
export function routineMonitoringAllowed(db, subjectRef, atMs = Date.now()) {
  const subject = db.prepare("SELECT * FROM subjects WHERE subject_ref = ?").get(subjectRef);
  if (!subject) return { allowed: false, reason: "subject_unknown" };
  // 已执行的数据删除请求具有终局效力：常规监测停止（紧急/求助由摄入侧另行放行）。
  const deletion = db
    .prepare(
      "SELECT 1 FROM deletion_requests WHERE subject_ref=? AND status='completed' LIMIT 1",
    )
    .get(subjectRef);
  if (deletion) return { allowed: false, age: ageAt(subject.birth_date, atMs), reason: "deletion_executed" };
  const age = ageAt(subject.birth_date, atMs);
  const { latestBy } = consentParties(db, subjectRef, atMs);
  const student = latestBy.student;
  const guardian = latestBy.guardian;

  if (age < GUARDIAN_AGE) {
    if (guardian?.decision === "grant") return { allowed: true, age, reason: "guardian_grant" };
    if (guardian?.decision === "revoke") return { allowed: false, age, reason: "consent_revoked" };
    return { allowed: false, age, reason: "guardian_consent_missing" };
  }
  if (age < ADULT_AGE) {
    // 任一方最新决定是撤回即停止；授予需要双方都授予。
    if (student?.decision === "revoke" || guardian?.decision === "revoke") {
      return { allowed: false, age, reason: "consent_revoked" };
    }
    if (student?.decision === "grant" && guardian?.decision === "grant") {
      return { allowed: true, age, reason: "joint_grant" };
    }
    return { allowed: false, age, reason: "joint_consent_incomplete" };
  }
  if (student?.decision === "grant") return { allowed: true, age, reason: "adult_self_grant" };
  return { allowed: false, age, reason: "self_consent_missing" };
}
