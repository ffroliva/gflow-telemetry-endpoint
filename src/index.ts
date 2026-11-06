export interface Env {
  DB: D1Database;
  STOPPED?: string;
  [key: string]: unknown;
}

const ALLOWED_KEYS = new Set([
  "schema",
  "report_id",
  "week",
  "version",
  "python",
  "os",
  "arch",
  "installer",
  "install_age",
  "storage",
  "commands",
  "flags",
  "exits",
  "durations",
  "transitions",
  "models",
  "modes",
  "aspects",
  "outcomes",
  "mcp_clients",
  "crashes",
  "tools",
]);

const VALID_SURFACES = new Set(["cli", "mcp"]);
const VALID_OS = new Set(["windows", "linux", "darwin", "other"]);
const VALID_ARCH = new Set(["x86_64", "arm64", "other"]);
const VALID_INSTALLER = new Set(["uv", "pipx", "pip", "other"]);
const VALID_INSTALL_AGE = new Set(["<1w", "<1m", "<6m", "6m+"]);
const VALID_STORAGE = new Set(["local", "s3", "gcs", "other"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidKey(k: string): boolean {
  return typeof k === "string" && k.length >= 1 && k.length <= 200 && !k.includes("|");
}

function isValidCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1_000_000;
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
  const year = parseInt(match[1], 10);
  const week = parseInt(match[2], 10);
  if (week < 1 || week > 53) return false;

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(Date.UTC(year, 0, 4 - (jan4Day - 1)));
  const targetMonday = new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);

  const actual = getIsoYearAndWeek(targetMonday);
  if (actual.year !== year || actual.week !== week) {
    return false;
  }

  const serverDate = new Date(nowMs);
  const sDay = serverDate.getUTCDay() || 7;
  const serverMondayMs = Date.UTC(
    serverDate.getUTCFullYear(),
    serverDate.getUTCMonth(),
    serverDate.getUTCDate() - (sDay - 1),
    0, 0, 0
  );

  const diffWeeks = Math.round((targetMonday.getTime() - serverMondayMs) / (7 * 86400000));
  if (diffWeeks > 1 || diffWeeks < -60) {
    return false;
  }

  return true;
}

