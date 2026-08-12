-- Nagara explorer index. Applied idempotently by db.indexer.ts on first use.

-- Two independent cursors per network so the live tip stays fresh while the
-- historical backfill grinds downwards:
--   last_block     — highest block written; the tip follower resumes above it
--   backfill_block — lowest block written by the backfiller; it walks down to 0
--                    (NULL = not started, 0 = history complete)
CREATE TABLE IF NOT EXISTS indexer_state (
  network        TEXT PRIMARY KEY,
  last_block     BIGINT      NOT NULL,
  backfill_block BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE indexer_state
  ADD COLUMN IF NOT EXISTS backfill_block BIGINT;

-- One row per extrinsic worth listing. The primary key is what makes the
-- indexer safely re-runnable: replaying a block conflicts and does nothing.
CREATE TABLE IF NOT EXISTS tx (
  network         TEXT        NOT NULL,
  block_number    BIGINT      NOT NULL,
  extrinsic_index INT         NOT NULL,
  block_hash      TEXT        NOT NULL,
  extrinsic_hash  TEXT        NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  kind            TEXT        NOT NULL,
  section         TEXT        NOT NULL,
  method          TEXT        NOT NULL,
  signer          TEXT,
  dest            TEXT,
  contract        TEXT,
  -- Raw chain units. NUMERIC because a u128 does not fit in BIGINT.
  amount_raw      NUMERIC(39, 0),
  fee_raw         NUMERIC(39, 0),
  success         BOOLEAN     NOT NULL,
  error           TEXT,
  PRIMARY KEY (network, block_number, extrinsic_index)
);

-- Daily counts and "latest transactions" both scan by time.
CREATE INDEX IF NOT EXISTS tx_network_ts_idx ON tx (network, ts DESC);
-- Block-ordered pagination for the transactions table.
CREATE INDEX IF NOT EXISTS tx_network_block_idx ON tx (network, block_number DESC);
-- "Transactions of this address" in either direction.
CREATE INDEX IF NOT EXISTS tx_network_signer_idx ON tx (network, signer)
  WHERE signer IS NOT NULL;
CREATE INDEX IF NOT EXISTS tx_network_dest_idx ON tx (network, dest)
  WHERE dest IS NOT NULL;
-- Everything that touched one contract, for the MINAR page.
CREATE INDEX IF NOT EXISTS tx_network_contract_idx ON tx (network, contract)
  WHERE contract IS NOT NULL;

-- Blocks are kept so the explorer can page through history without the chain.
CREATE TABLE IF NOT EXISTS block (
  network          TEXT        NOT NULL,
  block_number     BIGINT      NOT NULL,
  hash             TEXT        NOT NULL,
  parent_hash      TEXT        NOT NULL,
  state_root       TEXT        NOT NULL,
  extrinsics_root  TEXT        NOT NULL,
  ts               TIMESTAMPTZ NOT NULL,
  extrinsics_count INT         NOT NULL,
  author           TEXT,
  weight_used      BIGINT      NOT NULL,
  weight_max       BIGINT      NOT NULL,
  PRIMARY KEY (network, block_number)
);

CREATE INDEX IF NOT EXISTS block_network_ts_idx ON block (network, ts DESC);
