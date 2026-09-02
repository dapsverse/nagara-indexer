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

-- Raw `contracts.ContractEmitted` payloads.
--
-- Stored undecoded on purpose. An ink! v4 event payload is
-- `[local_event_index, ...SCALE fields]`, and that index is the emitting
-- contract's own metadata ordering — there is no on-chain signature topic like
-- Ethereum's topic0. So the payload cannot be interpreted without that
-- contract's ABI, which may arrive later (or never). Keeping the bytes means a
-- token standard or a verified ABI added tomorrow can decode history already
-- indexed today, instead of it being lost.
CREATE TABLE IF NOT EXISTS tx_event (
  network         TEXT   NOT NULL,
  block_number    BIGINT NOT NULL,
  extrinsic_index INT    NOT NULL,
  -- Position among the contract events of this extrinsic, not a global index.
  event_index     INT    NOT NULL,
  contract        TEXT   NOT NULL,
  data            BYTEA  NOT NULL,
  PRIMARY KEY (network, block_number, extrinsic_index, event_index)
);

-- "Everything this contract ever emitted", newest first.
CREATE INDEX IF NOT EXISTS tx_event_contract_idx
  ON tx_event (network, contract, block_number DESC);

-- Contracts seen on chain, with the code hash that says which ABI applies.
CREATE TABLE IF NOT EXISTS contract (
  network          TEXT   NOT NULL,
  address          TEXT   NOT NULL,
  code_hash        TEXT,
  first_seen_block BIGINT NOT NULL,
  PRIMARY KEY (network, address)
);

CREATE INDEX IF NOT EXISTS contract_code_hash_idx
  ON contract (network, code_hash);

-- Token identity, probed by interface rather than read from an ABI: a contract
-- that answers name/symbol/total_supply is a token, whoever deployed it.
ALTER TABLE contract ADD COLUMN IF NOT EXISTS is_token BOOLEAN;
ALTER TABLE contract ADD COLUMN IF NOT EXISTS token_name TEXT;
ALTER TABLE contract ADD COLUMN IF NOT EXISTS token_symbol TEXT;
ALTER TABLE contract ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS contract_is_token_idx
  ON contract (network, is_token) WHERE is_token;

-- Block ranges that can never be indexed, recorded rather than left invisible.
--
-- If the indexer is offline longer than the node's pruning window, the blocks it
-- missed are gone for good. Skipping them silently would make daily counts
-- under-report with no trace, so each hole is written down here.
CREATE TABLE IF NOT EXISTS indexer_gap (
  network    TEXT        NOT NULL,
  from_block BIGINT      NOT NULL,
  to_block   BIGINT      NOT NULL,
  reason     TEXT        NOT NULL,
  noted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, from_block)
);

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

-- Token movements decoded from NKRI08-conforming calls.
--
-- `provenance` records how much to trust the numbers:
--   'inferred' — matched by selector and argument layout, with no ABI. The
--                message name and signature line up, but nothing proves the
--                contract means by `transfer` what the standard means.
--   'verified' — the contract's ABI is known and confirmed the shape.
-- Amounts from 'inferred' rows must be presented as such, never as settled fact.
--
-- Note this only captures transfers made by a direct call. Mints, burns and
-- transfers triggered inside another contract appear only as events, which need
-- the ABI — see tx_event.
CREATE TABLE IF NOT EXISTS token_transfer (
  network         TEXT   NOT NULL,
  block_number    BIGINT NOT NULL,
  extrinsic_index INT    NOT NULL,
  token           TEXT   NOT NULL,
  message         TEXT   NOT NULL,
  from_address    TEXT,
  to_address      TEXT   NOT NULL,
  amount_raw      NUMERIC(39, 0) NOT NULL,
  provenance      TEXT   NOT NULL,
  success         BOOLEAN NOT NULL,
  PRIMARY KEY (network, block_number, extrinsic_index)
);

CREATE INDEX IF NOT EXISTS token_transfer_token_idx
  ON token_transfer (network, token, block_number DESC);
