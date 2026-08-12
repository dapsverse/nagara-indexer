# Deploying nagara-indexer

Instructions for an agent (or a person) operating the server. Every step has a
check — run the check before moving on. Nothing here needs the frontend.

**What this service does:** connects to each Nagara network, writes blocks and
transactions into Postgres, and serves that back over a small read-only HTTP API.
It owns its database; the frontend never connects to Postgres.

**Assumed target:** Debian/Ubuntu with systemd, deployed at `/opt/nagara-indexer`,
running as a dedicated `nagara` user.

---

## 0. Know this before you start

The public Nagara nodes are **pruned** — they discard old block bodies *and*
state. Measured on 2026-08-12:

| Network  | Endpoint                        | History actually served |
| -------- | ------------------------------- | ----------------------- |
| Mainnet  | `wss://bootnode.nagara.network` | ~250 blocks (~12 min)   |
| Testnet  | `wss://testnet.nagara.network`  | ~1,000 blocks (~50 min) |

Requests below that return `-32000: Api called for an unknown Block: State
already discarded`. So on these endpoints the indexer can only accumulate history
**forwards from the moment it first runs**.

Full history needs an **archive node** (`--state-pruning archive
--blocks-pruning archive`), synced from genesis — an already-pruned node cannot be
un-pruned retroactively. When one exists, set `MAINNET_ARCHIVE_WS_URL` /
`TESTNET_ARCHIVE_WS_URL` and restart: the backfill parks its cursor at the wall
and resumes from exactly there.

Backfill throughput measured against the live nodes: **26–42 blocks/sec** at
`FETCH_CONCURRENCY=25`. At ~35/s, a full mainnet+testnet backfill (~12.7M blocks)
is roughly **100 hours**. Raise `FETCH_CONCURRENCY` if the archive node tolerates
it; watch its CPU before going far above 50.

---

## 1. Prerequisites

```bash
node --version     # need >= 20
psql --version     # need >= 14
systemctl --version
```

If Node is missing or too old:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Check:** `node --version` prints v20 or newer.

---

## 2. Postgres database and role

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE nagara WITH LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE nagara_explorer OWNER nagara;
SQL
```

**Check** — this must print `1`:

```bash
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='nagara_explorer'"
```

The schema itself is applied automatically on first start (`src/schema.sql`, all
statements are `IF NOT EXISTS`). There is no separate migration step.

---

## 3. System user and code

```bash
sudo useradd --system --create-home --home-dir /opt/nagara-indexer --shell /usr/sbin/nologin nagara
sudo -u nagara git clone <REPO_URL> /opt/nagara-indexer
cd /opt/nagara-indexer
sudo -u nagara npm ci --omit=dev=false
```

`npm ci` must install devDependencies: the service runs TypeScript directly
through `tsx`, so `tsx` is required at runtime. Do **not** pass `--omit=dev`.

**Check:** `sudo -u nagara npx tsc --noEmit` exits 0.

---

## 4. Configuration

```bash
sudo -u nagara cp .env.example .env
sudo -u nagara chmod 600 .env
sudo -u nagara vi .env
```

Set at minimum:

```ini
DATABASE_URL=postgresql://nagara:CHANGE_ME@localhost:5432/nagara_explorer
PORT=8787
MAINNET_WS_URL=wss://bootnode.nagara.network
TESTNET_WS_URL=wss://testnet.nagara.network
# Leave the two ARCHIVE urls blank until an archive node exists.
```

`.env` holds the database password — keep it `600` and owned by `nagara`. It is
gitignored; never commit it.

**Check:** `sudo -u nagara psql "$DATABASE_URL" -c 'select 1'` succeeds.

---

## 5. First run in the foreground

Run it by hand once and read the output before handing it to systemd.

```bash
cd /opt/nagara-indexer
sudo -u nagara npm start
```

Expect, within ~30 seconds:

```
[http] listening on :8787
[...] [mainnet] connected to Nagara POS Main Network at wss://..., head #4,427,988
[...] [mainnet] initialised cursors at head #4,427,988
[...] [mainnet] backfill reading from wss://... (pruned live node — limited history)
[...] [mainnet] tip → #4,427,989 (+1 blocks, 0 txns)
[...] [mainnet] history ← #4,427,738 (250 blocks, 0 txns, 35/s, ... remaining)
```

Then, after a few hundred blocks, this line is **expected, not a failure**:

```
history unavailable below #4,427,561: these blocks are pruned. Backfill paused.
Set MAINNET_ARCHIVE_WS_URL to an archive node and restart to continue from here.
```

**Check** in another shell:

```bash
curl -s localhost:8787/health          # {"ok":true}
curl -s localhost:8787/status | head   # lastIndexedBlock climbing on both networks
```

Stop it with Ctrl-C once both checks pass.

---

## 6. Install the service

```bash
sudo cp /opt/nagara-indexer/systemd/nagara-indexer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nagara-indexer
```

**Checks:**

```bash
systemctl is-active nagara-indexer      # active
journalctl -u nagara-indexer -n 30 --no-pager
curl -s localhost:8787/status
```

Confirm `lastIndexedBlock` rises when you call `/status` twice a minute apart.
If it does not, the tip follower is stuck — see Troubleshooting.

---

## 7. Expose it to the frontend

The frontend reads `INDEXER_URL` server-side and proxies `/api/daily`, so the
indexer does **not** need to be public. Prefer keeping it on localhost or a
private network.

- Same host as the frontend → `INDEXER_URL=http://127.0.0.1:8787`, no proxy needed.
- Different host → put it behind nginx/TLS and restrict by source address:

