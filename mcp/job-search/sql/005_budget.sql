-- 005: per-day budget shared by MCP and CLI, and per-source wall state (spec 2.3).

BEGIN;

CREATE TABLE IF NOT EXISTS ic_scan_budget (
  source text NOT NULL,
  day date NOT NULL,
  pages int NOT NULL DEFAULT 0,
  details int NOT NULL DEFAULT 0,
  PRIMARY KEY (source, day)
);

CREATE TABLE IF NOT EXISTS ic_source_state (
  source text PRIMARY KEY,
  disabled_until timestamptz,
  consecutive_walls int NOT NULL DEFAULT 0,
  last_wall_at timestamptz,
  manual_disable boolean NOT NULL DEFAULT false
);

COMMIT;
