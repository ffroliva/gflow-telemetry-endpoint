export interface Env {
  DB: D1Database;
  STOPPED?: string;
  [key: string]: unknown;
}

type KeyKind = "surface" | "key" | "toolResult";

const VALID_SURFACES = new Set(["cli", "mcp"]);
const VALID_OS = new Set(["windows", "linux", "darwin", "other"]);
const VALID_ARCH = new Set(["x86_64", "arm64", "other"]);
const VALID_INSTALLER = new Set(["uv", "pipx", "pip", "other"]);
const VALID_INSTALL_AGE = new Set(["<1w", "<1m", "<6m", "6m+"]);
const VALID_STORAGE = new Set(["local", "s3", "gcs", "other"]);

const SCALAR_VALIDATORS: Record<string, (v: string) => boolean> = {
  version: (v) => /^[0-9A-Za-z.+-]{1,32}$/.test(v),
  python: (v) => /^\d+\.\d+$/.test(v),
  os: (v) => VALID_OS.has(v),
  arch: (v) => VALID_ARCH.has(v),
  installer: (v) => VALID_INSTALLER.has(v),
  install_age: (v) => VALID_INSTALL_AGE.has(v),
  storage: (v) => VALID_STORAGE.has(v),
};

const SHAPES: Record<string, readonly KeyKind[]> = {
  commands: ["surface", "key"],
  flags: ["surface", "key", "key"],
  exits: ["surface", "key", "key"],
  durations: ["surface", "key", "key"],
  crashes: ["surface", "key"],
  tools: ["key", "toolResult"],
  transitions: ["key"],
  models: ["key"],
  modes: ["key"],
  aspects: ["key"],
  outcomes: ["key"],
  mcp_clients: ["key"],
};

const ALLOWED_KEYS = new Set([
  "schema",
  "report_id",
  "week",
  ...Object.keys(SCALAR_VALIDATORS),
  ...Object.keys(SHAPES),
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidKey(k: string): boolean {
  return typeof k === "string" && k.length >= 1 && k.length <= 200 && !k.includes("|");
}

function isValidCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1_000_000;
}

const KEY_VALIDATORS: Record<KeyKind, (k: string) => boolean> = {
  surface: (k) => VALID_SURFACES.has(k),
  key: isValidKey,
  toolResult: (k) => k === "expanded" || k === "unchanged",
};

interface Leaf {
  field: string;
  path: string[];
  key: string;
  n: number;
}

function walkShape(
  field: string,
  val: unknown,
  shape: readonly KeyKind[],
  path: string[],
  leaves: Leaf[],
): boolean {
  if (!isPlainObject(val)) return false;
  const depth = path.length;
  const validator = KEY_VALIDATORS[shape[depth]];
  const isLeafLevel = depth === shape.length - 1;

  for (const [k, child] of Object.entries(val)) {
    if (!validator(k)) return false;
    if (isLeafLevel) {
      if (!isValidCount(child)) return false;
      const childPath = [...path, k];
      leaves.push({ field, path: childPath, key: childPath.join("|"), n: child });
    } else if (!walkShape(field, child, shape, [...path, k], leaves)) {
      return false;
    }
  }
  return true;
}

function getIsoYearAndWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return { year, week };
}

function validateWeek(weekStr: string, nowMs: number): boolean {
  const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return false;
  const [year, week] = [parseInt(match[1], 10), parseInt(match[2], 10)];
  if (week < 1 || week > 53) return false;

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Mon = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() || 7) - 1)));
  const targetMon = new Date(week1Mon.getTime() + (week - 1) * 7 * 86400000);

  const actual = getIsoYearAndWeek(targetMon);
  if (actual.year !== year || actual.week !== week) return false;

  const serverDate = new Date(nowMs);
  const sDay = serverDate.getUTCDay() || 7;
  const serverMonMs = Date.UTC(
    serverDate.getUTCFullYear(),
    serverDate.getUTCMonth(),
    serverDate.getUTCDate() - (sDay - 1),
  );
  const diffWeeks = Math.round((targetMon.getTime() - serverMonMs) / (7 * 86400000));
  return diffWeeks <= 1 && diffWeeks >= -60;
}

