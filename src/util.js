import crypto from "node:crypto";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value) {
  return "sha256:" + sha256(canonicalJson(value));
}

// 稳定序列化：键排序、无多余空白，保证同一语义内容摘要一致（去重指纹依赖它）。
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// 以带偏移量的 ISO 8601 字符串解析毫秒时间戳；非法输入抛错。
export function parseIso(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`非法时间格式：${value}`);
  return ms;
}

export function ageAt(birthDate /* YYYY-MM-DD */, atMs = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!m) throw new Error(`非法出生日期：${birthDate}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let age = new Date(atMs).getUTCFullYear() - d.getUTCFullYear();
  const beforeBirthday =
    new Date(atMs).getUTCMonth() < d.getUTCMonth() ||
    (new Date(atMs).getUTCMonth() === d.getUTCMonth() &&
      new Date(atMs).getUTCDate() < d.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function daysBetween(fromIso, toMs = Date.now()) {
  return Math.floor((toMs - parseIso(fromIso)) / 86_400_000);
}
