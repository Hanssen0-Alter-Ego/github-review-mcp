CREATE TABLE write_receipts (
  request_id TEXT PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','succeeded','rejected','unknown')),
  operation TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  result_json TEXT
);
