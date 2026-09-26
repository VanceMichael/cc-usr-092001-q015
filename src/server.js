import http from "node:http";
import path from "node:path";

import { openDatabase } from "./db.js";
import {
  ServiceError,
  activateRuleSet,
  advanceDeletion,
  caseProof,
  createAppeal,
  getDeletion,
  ingestEvent,
  listAudit,
  registerConsent,
  requestDeletion,
  resolveAppeal,
  verifyAuditChain,
  viewCase,
  withdrawConsent,
} from "./service.js";

export function healthPayload() {
  return { status: "ok" };
}

function actorFrom(request) {
  return {
    ref: request.headers["x-actor-ref"] ?? "anonymous",
    role: request.headers["x-actor-role"] ?? "anonymous",
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ServiceError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

export function createServer(db) {
  const routes = [
    ["GET", /^\/health$/, () => [200, healthPayload()]],
    ["POST", /^\/consents$/, (body) => [201, registerConsent(db, body)]],
    ["POST", /^\/consents\/(?<id>[^/]+)\/withdraw$/, (body, match, actor) => [
      200,
      withdrawConsent(db, match.groups.id, actor),
    ]],
    ["POST", /^\/rulesets$/, (body, _match, actor) => [201, activateRuleSet(db, body, actor)]],
    ["POST", /^\/events$/, (body) => {
      const result = ingestEvent(db, body);
      return [result.status === "dropped" ? 202 : 201, result];
    }],
    ["GET", /^\/cases\/(?<id>[^/]+)$/, (_body, match, actor) => [
      200,
      viewCase(db, match.groups.id, actor),
    ]],
    ["GET", /^\/cases\/(?<id>[^/]+)\/proof$/, (_body, match, actor) => [
      200,
      caseProof(db, match.groups.id, actor),
    ]],
    ["POST", /^\/assessments\/(?<id>[^/]+)\/appeals$/, (body, match) => [
      201,
      createAppeal(db, match.groups.id, body),
    ]],
    ["POST", /^\/appeals\/(?<id>[^/]+)\/resolve$/, (body, match, actor) => [
      200,
      resolveAppeal(db, match.groups.id, body.decision, actor),
    ]],
    ["POST", /^\/subjects\/(?<ref>[^/]+)\/deletions$/, (_body, match, actor) => [
      201,
      requestDeletion(db, match.groups.ref, actor),
    ]],
    ["GET", /^\/deletions\/(?<id>[^/]+)$/, (_body, match) => [200, getDeletion(db, match.groups.id)]],
    ["POST", /^\/deletions\/(?<id>[^/]+)\/advance$/, (_body, match) => [
      200,
      advanceDeletion(db, match.groups.id),
    ]],
    ["GET", /^\/audit$/, (_body, _match, actor) => [200, listAudit(db, actor)]],
    ["GET", /^\/audit\/verify$/, (_body, _match, actor) => {
      if (!["counselor", "admin"].includes(actor.role)) {
        throw new ServiceError(403, "forbidden", "当前角色无权执行此操作");
      }
      return [200, verifyAuditChain(db)];
    }],
  ];

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      for (const [method, pattern, handler] of routes) {
        const match = pattern.exec(url.pathname);
        if (request.method === method && match) {
          const body = method === "GET" ? {} : await readBody(request);
          const [status, payload] = handler(body, match, actorFrom(request));
          sendJson(response, status, payload);
          return;
        }
      }
      response.writeHead(404).end();
    } catch (error) {
      if (error instanceof ServiceError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal", message: "服务内部错误" });
      }
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const databasePath =
    process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.sqlite3");
  createServer(openDatabase(databasePath)).listen(port, "0.0.0.0");
}
