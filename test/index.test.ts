import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Env } from "../src/index";

// 2026-11-06 12:00 UTC is a Friday in ISO week 2026-W45.
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const WEEK = "2026-W45";
const URL_ = "https://telemetry.example/v1/report";
const FINGERPRINT =
  "TimeoutError <- <playwright> <- api.client:FlowApiClient.upload_reference <- cli_video:t2v";

const baseEnv = env as unknown as Env;

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    report_id: "abcdefghijklmnop0123",
    week: WEEK,
    version: "0.94.0",
    python: "3.12",
    os: "windows",
    arch: "x86_64",
    installer: "uv",
    install_age: "<1m",
    storage: "local",
    commands: { cli: { "video t2v": 3, update: 1 }, mcp: { "image t2i": 2 } },
    flags: { cli: { "video t2v": { "--aspect": 2 } } },
    exits: {
      cli: { "video t2v": { "0": 2, "11": 1 }, update: { "0": 1 } },
      mcp: { "image t2i": { "0": 1, queued: 1 } },
    },
    durations: { cli: { "video t2v": { "<1m": 3 } } },
    transitions: { "image t2i -> video i2v": 3 },
    models: { veo_3: 3 },
    modes: { fast: 3 },
    aspects: { landscape: 3 },
    outcomes: { success: 3 },
    mcp_clients: { "claude-code": 1 },
    crashes: { cli: { [FINGERPRINT]: 1 } },
    tools: { "prompt-architect": { expanded: 3, unchanged: 1 } },
    ...overrides,
  };
}

function post(
  body: unknown,
  opts: { env?: Env; headers?: Record<string, string>; cf?: Record<string, unknown> } = {},
): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: raw,
    cf: opts.cf,
  } as RequestInit);
  return handle(req, opts.env ?? baseEnv, NOW);
}

async function totals(): Promise<Map<string, number>> {
  const { results } = await baseEnv.DB.prepare("SELECT week, field, key, n FROM totals").all<{
    week: string;
    field: string;
    key: string;
    n: number;
  }>();
  return new Map(results.map((r) => [`${r.week}/${r.field}/${r.key}`, r.n]));
}

async function seenCount(): Promise<number> {
  return (await baseEnv.DB.prepare("SELECT COUNT(*) AS c FROM seen").first<number>("c")) ?? 0;
}

/** Every value of every column of every user table, as text. */
async function allStoredText(): Promise<{ table: string; text: string }[]> {
  const { results: tables } = await baseEnv.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const out: { table: string; text: string }[] = [];
  for (const { name } of tables) {
    const { results } = await baseEnv.DB.prepare(`SELECT * FROM "${name}"`).all();
    for (const row of results) {
      for (const v of Object.values(row)) out.push({ table: name, text: String(v) });
    }
  }
  return out;
}

beforeEach(async () => {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare("DELETE FROM totals"),
    baseEnv.DB.prepare("DELETE FROM seen"),
  ]);
});

