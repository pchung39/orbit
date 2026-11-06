-- ORBIT case log. Tapes and procedures stay in files.
-- incidents.run_id points at a tape id or a sealed window id.

CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    run_id TEXT NOT NULL,
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
