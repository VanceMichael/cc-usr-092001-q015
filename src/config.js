// 策略配置：所有分级阈值、信号特征白名单、角色可见字段与说明模板集中在此，
// 规则本身带版本号（见 rules.js），配置变更不得影响已落库的历史判断。

export const POLICY_VERSION = "consent-policy-2026-09-01";

// 年龄（周岁）阈值：未满 GUARDIAN_AGE 需监护人同意；达到后学生本人同意即可。
export const GUARDIAN_AGE = 14;
export const ADULT_AGE = 18;

export const SCOPE_ROUTINE = "routine_monitoring";

// 撤回同意后，仅这两类信号仍可依据法律/紧急法理处理；其余一律拒收。
export const EMERGENCY_SIGNAL_TYPES = new Set(["urgent_event"]);
export const ALWAYS_ACCEPT_TYPES = new Set(["help_request"]);

// 紧急事件处置记录依法保留的期限（天）。删除请求到达时仍在持有期内的紧急事件只保留最小法律壳。
export const EMERGENCY_RETENTION_DAYS = 365 * 3;

export const LEVELS = {
  1: { code: "L1", label: "一般依赖", action: "self_reminder" },
  2: { code: "L2", label: "持续孤立", action: "contact_trusted_adult" },
  3: { code: "L3", label: "现实伤害线索", action: "professional_review" },
  4: { code: "L4", label: "紧急事件", action: "immediate_response" },
};

// 各处置动作默认触达的角色（具体到人时再结合 relations 选择已验证联系人）。
export const ACTION_TARGET_ROLES = {
  self_reminder: ["student"],
  contact_trusted_adult: ["trusted_adult", "guardian"],
  professional_review: ["psychologist"],
  immediate_response: ["psychologist", "guardian", "duty_teacher"],
};

// 同一主体、同一特征签名的信号在时间窗内归入同一未关闭事件（小时）。
export const DEDUP_WINDOW_HOURS = {
  usage_dependency: 24,
  social_isolation: 48,
  harm_cue: 12,
  urgent_event: 24 * 30,
  help_request: 2,
};

// 信号特征规格：仅允许以下字段，值只能是数值/布尔/受控枚举。
// 任何会话原文、自由文本字段在入口即被拒绝（见 ingest.js 的 PROHIBITED_KEYS）。
export const SIGNAL_SPEC = {
  usage_dependency: {
    features: {
      daily_minutes: "number",
      active_days_7d: "number",
      dependency_score: { number: [0, 1] },
    },
  },
  social_isolation: {
    features: {
      isolation_days: { number: [0, 365] },
      offline_contact_ratio: { number: [0, 1] },
      isolation_score: { number: [0, 1] },
    },
  },
  harm_cue: {
    features: {
      cue_category: { enum: ["self_harm", "harm_others"] },
      specificity: { enum: ["vague", "means", "plan", "attempt"] },
      recency_hours: { number: [0, 24 * 30] },
      cue_score: { number: [0, 1] },
    },
  },
  urgent_event: {
    features: {
      danger: { enum: ["in_progress", "attempt", "imminent_threat"] },
      means_present: "boolean",
    },
  },
  help_request: {
    features: {
      urgency: { enum: ["support", "talk", "urgent"] },
      topic: { enum: ["stress", "relationship", "study", "mood", "other"] },
    },
  },
};

export const FAMILY_LABEL = {
  usage_dependency: "智能陪伴使用时长",
  social_isolation: "持续孤立",
  harm_cue: "现实伤害线索",
  urgent_event: "紧急危险",
  help_request: "学生主动求助",
};

// 面向学生的可读原因模板（不含原始对话，也不暴露内部分数细节）。
export const REASON_TEXT = {
  dep_time: "最近设备上的陪伴使用时长明显偏高",
  dep_score: "本地评估显示依赖程度较高",
  iso_days: "已连续多日缺少线下人际接触",
  iso_score: "孤立状态持续且评分升高",
  harm_present: "出现了与现实伤害相关的线索类别",
  harm_specific: "线索包含较具体的伤害计划或手段",
  urgent_danger: "出现正在发生的紧迫危险信号",
  help_support: "你主动发来一次一般支持请求",
  help_talk: "你表示希望和可信的人谈一谈",
  help_urgent: "你发出了紧急求助",
};

// 角色字段白名单：所有读取与升级投递都必须投影到以下字段集合内。
// 不同角色看到的字段刻意不同；未列出的字段（如 features、reasons 明细）永不出现。
export const ROLE_EVENT_FIELDS = {
  student: [
    "event_id",
    "level_code",
    "level_label",
    "status",
    "family_label",
    "headline",
    "facts",
    "actions_taken",
    "options",
    "created_at",
  ],
  guardian: [
    "event_id",
    "subject_ref",
    "welfare_band",
    "family_label",
    "recommendation",
    "contact_status",
    "updated_at",
  ],
  teacher: [
    "subject_ref",
    "welfare_band",
    "suggested_school_action",
    "updated_at",
  ],
  psychologist: [
    "event_id",
    "subject_ref",
    "family",
    "level_code",
    "status",
    "reasons",
    "features",
    "confidence",
    "detector_version",
    "feature_schema",
    "rule_version",
    "first_occurred_at",
    "last_occurred_at",
    "signal_count",
    "evaluations",
  ],
};

// 可信成年人收到的字段与监护人视图一致（不含任何特征细节）；
// 值班教师与普通教师视图一致。键指向已定义的角色集合。
ROLE_EVENT_FIELDS.trusted_adult = ROLE_EVENT_FIELDS.guardian;
ROLE_EVENT_FIELDS.duty_teacher = ROLE_EVENT_FIELDS.teacher;

export const WELFARE_BAND = {
  1: "日常关注",
  2: "建议关心",
  3: "专业复核中",
  4: "紧急处置中",
};

export const GUARDIAN_RECOMMENDATION = {
  2: "建议在自然的场合主动关心孩子的近况，无需询问或调取其聊天内容。",
  4: "心理中心正在按紧急流程处置，请保持电话畅通并配合现场安全安排。",
};

export const TEACHER_ACTION = {
  2: "如该生今日到校，可进行一次日常问候；不要追问其与智能陪伴的对话。",
  3: "请留意该生在校状态，异常时联系心理中心；不向班级或其他家长扩散。",
  4: "请立即协助确认该生是否在校、是否安全，并按学校应急流程联系值班人员。",
};
