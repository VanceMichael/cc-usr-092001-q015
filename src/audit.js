import { canonicalJson, newId, nowIso, sha256 } from "./util.js";

const GENESIS = "GENESIS";

// 追加一条审计记录，并与上一条形成哈希链。
// detail 不落明文，只存规范摘要，避免审计库本身成为敏感内容副本。
export function appendAudit(db, entry) {
  const ts = nowIso();
  const prev = db
    .prepare("SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1")
    .get();
  const prevHash = prev?.entry_hash ?? GENESIS;
  const detailDigest = entry.detail === undefined ? null : `sha256:${sha256(canonicalJson(entry.detail))}`;
  const body = {
    ts,
    actor_ref: entry.actorRef,
    actor_role: entry.actorRole,
    action: entry.action,
    target_ref: entry.targetRef ?? null,
    result: entry.result,
    detail_digest: detailDigest,
    prev_hash: prevHash,
  };
  const entryHash = `sha256:${sha256(canonicalJson(body))}`;
  const info = db
    .prepare(
      `INSERT INTO audit_log(ts, actor_ref, actor_role, action, target_ref, result, detail_digest, prev_hash, entry_hash)
       VALUES(:ts, :actor_ref, :actor_role, :action, :target_ref, :result, :detail_digest, :prev_hash, :entry_hash)`,
    )
    .run({ ...body, entry_hash: entryHash });
  return Number(info.lastInsertRowid);
}

// 重算整条链：任一行被删除、改写或缺位都会被发现。
export function verifyAudit(db) {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY seq").all();
  let prevHash = GENESIS;
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return { ok: false, brokenAt: row.seq, reason: "prev_hash 不连续" };
    }
    const body = {
      ts: row.ts,
      actor_ref: row.actor_ref,
      actor_role: row.actor_role,
      action: row.action,
      target_ref: row.target_ref,
      result: row.result,
      detail_digest: row.detail_digest,
      prev_hash: row.prev_hash,
    };
    const expect = `sha256:${sha256(canonicalJson(body))}`;
    if (expect !== row.entry_hash) {
      return { ok: false, brokenAt: row.seq, reason: "entry_hash 不匹配，记录疑似被改写" };
    }
    prevHash = row.entry_hash;
  }
  return { ok: true, entries: rows.length };
}

export function listAudit(db, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT seq, ts, actor_ref, actor_role, action, target_ref, result, detail_digest
       FROM audit_log ORDER BY seq DESC LIMIT ?`,
    )
    .all(limit);
}

export function auditSystem(db, action, detail) {
  return appendAudit(db, {
    actorRef: "SYSTEM",
    actorRole: "system",
    action,
    result: "system",
    detail,
  });
}

export function requestId() {
  return newId("REQ");
}