describe("POST /v1/report", () => {
  it("accepts a valid report with 204, an empty body, and adds the expected totals", async () => {
    const res = await post(report(), { cf: { country: "GB" } });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const t = await totals();
    const at = (field: string, key: string) => t.get(`${WEEK}/${field}/${key}`);
    expect(at("reports", "all")).toBe(1);
    expect(at("country", "GB")).toBe(1);
    expect(at("os", "windows")).toBe(1);
    expect(at("version", "0.94.0")).toBe(1);
    expect(at("python", "3.12")).toBe(1);
    expect(at("arch", "x86_64")).toBe(1);
    expect(at("installer", "uv")).toBe(1);
    expect(at("install_age", "<1m")).toBe(1);
    expect(at("storage", "local")).toBe(1);
    expect(at("commands", "cli|video t2v")).toBe(3);
    expect(at("commands", "mcp|image t2i")).toBe(2);
    expect(at("flags", "cli|video t2v|--aspect")).toBe(2);
    expect(at("exits", "cli|video t2v|0")).toBe(2);
    expect(at("exits", "cli|video t2v|11")).toBe(1);
    expect(at("exits", "mcp|image t2i|queued")).toBe(1);
    expect(at("durations", "cli|video t2v|<1m")).toBe(3);
    expect(at("transitions", "image t2i -> video i2v")).toBe(3);
    expect(at("models", "veo_3")).toBe(3);
    expect(at("modes", "fast")).toBe(3);
    expect(at("aspects", "landscape")).toBe(3);
    expect(at("outcomes", "success")).toBe(3);
    expect(at("mcp_clients", "claude-code")).toBe(1);
    expect(at("crashes", `cli|${FINGERPRINT}`)).toBe(1);
    expect(at("tools", "prompt-architect|expanded")).toBe(3);
    expect(at("tools", "prompt-architect|unchanged")).toBe(1);
    // v1 crosses
    expect(at("x:os_exit", "windows|0")).toBe(2 + 1 + 1); // summed over every command and surface
    expect(at("x:os_exit", "windows|11")).toBe(1);
    expect(at("x:version_exit", "0.94.0|0")).toBe(4);
    expect(at("x:storage_exit", "local|11")).toBe(1);
    expect(at("x:os_install_age", "windows|<1m")).toBe(1);
    expect(at("x:installer_update_exit", "uv|0")).toBe(1);
    expect([...t.keys()].filter((k) => k.includes("installer_update_exit"))).toHaveLength(1);
    expect(await seenCount()).toBe(1);
  });

  it("counts country as XX when the edge gives none", async () => {
    expect((await post(report())).status).toBe(204);
    expect((await totals()).get(`${WEEK}/country/XX`)).toBe(1);
  });

  it("accepts a minimal report with only the required keys", async () => {
    const res = await post({ schema: 1, report_id: "abcdefghijklmnop0123", week: WEEK });
    expect(res.status).toBe(204);
    expect((await totals()).get(`${WEEK}/reports/all`)).toBe(1);
  });

  it("rejects an extra top-level key with 400 and writes nothing", async () => {
    const res = await post(report({ email: "someone@example.com" }));
    expect(res.status).toBe(400);
    expect((await totals()).size).toBe(0);
    expect(await seenCount()).toBe(0);
  });

  it.each([
    ["missing report_id", (() => {
      const r = report();
      delete r.report_id;
      return r;
    })()],
    ["short report_id", report({ report_id: "short" })],
    ["bad week", report({ week: "2026-45" })],
    ["impossible week", report({ week: "2026-W54" })],
    ["week too far in the future", report({ week: "2026-W47" })],
    ["week older than 60 weeks", report({ week: "2025-W36" })],
    ["schema 2", report({ schema: 2 })],
    ["os outside the enum", report({ os: "haiku" })],
    ["bad version token", report({ version: "0.94 0" })],
    ["negative count", report({ commands: { cli: { "video t2v": -1 } } })],
    ["fractional count", report({ commands: { cli: { "video t2v": 1.5 } } })],
    ["count above 1e6", report({ models: { veo_3: 1_000_001 } })],
    ["unknown surface", report({ commands: { web: { "video t2v": 1 } } })],
    ["commands nested one level too deep", report({ commands: { cli: { "video t2v": { "0": 1 } } } })],
    ["exits nested one level too shallow", report({ exits: { cli: { "video t2v": 1 } } })],
    ["tools result outside the enum", report({ tools: { "prompt-architect": { broke: 1 } } })],
    ["key with the separator", report({ models: { "veo|3": 1 } })],
    ["over-long key", report({ models: { ["m".repeat(201)]: 1 } })],
    ["array body", [report()]],
    ["not JSON", "{not json"],
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await totals()).size).toBe(0);
  });

  it("rejects a body over 16 KB with 413, even when Content-Length lies", async () => {
    const big = report({ models: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`m${i}`, 1])) });
    const res = await post(big, { headers: { "content-length": "100" } });
    expect(res.status).toBe(413);
    expect((await totals()).size).toBe(0);
  });

  it("rejects a declared Content-Length over 16 KB with 413", async () => {
    const res = await post(report(), { headers: { "content-length": "16385" } });
    expect(res.status).toBe(413);
  });

  it("answers a repeated report_id with 204 and leaves the totals unchanged", async () => {
    expect((await post(report())).status).toBe(204);
    const first = await totals();
    const res = await post(report());
    expect(res.status).toBe(204);
    expect(await totals()).toEqual(first);
  });

  it("remembers a report_id for 14 days", async () => {
    await post(report());
    const expires = await baseEnv.DB.prepare("SELECT expires FROM seen").first<number>("expires");
    expect(expires).toBe(Math.floor(NOW / 1000) + 14 * 86400);
  });

  it("drops expired seen rows, so an old report_id no longer blocks", async () => {
    await baseEnv.DB.prepare("INSERT INTO seen (report_id, expires) VALUES (?, ?)")
      .bind("abcdefghijklmnop0123", Math.floor(NOW / 1000) - 1)
      .run();
    expect((await post(report())).status).toBe(204);
    expect((await totals()).get(`${WEEK}/reports/all`)).toBe(1);
  });

  // STOPPED is a plain var, so a test overrides it by passing a modified env to the exported handler.
  it("answers 410 to everything when STOPPED is not 0, before reading the body", async () => {
    const stopped = { ...baseEnv, STOPPED: "1" };
    expect((await post(report(), { env: stopped })).status).toBe(410);
    expect((await post("{not json", { env: stopped })).status).toBe(410);
    const get = await handle(new Request(URL_), stopped, NOW);
    expect(get.status).toBe(410);
    expect((await totals()).size).toBe(0);
  });

  it("answers 429 with Retry-After past the next 00:00 UTC when D1 hits a limit, adding nothing", async () => {
    const limited: Env = {
      ...baseEnv,
      DB: {
        prepare: (q: string) => baseEnv.DB.prepare(q),
        batch: () => Promise.reject(new Error("D1_ERROR: too many rows written: limit exceeded")),
      } as unknown as D1Database,
    };
    const res = await post(report(), { env: limited });
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("retry-after"));
    const nextMidnight = Date.UTC(2026, 10, 7, 0, 0, 0);
    expect(retryAfter).toBeGreaterThan(0);
    expect(NOW + retryAfter * 1000).toBeGreaterThan(nextMidnight);
    expect((await totals()).size).toBe(0);
    expect(await seenCount()).toBe(0);
  });

  it("answers 503 on any other D1 error, and the batch leaves nothing partial behind", async () => {
    // A real batch whose last statement fails: D1 batches are one transaction, so nothing stays.
    const failing: Env = {
      ...baseEnv,
      DB: {
        prepare: (q: string) => baseEnv.DB.prepare(q),
        batch: (stmts: D1PreparedStatement[]) =>
          baseEnv.DB.batch([...stmts, baseEnv.DB.prepare("INSERT INTO no_such_table VALUES (1)")]),
      } as unknown as D1Database,
    };
    const res = await post(report(), { env: failing });
    expect(res.status).toBe(503);
    expect((await totals()).size).toBe(0);
    expect(await seenCount()).toBe(0);
  });

  it("stores no report_id outside seen, no IP, and no raw body anywhere", async () => {
    const ip = "203.0.113.7";
    const body = report();
    const res = await post(body, {
      headers: { "cf-connecting-ip": ip, "x-forwarded-for": ip },
      cf: { country: "GB" },
    });
    expect(res.status).toBe(204);
    const stored = await allStoredText();
    expect(stored.length).toBeGreaterThan(0);
    const raw = JSON.stringify(body);
    for (const { table, text } of stored) {
      expect(text).not.toContain(ip);
      expect(text).not.toContain(raw);
      expect(text).not.toContain("{");
      if (table !== "seen") expect(text).not.toContain(body.report_id as string);
    }
    // The fingerprint may appear, but only as a totals key.
    expect(stored.some(({ table, text }) => table === "totals" && text === `cli|${FINGERPRINT}`)).toBe(true);
  });
});

describe("routing through the deployed worker entry", () => {
  it("answers 204 to POST /v1/report", async () => {
    // SELF uses real server time, so build a report for the current ISO week.
    const now = new Date();
    const res = await SELF.fetch(URL_, {
      method: "POST",
      body: JSON.stringify({ schema: 1, report_id: "selfselfselfself01", week: isoWeek(now) }),
    });
    expect(res.status).toBe(204);
  });

  it("answers 404 or 405 to GET /v1/report", async () => {
    const res = await SELF.fetch(URL_);
    expect([404, 405]).toContain(res.status);
  });

  it("answers 404 to POST on any other path", async () => {
    const res = await SELF.fetch("https://telemetry.example/v2/report", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
