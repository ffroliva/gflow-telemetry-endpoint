-- Weekly totals only. No IP, no body, no per-report row.
CREATE TABLE totals (
  week TEXT NOT NULL,
  field TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (week, field, key)
);

-- report_id remembered for duplicate suppression; expires is unix seconds (now + 14 days).
CREATE TABLE seen (
  report_id TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
