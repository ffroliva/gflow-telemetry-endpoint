// Live check against a deployed Worker. Opt-in, never part of `npm test`.
//   LIVE_URL=https://<worker>.workers.dev node test/live-check.mjs
// Posts one probe report into a week ~50 weeks back, so its totals can be found and deleted:
//   wrangler d1 execute gflow-telemetry --remote --command "DELETE FROM totals WHERE week = '<week>'"
const base = process.env.LIVE_URL;
if (!base) throw new Error("set LIVE_URL");

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

const week = isoWeek(new Date(Date.now() - 50 * 7 * 86400000));
const reportId = `live-probe-${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 48);
const report = {
  schema: 1, report_id: reportId, week, version: "0.0.0-probe", python: "3.12",
  os: "windows", arch: "x86_64", installer: "uv", install_age: "<1w", storage: "local",
  commands: { cli: { "probe e2e": 2 } }, exits: { cli: { "probe e2e": { "0": 2 } } },
};
const post = (body, headers = {}) => fetch(`${base}/v1/report`, {
  method: "POST", redirect: "manual",
  headers: { "content-type": "application/json", ...headers }, body,
});

const results = {};
results.first = (await post(JSON.stringify(report), { "X-Forwarded-For": "203.0.113.7" })).status;
results.repeat = (await post(JSON.stringify(report))).status;
results.extraKey = (await post(JSON.stringify({ ...report, report_id: reportId + "x", email: "a@b.c" }))).status;
results.tooBig = (await post("x".repeat(17000))).status;
results.get = (await fetch(`${base}/v1/report`, { redirect: "manual" })).status;
console.log(JSON.stringify({ week, reportId, results }));
const expected = { first: 204, repeat: 204, extraKey: 400, tooBig: 413, get: 405 };
const bad = Object.entries(expected).filter(([k, v]) => results[k] !== v);
if (bad.length) { console.error("MISMATCH", bad); process.exit(1); }
