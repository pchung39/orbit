-- ORBIT investigation store (Postgres + pgvector).
-- Embeddings are written at ingest from a local model, not a paid API.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    scenario TEXT NOT NULL,
    source_csv TEXT,
    started_at TEXT,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS telemetry (
    run_id TEXT NOT NULL REFERENCES runs(id),
    time_s DOUBLE PRECISION NOT NULL,
    timestamp TEXT NOT NULL,
    channel TEXT NOT NULL,
    value_num DOUBLE PRECISION,
    value_text TEXT,
    PRIMARY KEY (run_id, time_s, channel)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_lookup
    ON telemetry (run_id, channel, time_s);

CREATE TABLE IF NOT EXISTS events (
    run_id TEXT NOT NULL REFERENCES runs(id),
    time_s DOUBLE PRECISION NOT NULL,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT,
    detail TEXT
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    body TEXT NOT NULL
);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding vector(384);

-- Open work items. Not the same as documents.kind = 'incident'
-- (those are filed library close-outs such as INC-0187).
CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id),
    alarm TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TEXT NOT NULL,
    notes TEXT
);

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS filed_at TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closeout TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS investigation_report TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS investigated_at TEXT;

CREATE TABLE IF NOT EXISTS hypothesis_feedback (
    incident_id TEXT PRIMARY KEY REFERENCES incidents(id),
    run_id TEXT NOT NULL,
    alarm TEXT NOT NULL,
    hypothesis_key TEXT NOT NULL,
    hypothesis_label TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'rejected')),
    note TEXT,
    provider TEXT NOT NULL DEFAULT 'rules',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