CREATE INDEX IF NOT EXISTS token_transfer_from_idx
  ON token_transfer (network, from_address) WHERE from_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS token_transfer_to_idx
  ON token_transfer (network, to_address);

-- ═══════════════════════════════════════════════════════════════════════
-- EVM chain support (pallet-ethereum / pallet-evm networks).
--
-- Ported from nagara-evm-explorer's schema, which indexed one network per
-- deployment. This indexer is multi-network in one database, so every table
-- here carries a `network` column that the source schema did not need.
--
-- All uint256 values are NUMERIC(78,0): BIGINT overflows at 2^63 and wei
-- values routinely exceed it. Addresses and hashes are stored lowercase.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS evm_block (
  network      TEXT NOT NULL,
  number       BIGINT NOT NULL,
  hash         TEXT NOT NULL,
  parent_hash  TEXT NOT NULL,
  timestamp    TIMESTAMPTZ NOT NULL,
  author       TEXT,
  gas_used     NUMERIC(78,0) NOT NULL,
  gas_limit    NUMERIC(78,0) NOT NULL,
  base_fee     NUMERIC(78,0),
  tx_count     INTEGER NOT NULL,
  PRIMARY KEY (network, number)
);

CREATE TABLE IF NOT EXISTS evm_tx (
  network              TEXT NOT NULL,
  hash                 TEXT NOT NULL,
  block_number         BIGINT NOT NULL,
  tx_index             INTEGER NOT NULL,
  from_addr            TEXT NOT NULL,
  to_addr              TEXT,
  value                NUMERIC(78,0) NOT NULL,
  gas_used             NUMERIC(78,0) NOT NULL,
  gas_price            NUMERIC(78,0),
  effective_gas_price  NUMERIC(78,0),
  status               SMALLINT NOT NULL,
  nonce                BIGINT NOT NULL,
  input                BYTEA NOT NULL,
  contract_address     TEXT,
  PRIMARY KEY (network, hash)
);
CREATE INDEX IF NOT EXISTS evm_tx_from_idx  ON evm_tx (network, from_addr, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tx_to_idx    ON evm_tx (network, to_addr, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tx_block_idx ON evm_tx (network, block_number DESC, tx_index);

CREATE TABLE IF NOT EXISTS evm_log (
  network      TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  address      TEXT NOT NULL,
  topic0       TEXT,
  topic1       TEXT,
  topic2       TEXT,
  topic3       TEXT,
  data         BYTEA NOT NULL,
  PRIMARY KEY (network, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS evm_log_topic0_idx ON evm_log (network, topic0, block_number DESC);

CREATE TABLE IF NOT EXISTS evm_token (
  network    TEXT NOT NULL,
  address    TEXT NOT NULL,
  type       TEXT NOT NULL,       -- 'erc20' | 'erc721' | 'erc1155'
  name       TEXT,
  symbol     TEXT,
  decimals   SMALLINT,            -- NULL for 721/1155
  first_seen BIGINT NOT NULL,     -- block_number
  PRIMARY KEY (network, address)
);

CREATE TABLE IF NOT EXISTS evm_token_transfer (
  network      TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  -- One ERC-1155 TransferBatch log carries many transfers. They share a
  -- log_index, so sub_index separates them; everything else is 0.
  sub_index    INTEGER NOT NULL DEFAULT 0,
  block_number BIGINT NOT NULL,
  token        TEXT NOT NULL,
  from_addr    TEXT NOT NULL,
  to_addr      TEXT NOT NULL,
  value        NUMERIC(78,0),     -- NULL for ERC-721
  token_id     NUMERIC(78,0),     -- NULL for ERC-20
  PRIMARY KEY (network, tx_hash, log_index, sub_index),
  FOREIGN KEY (network, tx_hash, log_index)
    REFERENCES evm_log (network, tx_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS evm_tt_token_idx ON evm_token_transfer (network, token, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tt_from_idx  ON evm_token_transfer (network, from_addr, block_number DESC);
CREATE INDEX IF NOT EXISTS evm_tt_to_idx    ON evm_token_transfer (network, to_addr, block_number DESC);

CREATE TABLE IF NOT EXISTS evm_cursor (
  network            TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL
);
