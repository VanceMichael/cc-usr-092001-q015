import http from "node:http";

import { appendAudit } from "./audit.js";
import { addRelation, recordConsent, registerSubject } from "./consent.js";
import {
  answerAppeal,
  authorizeEventAccess,
  fileAppeal,
  getDeletion,
  listAppeals,
  listEvents,
  mailbox,
  pumpOutbox,
  readEvent,
  recordReview,
  requestDeletion,
  explainEvent,
  ServiceError,
} from "./cases.js";
import { ingestSignal, IngestError } from "./ingest.js";
import { ApiError } from "./errors.js";

// 令牌在反代/部署层注入；缺省时仅允许本地开发（显式设置空串可关闭相关入口）。
export function createApp(db, { ingestToken = process.env.INGEST_TOKEN ?? "dev-ingest-token", adminToken = process.env.ADMIN_TOKEN ?? "dev-admin-token" } = {}) {
  return async function app(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://bridge.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const actorRef = req.headers["x-actor-ref"]?.toString();
    const actorRole = req.headers["x-actor-role"]?.toString();

    try {
      if (method === "GET" && path === "/health") {
        return send(200, { status: "ok" });
      }

      // 机器摄入入口：独立令牌，不接受人员角色令牌。
      if (method === "POST" && path === "/v1/signals") {
        if (!ingestToken || req.headers.authorization !== `Bearer ${ingestToken}`) {
          deny(send, db, actorRef ?? "ANONYMOUS", actorRole ?? "unknown", "signals.unauthorized", null);
          return send(401, { error: "unauthorized" });
        }
        const body = await readJson(req);
        const result = ingestSignal(db, body, { actorRef: "INGESTER" });
        // 摄入后立即驱动发件箱；若服务在此间重启，pending 行会在下次 pump 补发。
        const pumped = pumpOutbox(db);
        return send(202, { ...result, deliveries: pumped });
      }

      if (method === "POST" && path === "/v1/outbox/pump") {
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
          return send(401, { error: "unauthorized" });
        }
        return send(200, pumpOutbox(db));
      }

      // 以下端点全部需要人员身份。
      if (!actorRef || !actorRole) {
        deny(send, db, actorRef ?? "ANONYMOUS", actorRole ?? "unknown", "api.missing_identity", path);
        return send(401, { error: "identity_required" });
      }

      // 管理/建档端点。
      if (method === "POST" && path === "/v1/admin/subjects") {
        requireAdmin(req, adminToken, send, db, actorRef, actorRole, path);
        const body = await readJson(req);
        registerSubject(db, body);
        appendAudit(db, { actorRef, actorRole, action: "admin.subject_register", targetRef: body.subjectRef, result: "allow" });
        return send(201, { registered: body.subjectRef });
      }
      if (method === "POST" && path === "/v1/admin/relations") {
        requireAdmin(req, adminToken, send, db, actorRef, actorRole, path);
        const body = await readJson(req);
        addRelation(db, body.kind, {
          subjectRef: body.subject_ref, ref: body.ref, label: body.label, classId: body.class_id,
        });
        appendAudit(db, {
          actorRef, actorRole, action: `admin.relation_add.${body.kind}`,
          targetRef: body.subject_ref, result: "allow", detail: { ref: body.ref },
        });
        return send(201, { added: true });
      }
      if (method === "GET" && path === "/v1/admin/audit") {
        requireAdmin(req, adminToken, send, db, actorRef, actorRole, path);
        const { listAudit } = await import("./audit.js");
        return send(200, { entries: listAudit(db, { limit: Number(url.searchParams.get("limit") ?? 100) }) });
      }
      if (method === "POST" && path === "/v1/admin/audit/verify") {
        requireAdmin(req, adminToken, send, db, actorRef, actorRole, path);
        const { verifyAudit } = await import("./audit.js");
        const result = verifyAudit(db);
        appendAudit(db, { actorRef, actorRole, action: "admin.audit_verify", result: result.ok ? "allow" : "error", detail: result });
        return send(200, result);
      }

      // 同意决定：头部角色必须与决定人身份一致。
      if (method === "POST" && path === "/v1/consent") {
        const body = await readJson(req);
        if (body.decided_by !== actorRole || body.actor_ref !== actorRef) {
          deny(send, db, actorRef, actorRole, "consent.identity_mismatch", body.subject_ref ?? null);
          return send(403, { error: "身份与决定人不一致" });
        }
        const result = recordConsent(db, {
          subjectRef: body.subject_ref,
          decision: body.decision,
          decidedBy: body.decided_by,
          actorRef: body.actor_ref,
          scope: body.scope,
          occurredAt: body.occurred_at,
        });
        return send(201, result);
      }

      if (method === "GET" && path === "/v1/events") {
        return send(200, { events: listEvents(db, actorRole, actorRef) });
      }

      const eventMatch = /^\/v1\/events\/([A-Za-z0-9:_-]+)$/.exec(path);
      if (method === "GET" && eventMatch) {
        return send(200, readEvent(db, actorRole, actorRef, eventMatch[1]));
      }

      const reviewMatch = /^\/v1\/events\/([A-Za-z0-9:_-]+)\/review$/.exec(path);
      if (method === "POST" && reviewMatch) {
        if (actorRole !== "psychologist") {
          deny(send, db, actorRef, actorRole, "review.forbidden", reviewMatch[1]);
          return send(403, { error: "仅心理专业人员可复核" });
        }
        const body = await readJson(req);
        const result = recordReview(db, actorRef, reviewMatch[1], body);
        const pumped = pumpOutbox(db);
        return send(201, { ...result, deliveries: pumped });
      }

      const explainMatch = /^\/v1\/events\/([A-Za-z0-9:_-]+)\/explanation$/.exec(path);
      if (method === "GET" && explainMatch) {
        if (actorRole !== "student") return send(403, { error: "仅学生本人可查看说明" });
        return send(200, explainEvent(db, actorRef, explainMatch[1]));
      }

      const appealMatch = /^\/v1\/events\/([A-Za-z0-9:_-]+)\/appeal$/.exec(path);
      if (method === "POST" && appealMatch) {
        if (actorRole !== "student") return send(403, { error: "仅学生本人可申诉" });
        const body = await readJson(req);
        return send(201, fileAppeal(db, actorRef, appealMatch[1], body.statement));
      }

      if (method === "GET" && path === "/v1/appeals") {
        return send(200, { appeals: listAppeals(db, actorRole, actorRef, { subjectRef: url.searchParams.get("subject_ref") ?? undefined }) });
      }

      const appealAnswer = /^\/v1\/appeals\/(\d+)\/answer$/.exec(path);
      if (method === "POST" && appealAnswer) {
        if (actorRole !== "psychologist") return send(403, { error: "仅心理专业人员可应答申诉" });
        const body = await readJson(req);
        return send(200, answerAppeal(db, actorRef, Number(appealAnswer[1]), body));
      }

      if (method === "POST" && path === "/v1/me/deletion") {
        if (actorRole !== "student") return send(403, { error: "仅学生本人可申请删除" });
        return send(201, requestDeletion(db, actorRef));
      }
      if (method === "GET" && path === "/v1/me/deletion") {
        if (actorRole !== "student") return send(403, { error: "仅学生本人可查询删除进度" });
        return send(200, { deletion: getDeletion(db, actorRef) });
      }

      if (method === "GET" && path === "/v1/mailbox") {
        const eventId = url.searchParams.get("event_id");
        let notes = null;
        if (eventId) {
          const event = db.prepare("SELECT * FROM events WHERE event_id=?").get(eventId);
          if (!event || !authorizeEventAccess(db, actorRole, actorRef, event)) {
            deny(send, db, actorRef, actorRole, "mailbox.event_denied", eventId);
            return send(403, { error: "无权访问该事件；本次越权已留痕" });
          }
          notes = { event_id: eventId };
        }
        appendAudit(db, { actorRef, actorRole, action: "mailbox.read", targetRef: actorRef, result: "allow", detail: notes });
        return send(200, { mailbox: mailbox(db, actorRole, actorRef) });
      }

      return send(404, { error: "not_found" });
    } catch (err) {
      if (err instanceof ApiError) {
        return send(err.status, { error: err.code, message: err.message });
      }
      appendAudit(db, {
        actorRef: actorRef ?? "ANONYMOUS", actorRole: actorRole ?? "unknown",
        action: "api.error", targetRef: path, result: "error",
      });
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  };
}

function deny(send, db, actorRef, actorRole, action, targetRef) {
  appendAudit(db, { actorRef, actorRole, action, targetRef, result: "deny" });
}

function requireAdmin(req, adminToken, send, db, actorRef, actorRole, path) {
  if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}` || actorRole !== "admin") {
    deny(send, db, actorRef, actorRole, "admin.forbidden", path);
    const err = new ServiceError("forbidden", "需要管理员身份与令牌", 403);
    throw err;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new IngestError("payload_too_large", "请求体过大", 413));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new IngestError("invalid_json", "请求体不是合法 JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(db, options) {
  return http.createServer(createApp(db, options));
}
