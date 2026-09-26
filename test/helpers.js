import { openDatabase } from "../src/db.js";
import { addRelation, recordConsent, registerSubject } from "../src/consent.js";

export function freshDb() {
  return openDatabase(":memory:");
}

export function iso(minutesAgo = 0) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

// 建立三名学生：
// - S_CHILD 2014 年生（<14，监护人 G_CHILD 代决）
// - S_TEEN  2010 年生（14–17，学生与监护人 G_TEEN 共同决定）
// - S_ADULT 2006 年生（成年，自决）
// 并登记监护人、教师、可信成年人、心理人员、值班教师关系。
export function setupWorld(db, { consent = true } = {}) {
  registerSubject(db, { subjectRef: "S_CHILD", birthDate: "2014-03-01", displayPseudonym: "幼" });
  registerSubject(db, { subjectRef: "S_TEEN", birthDate: "2010-06-01", displayPseudonym: "少" });
  registerSubject(db, { subjectRef: "S_ADULT", birthDate: "2006-01-01", displayPseudonym: "成" });

  for (const [s, g] of [
    ["S_CHILD", "G_CHILD"],
    ["S_TEEN", "G_TEEN"],
    ["S_ADULT", "G_ADULT"],
  ]) {
    addRelation(db, "guardian", { subjectRef: s, ref: g });
    addRelation(db, "teacher", { subjectRef: s, ref: "T_" + s, classId: "C1" });
    addRelation(db, "trusted_adult", { subjectRef: s, ref: "A_" + s, label: "亲属" });
    addRelation(db, "care_team", { subjectRef: s, ref: "P_" + s, label: "psychologist" });
    addRelation(db, "care_team", { subjectRef: s, ref: "D_" + s, label: "duty_teacher" });
  }

  if (consent) {
    // 同意回填到 7 天前：保证测试信号（发生在数分钟前）在时间点门控时已获授权。
    const grantedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
    recordConsent(db, { subjectRef: "S_CHILD", decision: "grant", decidedBy: "guardian", actorRef: "G_CHILD", occurredAt: grantedAt });
    recordConsent(db, { subjectRef: "S_TEEN", decision: "grant", decidedBy: "student", actorRef: "S_TEEN", occurredAt: grantedAt });
    recordConsent(db, { subjectRef: "S_TEEN", decision: "grant", decidedBy: "guardian", actorRef: "G_TEEN", occurredAt: grantedAt });
    recordConsent(db, { subjectRef: "S_ADULT", decision: "grant", decidedBy: "student", actorRef: "S_ADULT", occurredAt: grantedAt });
  }
}

let seq = 1;
export function signal(over = {}) {
  const subjectRef = over.subjectRef ?? "S_CHILD";
  return {
    signal_id: `SIG-${seq}-${Math.random().toString(16).slice(2, 8)}`,
    source_id: `DEV-${subjectRef}`,
    source_sequence: seq++,
    subject_ref: subjectRef,
    signal_type: over.signal_type ?? "usage_dependency",
    feature_schema: over.feature_schema,
    detector_version: "detector-2026.09.1",
    occurred_at: over.occurred_at ?? iso(over.minutesAgo ?? 1),
    features: over.features,
    ...over.extra,
  };
}

export const FEATURES = {
  dep_high: { daily_minutes: 300, active_days_7d: 7, dependency_score: 0.9 },
  dep_low: { daily_minutes: 30, active_days_7d: 2, dependency_score: 0.1 },
  iso_long: { isolation_days: 30, offline_contact_ratio: 0.05, isolation_score: 0.9 },
  iso_short: { isolation_days: 3, offline_contact_ratio: 0.5, isolation_score: 0.2 },
  harm_plan: { cue_category: "self_harm", specificity: "plan", recency_hours: 2, cue_score: 0.9 },
  harm_vague: { cue_category: "self_harm", specificity: "vague", recency_hours: 2, cue_score: 0.3 },
  urgent: { danger: "in_progress", means_present: true },
  help_talk: { urgency: "talk", topic: "mood" },
  help_support: { urgency: "support", topic: "study" },
  help_urgent: { urgency: "urgent", topic: "mood" },
};