```nginx
location /indexer/ {
    proxy_pass http://127.0.0.1:8787/;
    allow 10.0.0.0/8;   # the frontend host
    deny all;
}
```

The API is read-only and has no auth, so do not publish it openly unless you are
content for anyone to run arbitrary range queries against it.

---

## 8. Operating

| Task              | Command                                            |
| ----------------- | -------------------------------------------------- |
| Logs (follow)     | `journalctl -u nagara-indexer -f`                   |
| Restart           | `sudo systemctl restart nagara-indexer`             |
| Status            | `curl -s localhost:8787/status`                     |
| Deploy new code   | `sudo -u nagara git pull && sudo -u nagara npm ci && sudo systemctl restart nagara-indexer` |
| Backup            | `sudo -u postgres pg_dump nagara_explorer > /backup/nagara_$(date +%F).sql` |

Restarting is always safe: every write is an upsert keyed on
`(network, block_number, extrinsic_index)`, and progress lives in
`indexer_state`, so a restart resumes rather than duplicating.

### Turning on the archive backfill later

```bash
sudo -u nagara vi /opt/nagara-indexer/.env   # set MAINNET_ARCHIVE_WS_URL / TESTNET_ARCHIVE_WS_URL
sudo systemctl restart nagara-indexer
journalctl -u nagara-indexer -f              # expect "backfill reading from ... (archive)"
```

It continues from the stored `backfill_block`, so nothing already indexed is
refetched. Expect it to run for days on a full chain; the tip stays live
throughout because the two loops are independent.

---

## 9. Troubleshooting

**`DATABASE_URL is not set`** — systemd did not read `.env`. Confirm
`EnvironmentFile=` in the unit points at the real path and the file is readable
by `nagara`.

**`history unavailable below #N: these blocks are pruned`** — expected without an
archive node. Not an error; the tip keeps indexing.

**`tip stalled at #N — node did not serve N block(s)`** — the node briefly failed
to return a block it should have. It retries on the next head; if it repeats for
minutes, the endpoint is unhealthy — check the node.

**`lastIndexedBlock` not moving** — the websocket dropped without the process
noticing. `sudo systemctl restart nagara-indexer`. If it recurs, the endpoint is
resetting connections; verify with
`curl -s localhost:8787/status` against a second endpoint.

**High CPU during backfill** — lower `FETCH_CONCURRENCY` in `.env` and restart.
Each block costs ~3 RPC round trips plus SCALE decoding.

**Database growth** — one row per block plus one per *listed* transaction
(transfers and contract activity; inherents are counted in
`block.extrinsics_count` but not stored as rows). A full 12.7M-block backfill is
on the order of a few GB. Check with:

```bash
sudo -u postgres psql nagara_explorer -c "\dt+"
```

---

## 10. API reference

All endpoints are `GET`, return JSON, and accept `?network=mainnet|testnet`
(default `mainnet`).

| Endpoint        | Parameters                                     | Purpose                                        |
| --------------- | ---------------------------------------------- | ---------------------------------------------- |
| `/health`       | —                                              | Liveness only.                                 |
| `/status`       | —                                              | Cursors and row counts for every network.      |
| `/daily`        | `days` (1–365, default 14)                     | Transactions per calendar day, Asia/Jakarta.   |
| `/blocks`       | `limit` (1–100), `before`                      | Newest blocks first; `before` pages downwards. |
| `/transactions` | `limit`, `before`, `address`, `contract`        | Newest first; `address` matches either side.   |

Days with no activity are returned as `0` rather than omitted, so a chart's x
axis stays honest.

---

## Note on the shared decoder

`src/decode.ts`, `src/format.ts` and `src/types.ts` are copies of the frontend's
chain-decoding modules. They are what make an indexed row agree with what the
explorer shows live. **They are duplicated across two repositories and can
drift.** If you change how a transaction is classified in one, change it in the
other, or promote these three files into a shared package.