export async function handle(request: Request, env: Env, nowMs: number = Date.now()): Promise<Response> {
  if (env.STOPPED !== undefined && env.STOPPED !== "0") {
    return new Response("Gone", { status: 410 });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/v1/report") return new Response("Not Found", { status: 404 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const clHeader = request.headers.get("content-length");
  if (clHeader !== null && parseInt(clHeader, 10) > 16384) {
    return new Response("Payload Too Large", { status: 413 });
  }

  let rawBody = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > 16384) {
        try { await reader.cancel(); } catch {}
        return new Response("Payload Too Large", { status: 413 });
      }
      rawBody += decoder.decode(value, { stream: true });
    }
    rawBody += decoder.decode();
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!isPlainObject(body)) return new Response("Bad Request", { status: 400 });

  if (
    Object.keys(body).some((k) => !ALLOWED_KEYS.has(k)) ||
    body.schema !== 1 ||
    typeof body.report_id !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(body.report_id) ||
    typeof body.week !== "string" ||
    !validateWeek(body.week, nowMs)
  ) {
    return new Response("Bad Request", { status: 400 });
  }

  for (const [field, validator] of Object.entries(SCALAR_VALIDATORS)) {
    const v = body[field];
    if (v !== undefined && (typeof v !== "string" || !validator(v))) {
      return new Response("Bad Request", { status: 400 });
    }
  }

  const leaves: Leaf[] = [];
  for (const [field, shape] of Object.entries(SHAPES)) {
    const val = body[field];
    if (val !== undefined && !walkShape(field, val, shape, [], leaves)) {
      return new Response("Bad Request", { status: 400 });
    }
  }

  const nowSec = Math.floor(nowMs / 1000);
  const seen = await env.DB.prepare("SELECT expires FROM seen WHERE report_id = ?")
    .bind(body.report_id)
    .first<{ expires: number }>();

  if (seen && seen.expires > nowSec) {
    return new Response(null, { status: 204 });
  }

  const totalsMap = new Map<string, number>();
  function add(field: string, key: string, count: number) {
    if (count <= 0) return;
    const mapKey = `${field}\0${key}`;
    totalsMap.set(mapKey, (totalsMap.get(mapKey) ?? 0) + count);
  }

  add("reports", "all", 1);
  const cf = (request as unknown as { cf?: { country?: unknown } }).cf;
  const country =
    typeof cf?.country === "string" && /^[A-Z]{2}$/i.test(cf.country)
      ? cf.country.toUpperCase()
      : "XX";
  add("country", country, 1);
  if (typeof body.os === "string" && typeof body.install_age === "string") {
    add("x:os_install_age", `${body.os}|${body.install_age}`, 1);
  }

  for (const field of Object.keys(SCALAR_VALIDATORS)) {
    const v = body[field];
    if (typeof v === "string") add(field, v, 1);
  }

  // Counter leaves and exit crosses in one pass.
  // Note: "x:surface_command_exit" equals exits, already covered as a base field.
  for (const leaf of leaves) {
    add(leaf.field, leaf.key, leaf.n);
    if (leaf.field === "exits") {
      const [, cmd, code] = leaf.path;
      if (typeof body.os === "string") add("x:os_exit", `${body.os}|${code}`, leaf.n);
      if (typeof body.version === "string") add("x:version_exit", `${body.version}|${code}`, leaf.n);
      if (typeof body.storage === "string") add("x:storage_exit", `${body.storage}|${code}`, leaf.n);
      if (typeof body.installer === "string" && cmd === "update") {
        add("x:installer_update_exit", `${body.installer}|${code}`, leaf.n);
      }
    }
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM seen WHERE expires <= ?").bind(nowSec),
    env.DB.prepare(
      "INSERT INTO seen (report_id, expires) VALUES (?, ?) ON CONFLICT(report_id) DO UPDATE SET expires = excluded.expires",
    ).bind(body.report_id, nowSec + 14 * 86400),
  ];

  const upsertTotal = env.DB.prepare(
    "INSERT INTO totals (week, field, key, n) VALUES (?, ?, ?, ?) ON CONFLICT(week, field, key) DO UPDATE SET n = totals.n + excluded.n",
  );
  for (const [mapKey, n] of totalsMap) {
    const sep = mapKey.indexOf("\0");
    stmts.push(upsertTotal.bind(body.week, mapKey.slice(0, sep), mapKey.slice(sep + 1), n));
  }

  try {
    await env.DB.batch(stmts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/limit|exceeded|too many|quota/i.test(msg)) {
      const serverDate = new Date(nowMs);
      const nextMidnightUtc = Date.UTC(
        serverDate.getUTCFullYear(),
        serverDate.getUTCMonth(),
        serverDate.getUTCDate() + 1,
      );
      const retryAfter = Math.ceil((nextMidnightUtc - nowMs) / 1000) + 60;
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(retryAfter) },
      });
    }
    return new Response("Service Unavailable", { status: 503 });
  }

  return new Response(null, { status: 204 });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handle(request, env);
  },
};
