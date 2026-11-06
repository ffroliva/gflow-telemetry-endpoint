// Print the status the live Worker answers to an empty POST (410 when STOPPED, 400 otherwise).
//   LIVE_URL=https://<worker>.workers.dev node test/live-status.mjs
const r = await fetch(`${process.env.LIVE_URL}/v1/report`, { method: "POST", body: "{}" });
console.log(r.status);