export async function handle(request: Request, env: Env, nowMs: number = Date.now()): Promise<Response> {
  // Server-side stop: any value other than "0" answers 410 to every request, before reading the body.
  if (env.STOPPED !== undefined && env.STOPPED !== "0") {
    return new Response("Gone", { status: 410 });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/v1/report") {
    return new Response("Not Found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Cap Content-Length header if present
  const clHeader = request.headers.get("content-length");
  if (clHeader !== null) {
    const len = parseInt(clHeader, 10);
    if (!isNaN(len) && len > 16384) {
      return new Response("Payload Too Large", { status: 413 });
    }
  }

  // Stream body with 16384 bytes cap
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
        try {
          await reader.cancel();
        } catch {}
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

  if (!isPlainObject(body)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Disallow any key outside allow-list
  for (const k of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(k)) {
      return new Response("Bad Request", { status: 400 });
    }
  }

  // Validate required schema
  if (body.schema !== 1) {
    return new Response("Bad Request", { status: 400 });
  }

  // Validate required report_id
  if (typeof body.report_id !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(body.report_id)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Validate required week
  if (typeof body.week !== "string" || !validateWeek(body.week, nowMs)) {
    return new Response("Bad Request", { status: 400 });
  }

  // Validate scalar fields
  if (body.version !== undefined && (typeof body.version !== "string" || !/^[0-9A-Za-z.+-]{1,32}$/.test(body.version))) {
    return new Response("Bad Request", { status: 400 });
  }

  if (body.python !== undefined && (typeof body.python !== "string" || !/^\d+\.\d+$/.test(body.python))) {
    return new Response("Bad Request", { status: 400 });
  }

  if (body.os !== undefined && (typeof body.os !== "string" || !VALID_OS.has(body.os))) {
    return new Response("Bad Request", { status: 400 });
  }

  if (body.arch !== undefined && (typeof body.arch !== "string" || !VALID_ARCH.has(body.arch))) {
    return new Response("Bad Request", { status: 400 });
  }

  if (body.installer !== undefined && (typeof body.installer !== "string" || !VALID_INSTALLER.has(body.installer))) {
    return new Response("Bad Request", { status: 400 });
  }

  if (body.install_age !== undefined && (typeof body.install_age !== "string" || !VALID_INSTALL_AGE.has(body.install_age))) {
    return new Response("Bad Request", { status: 400 });
  }

  if (body.storage !== undefined && (typeof body.storage !== "string" || !VALID_STORAGE.has(body.storage))) {
    return new Response("Bad Request", { status: 400 });
  }

  // Validate commands (surface -> command -> n)
  if (body.commands !== undefined) {
    if (!isPlainObject(body.commands)) return new Response("Bad Request", { status: 400 });
    for (const [surface, cmds] of Object.entries(body.commands)) {
      if (!VALID_SURFACES.has(surface) || !isPlainObject(cmds)) return new Response("Bad Request", { status: 400 });
      for (const [cmd, n] of Object.entries(cmds)) {
        if (!isValidKey(cmd) || !isValidCount(n)) return new Response("Bad Request", { status: 400 });
      }
    }
  }

  // Validate flags (surface -> command -> flagKey -> n)
  if (body.flags !== undefined) {
    if (!isPlainObject(body.flags)) return new Response("Bad Request", { status: 400 });
    for (const [surface, cmds] of Object.entries(body.flags)) {
      if (!VALID_SURFACES.has(surface) || !isPlainObject(cmds)) return new Response("Bad Request", { status: 400 });
      for (const [cmd, flags] of Object.entries(cmds)) {
        if (!isValidKey(cmd) || !isPlainObject(flags)) return new Response("Bad Request", { status: 400 });
        for (const [flag, n] of Object.entries(flags)) {
          if (!isValidKey(flag) || !isValidCount(n)) return new Response("Bad Request", { status: 400 });
        }
      }
    }
  }

  // Validate exits (surface -> command -> code -> n)
  if (body.exits !== undefined) {
    if (!isPlainObject(body.exits)) return new Response("Bad Request", { status: 400 });
    for (const [surface, cmds] of Object.entries(body.exits)) {
      if (!VALID_SURFACES.has(surface) || !isPlainObject(cmds)) return new Response("Bad Request", { status: 400 });
      for (const [cmd, codes] of Object.entries(cmds)) {
        if (!isValidKey(cmd) || !isPlainObject(codes)) return new Response("Bad Request", { status: 400 });
        for (const [code, n] of Object.entries(codes)) {
          if (!isValidKey(code) || !isValidCount(n)) return new Response("Bad Request", { status: 400 });
        }
      }
    }
  }

  // Validate durations (surface -> command -> bucket -> n)
  if (body.durations !== undefined) {
    if (!isPlainObject(body.durations)) return new Response("Bad Request", { status: 400 });
    for (const [surface, cmds] of Object.entries(body.durations)) {
      if (!VALID_SURFACES.has(surface) || !isPlainObject(cmds)) return new Response("Bad Request", { status: 400 });
      for (const [cmd, buckets] of Object.entries(cmds)) {
        if (!isValidKey(cmd) || !isPlainObject(buckets)) return new Response("Bad Request", { status: 400 });
        for (const [bucket, n] of Object.entries(buckets)) {
          if (!isValidKey(bucket) || !isValidCount(n)) return new Response("Bad Request", { status: 400 });
        }
      }
    }
  }

  // Validate crashes (surface -> fingerprint -> n)
  if (body.crashes !== undefined) {
    if (!isPlainObject(body.crashes)) return new Response("Bad Request", { status: 400 });
    for (const [surface, fps] of Object.entries(body.crashes)) {
      if (!VALID_SURFACES.has(surface) || !isPlainObject(fps)) return new Response("Bad Request", { status: 400 });
      for (const [fp, n] of Object.entries(fps)) {
        if (!isValidKey(fp) || !isValidCount(n)) return new Response("Bad Request", { status: 400 });
      }
    }
  }

  // Validate tools (name -> { "expanded" | "unchanged": n })
  if (body.tools !== undefined) {
    if (!isPlainObject(body.tools)) return new Response("Bad Request", { status: 400 });
    for (const [tool, results] of Object.entries(body.tools)) {
      if (!isValidKey(tool) || !isPlainObject(results)) return new Response("Bad Request", { status: 400 });
      for (const [res, n] of Object.entries(results)) {
        if ((res !== "expanded" && res !== "unchanged") || !isValidCount(n)) {
          return new Response("Bad Request", { status: 400 });
        }
      }
    }
  }

  // Validate flat counter maps
  const flatMaps = [
    "transitions",
    "models",
    "modes",
    "aspects",
    "outcomes",
    "mcp_clients",
  ] as const;

  for (const field of flatMaps) {
    const map = body[field];
    if (map !== undefined) {
      if (!isPlainObject(map)) return new Response("Bad Request", { status: 400 });
      for (const [k, n] of Object.entries(map)) {
        if (!isValidKey(k) || !isValidCount(n)) return new Response("Bad Request", { status: 400 });
      }
    }
  }

  // Check duplicate report_id
  const nowSec = Math.floor(nowMs / 1000);
  const seen = await env.DB.prepare("SELECT expires FROM seen WHERE report_id = ?")
    .bind(body.report_id)
    .first<{ expires: number }>();

  if (seen && seen.expires > nowSec) {
    // Duplicate report_id in seen and not expired -> 204, nothing added
    return new Response(null, { status: 204 });
  }

  // Build increment list
  const totalsMap = new Map<string, number>();
  function add(field: string, key: string, count: number) {
    if (count <= 0) return;
    const mapKey = `${field}\0${key}`;
    totalsMap.set(mapKey, (totalsMap.get(mapKey) ?? 0) + count);
  }

  // 1 per report: reports/all
  add("reports", "all", 1);

  // Country: from request.cf?.country (2-letter or "XX"), field "country", 1 per report
  const cf = (request as unknown as { cf?: { country?: unknown } }).cf;
  const country =
    typeof cf?.country === "string" && /^[A-Z]{2}$/i.test(cf.country)
      ? cf.country.toUpperCase()
      : "XX";
  add("country", country, 1);

  // Scalar fields
  if (typeof body.version === "string") add("version", body.version, 1);
  if (typeof body.python === "string") add("python", body.python, 1);
  if (typeof body.os === "string") add("os", body.os, 1);
  if (typeof body.arch === "string") add("arch", body.arch, 1);
  if (typeof body.installer === "string") add("installer", body.installer, 1);
  if (typeof body.install_age === "string") add("install_age", body.install_age, 1);
  if (typeof body.storage === "string") add("storage", body.storage, 1);

  // Commands
  if (isPlainObject(body.commands)) {
    for (const [surface, cmds] of Object.entries(body.commands)) {
      if (isPlainObject(cmds)) {
        for (const [cmd, n] of Object.entries(cmds)) {
          if (typeof n === "number") add("commands", `${surface}|${cmd}`, n);
        }
      }
    }
  }

  // Flags
  if (isPlainObject(body.flags)) {
    for (const [surface, cmds] of Object.entries(body.flags)) {
      if (isPlainObject(cmds)) {
        for (const [cmd, flags] of Object.entries(cmds)) {
          if (isPlainObject(flags)) {
            for (const [flag, n] of Object.entries(flags)) {
              if (typeof n === "number") add("flags", `${surface}|${cmd}|${flag}`, n);
            }
          }
        }
      }
    }
  }

  // Exits
  if (isPlainObject(body.exits)) {
    for (const [surface, cmds] of Object.entries(body.exits)) {
      if (isPlainObject(cmds)) {
        for (const [cmd, codes] of Object.entries(cmds)) {
          if (isPlainObject(codes)) {
            for (const [code, n] of Object.entries(codes)) {
              if (typeof n === "number") add("exits", `${surface}|${cmd}|${code}`, n);
            }
          }
        }
      }
    }
  }

  // Durations
  if (isPlainObject(body.durations)) {
    for (const [surface, cmds] of Object.entries(body.durations)) {
      if (isPlainObject(cmds)) {
        for (const [cmd, buckets] of Object.entries(cmds)) {
          if (isPlainObject(buckets)) {
            for (const [bucket, n] of Object.entries(buckets)) {
              if (typeof n === "number") add("durations", `${surface}|${cmd}|${bucket}`, n);
            }
          }
        }
      }
    }
  }

  // Transitions
  if (isPlainObject(body.transitions)) {
    for (const [k, n] of Object.entries(body.transitions)) {
      if (typeof n === "number") add("transitions", k, n);
    }
  }

  // Models
  if (isPlainObject(body.models)) {
    for (const [k, n] of Object.entries(body.models)) {
      if (typeof n === "number") add("models", k, n);
    }
  }

  // Modes
  if (isPlainObject(body.modes)) {
    for (const [k, n] of Object.entries(body.modes)) {
      if (typeof n === "number") add("modes", k, n);
    }
  }

  // Aspects
  if (isPlainObject(body.aspects)) {
    for (const [k, n] of Object.entries(body.aspects)) {
      if (typeof n === "number") add("aspects", k, n);
    }
  }

  // Outcomes
  if (isPlainObject(body.outcomes)) {
    for (const [k, n] of Object.entries(body.outcomes)) {
      if (typeof n === "number") add("outcomes", k, n);
    }
  }

  // MCP clients
  if (isPlainObject(body.mcp_clients)) {
    for (const [k, n] of Object.entries(body.mcp_clients)) {
      if (typeof n === "number") add("mcp_clients", k, n);
    }
  }

  // Crashes
  if (isPlainObject(body.crashes)) {
    for (const [surface, fps] of Object.entries(body.crashes)) {
      if (isPlainObject(fps)) {
        for (const [fp, n] of Object.entries(fps)) {
          if (typeof n === "number") add("crashes", `${surface}|${fp}`, n);
        }
      }
    }
  }

  // Tools
  if (isPlainObject(body.tools)) {
    for (const [tool, results] of Object.entries(body.tools)) {
      if (isPlainObject(results)) {
        for (const [res, n] of Object.entries(results)) {
          if (typeof n === "number") add("tools", `${tool}|${res}`, n);
        }
      }
    }
  }

  // v1 crosses:
  // Note: "x:surface_command_exit" equals exits, which is already covered above as a base field.
  // x:os_exit: key "<os>|<exit code>" summed over all commands and surfaces
  if (typeof body.os === "string" && isPlainObject(body.exits)) {
    for (const cmds of Object.values(body.exits)) {
      if (isPlainObject(cmds)) {
        for (const codes of Object.values(cmds)) {
          if (isPlainObject(codes)) {
            for (const [code, n] of Object.entries(codes)) {
              if (typeof n === "number") add("x:os_exit", `${body.os}|${code}`, n);
            }
          }
        }
      }
    }
  }

  // x:version_exit: key "<version>|<code>" summed over all commands and surfaces
  if (typeof body.version === "string" && isPlainObject(body.exits)) {
    for (const cmds of Object.values(body.exits)) {
      if (isPlainObject(cmds)) {
        for (const codes of Object.values(cmds)) {
          if (isPlainObject(codes)) {
            for (const [code, n] of Object.entries(codes)) {
              if (typeof n === "number") add("x:version_exit", `${body.version}|${code}`, n);
            }
          }
        }
      }
    }
  }

  // x:storage_exit: key "<storage>|<code>" summed over all commands and surfaces
  if (typeof body.storage === "string" && isPlainObject(body.exits)) {
    for (const cmds of Object.values(body.exits)) {
      if (isPlainObject(cmds)) {
        for (const codes of Object.values(cmds)) {
          if (isPlainObject(codes)) {
            for (const [code, n] of Object.entries(codes)) {
              if (typeof n === "number") add("x:storage_exit", `${body.storage}|${code}`, n);
            }
          }
        }
      }
    }
  }

  // x:os_install_age: (1 per report), key "<os>|<install_age>"
  if (typeof body.os === "string" && typeof body.install_age === "string") {
    add("x:os_install_age", `${body.os}|${body.install_age}`, 1);
  }

  // x:installer_update_exit: exits of command "update" only, key "<installer>|<code>"
  if (typeof body.installer === "string" && isPlainObject(body.exits)) {
    for (const cmds of Object.values(body.exits)) {
      if (isPlainObject(cmds)) {
        const updateCodes = cmds["update"];
        if (isPlainObject(updateCodes)) {
          for (const [code, n] of Object.entries(updateCodes)) {
            if (typeof n === "number") add("x:installer_update_exit", `${body.installer}|${code}`, n);
          }
        }
      }
    }
  }

  // Prepare batch statements:
  // 1. Delete expired seen rows
  // 2. Insert new seen row (14 days expiration = nowSec + 14 * 86400)
  // 3. Upsert all totals increments
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM seen WHERE expires <= ?").bind(nowSec),
    env.DB.prepare(
      "INSERT INTO seen (report_id, expires) VALUES (?, ?) ON CONFLICT(report_id) DO UPDATE SET expires = excluded.expires"
    ).bind(body.report_id, nowSec + 14 * 86400),
  ];

  for (const [mapKey, n] of totalsMap) {
    const sep = mapKey.indexOf("\0");
    const field = mapKey.slice(0, sep);
    const key = mapKey.slice(sep + 1);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO totals (week, field, key, n) VALUES (?, ?, ?, ?) ON CONFLICT(week, field, key) DO UPDATE SET n = totals.n + excluded.n"
      ).bind(body.week, field, key, n)
    );
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
        0, 0, 0
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
