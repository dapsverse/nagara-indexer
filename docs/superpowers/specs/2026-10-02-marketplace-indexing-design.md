# Marketplace Indexing & Order Book — Design Spec

Date: 2026-10-02
Status: approved (brainstorming), pending implementation plan
Author: Irsan (via Claude brainstorming session)
Related: `apps/marketplace/docs/superpowers/specs/2026-10-02-marketplace-core-design.md`
(the smart contracts this indexes), `apps/marketplace/docs/superpowers/plans/2026-10-02-marketplace-core-plan.md`

## Context

`apps/marketplace` now has two Foundry contracts — `RoyaltyRegistry.sol` and
`Marketplace.sol` — implementing a non-custodial NFT marketplace (listing,
offer, auction) for Nagara Chain. Listings are gasless EIP-712 signed orders
that live off-chain until fulfilled; offers and auctions are on-chain state.
Both need an indexed, queryable mirror so a frontend can browse without
hammering the RPC node or (for listings) without anywhere else to even find
them, since a signed-but-unfulfilled listing exists only as a signature in
someone's wallet until this service stores it.

`apps/indexer` already indexes two Nagara Chain networks (mainnet 16868,
testnet 16869) into Postgres via a dual-loop (tip-follower + backfiller) and
serves a small framework-free HTTP read API. This spec extends it with a
third concern, following the same conventions as the existing EVM path
(`src/evm/*`) rather than introducing a new framework, ORM, or service.

Explicitly out of scope for this piece of work (per the human partner's
direction): the marketplace frontend UI, wallet-connect/signing UX, and
NFT asset/metadata storage (IPFS/S3) — the last of these belongs to the
not-yet-built Subsystem A (minting factory), not here.

## Decisions made

1. **Deployment state**: `Marketplace.sol`/`RoyaltyRegistry.sol` are not yet
   deployed to testnet. This indexer is built against their ABI with
   contract addresses as per-network config (same pattern as the existing
   `minarAddress`, which is also "set once deployed, omit/no-op until
   then") — not blocked on a testnet deployment. End-to-end testing uses a
   local anvil instance the same way `apps/marketplace`'s own tests did.
2. **Where marketplace events are classified**: inside the existing
   `ingestBlock()` function (`src/evm/ingest.ts`), in the same per-log loop
   that already classifies ERC-20/721/1155 transfer logs — not a second,
   parallel indexing loop. This reuses the existing cursor, the existing
   one-transaction-per-block atomicity, and the existing tip/backfill
   scheduling; a second loop would duplicate all of that for no benefit.
3. **Database**: new tables in `src/schema.sql`, same `IF NOT EXISTS`
   idempotent-apply convention as every existing table — no migration
   tool introduced. New tables: `marketplace_listing` (off-chain, written
   by the API, not by the indexer loop — see below), `marketplace_offer`,
   `marketplace_auction`, `marketplace_royalty_override` (all mirrored
   from on-chain events, written by the indexer loop).
4. **Listing submission**: a new `POST /listings` endpoint accepts a
   signed EIP-712 `Order` (the same struct/domain `Marketplace.sol`
   defines) as JSON, verifies the signature server-side with viem's
   `verifyTypedData` (recovers the signer and checks it equals the
   claimed `maker`) before writing to `marketplace_listing` — rejecting
   garbage is cheap and prevents the browse endpoints from serving
   unsigned junk. This is the one piece of state in this subsystem that
   does **not** come from a chain event, because a listing that nobody
   has fulfilled yet produces no event at all.
5. **Listing invalidation is event-driven, not query-driven**: the
   indexer does **not** call `nonces(maker)` on-chain at submission time
   to check staleness — that would add an RPC round trip (and a
   dependency on RPC availability) to every submission for a check the
   contract already performs authoritatively at fulfillment time anyway.
   Instead, when `OrdersCancelledForMaker` is observed by the ingest
   loop, every open `marketplace_listing` row for that `maker` on that
   network is marked `cancelled` in the same DB transaction. Same
   reactive pattern for `OrderFulfilled`/`OrderCancelled` on a specific
   order hash.
6. **Rate limiting on `POST /listings`**: in-memory token bucket (no new
   dependency — this is a single Node process per deployment, matching
   how everything else here is built), keyed primarily by the **recovered
   signer address** (requires an actual private key to rotate, unlike an
   IP) with a secondary, stricter per-IP bucket applied before signature
   verification (so an attacker can't force unbounded ECDSA-recovery CPU
   work with garbage signatures).
7. **HTTP API additions**: `GET /listings`, `GET /offers`, `GET /auctions`
   (all filterable by `network`, `collection` i.e. `nftContract`, and
   `tokenId`), `GET /collections/:address/royalty`, and `POST /listings`.
   The existing router is a `switch` on exact `url.pathname` with no
   method dispatch at all (every existing route is implicitly GET); this
   adds the first routes that need (a) a non-GET method and (b) a path
   parameter (`:address`). Both are new router capabilities, scoped
   narrowly rather than pulling in a routing library.
8. **Git**: new branch `feat/marketplace-indexing` off `main` (the stale
   `feat/github-ci-cd` remote branch predates the EVM migration and is not
   usable as a base — confirmed via `git diff origin/main..origin/feat/github-ci-cd`
   showing it would delete thousands of lines that exist on current
   `main`).
9. **CI**: new `.github/workflows/test.yml` running
   `npm ci && npm run typecheck && npm test` on PRs and pushes to `main`.
   The existing `.github/workflows/deploy.yml` (SSH deploy on push to
   `main`) is untouched — this is a gate added alongside it, not a
   replacement.

## Event → table mapping

All tables carry a `network` column (same convention as every existing
`evm_*` table) and use `NUMERIC(78,0)` for uint256 fields, lowercase
`TEXT` for addresses/hashes — matching the existing schema exactly.

**`Marketplace.sol` events** (ABI confirmed via `forge inspect` against the
already-built contracts in `apps/marketplace`):

- `OrderFulfilled(bytes32 indexed orderHash, address indexed buyer, uint256 amount)`
  → update `marketplace_listing` (match on `order_hash`): add `amount` to
  `filled_amount`; if now fully filled, `status = 'fulfilled'`.
- `OrderCancelled(bytes32 indexed orderHash)` → update matching
  `marketplace_listing.status = 'cancelled'`.
- `OrdersCancelledForMaker(address indexed maker, uint256 newNonce)` →
  update every open `marketplace_listing` row for that `maker` (network
  + maker match) with `nonce < newNonce` to `status = 'cancelled'`.
- `OfferPlaced(uint256 indexed offerId, address indexed offerer, address nftContract, uint256 tokenId, uint256 amount, uint256 price)`
  → insert `marketplace_offer`.
- `OfferAccepted(uint256 indexed offerId, address indexed seller)` →
  update `marketplace_offer.active = false` (full fill — the contract's
  `acceptOffer` already supports partial ERC-1155 fill internally via
  `offerFilledAmount`/`offerEscrowPaid`, but only emits `OfferAccepted`
  once per call; the indexer does not need to track partial amounts
  separately for v1 browse purposes — a `active = false` after any fill
  stops showing it, full fidelity on partial-fill economics is an
  on-chain-only detail browse doesn't need).
- `OfferCancelled(uint256 indexed offerId)` → update
  `marketplace_offer.active = false`.
- `AuctionStarted(uint256 indexed auctionId, address indexed seller, address nftContract, uint256 tokenId, uint256 amount, uint256 reservePrice, uint256 endTime)`
  → insert `marketplace_auction`.
- `BidPlaced(uint256 indexed auctionId, address indexed bidder, uint256 amount)`
  → update `marketplace_auction.highest_bidder`, `.highest_bid`; endTime
  extension (anti-snipe) is NOT re-derived here — it's read back from
  on-chain state the next time this auction's row changes (the indexer
  mirrors events, it does not reimplement contract logic to predict
  endTime independent of what the contract actually did). **Open
  question resolved in Decisions #10 below.**
- `AuctionCancelled(uint256 indexed auctionId)` → update
  `marketplace_auction.settled = true`, `highest_bidder = NULL`.
- `AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount)`
  → update `marketplace_auction.settled = true`.
- `FeeUpdated`, `FeeRecipientUpdated`, `Withdrawn`,
  `OwnershipTransferred`, `EIP712DomainChanged` → **not** given dedicated
  tables or query support (out of the agreed API scope: listings, offers,
  auctions, royalty). They are still captured automatically in the
  existing generic `evm_log` table (every log is inserted there
  regardless of address), so nothing is lost — just not specially
  queryable yet. Add dedicated handling later if an admin/ops endpoint
  needs it.

**`RoyaltyRegistry.sol` events**:

- `RoyaltyOverrideSet(address indexed nftContract, address receiver, uint96 bps)`
  → upsert `marketplace_royalty_override` (network + nft_contract is the
  primary key — a new event for the same collection replaces the row,
  same semantics as the contract's own `mapping` overwrite).

10. **Anti-snipe endTime**: `BidPlaced` does not carry the (possibly
    extended) `endTime` as a parameter — `Marketplace.sol`'s event only
    emits `(auctionId, bidder, amount)`. Rather than reimplementing the
    10-minute anti-snipe extension math in the indexer (a second place
    the same rule could drift from the contract's), the ingest loop
    re-reads `auctions(auctionId)` from the chain via `client.readContract`
    once per `BidPlaced`/`AuctionStarted` event and stores the
    contract's own `endTime` verbatim. This is one extra RPC read per bid
    — acceptable, since bids are infrequent relative to transfer volume
    this indexer already handles — and it is the only way the indexed
    `endTime` can never disagree with the contract's.

## Database schema (new tables)

```sql
CREATE TABLE IF NOT EXISTS marketplace_listing (
  network       TEXT NOT NULL,
  order_hash    TEXT NOT NULL,
  nft_contract  TEXT NOT NULL,
  token_id      NUMERIC(78,0) NOT NULL,
  amount        NUMERIC(78,0) NOT NULL,
  price         NUMERIC(78,0) NOT NULL,
  maker         TEXT NOT NULL,
  expiry        BIGINT NOT NULL,
  salt          NUMERIC(78,0) NOT NULL,
  nonce         NUMERIC(78,0) NOT NULL,
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'cancelled' | 'fulfilled'
  filled_amount NUMERIC(78,0) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, order_hash)
);
CREATE INDEX IF NOT EXISTS marketplace_listing_browse_idx
  ON marketplace_listing (network, nft_contract, token_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS marketplace_listing_maker_idx
  ON marketplace_listing (network, maker, nonce);

CREATE TABLE IF NOT EXISTS marketplace_offer (
  network       TEXT NOT NULL,
  offer_id      NUMERIC(78,0) NOT NULL,
  nft_contract  TEXT NOT NULL,
  token_id      NUMERIC(78,0) NOT NULL,
  amount        NUMERIC(78,0) NOT NULL,
  price         NUMERIC(78,0) NOT NULL,
  offerer       TEXT NOT NULL,
  expiry        BIGINT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  block_number  BIGINT NOT NULL,
  PRIMARY KEY (network, offer_id)
);
CREATE INDEX IF NOT EXISTS marketplace_offer_browse_idx
  ON marketplace_offer (network, nft_contract, token_id) WHERE active;

CREATE TABLE IF NOT EXISTS marketplace_auction (
  network         TEXT NOT NULL,
  auction_id      NUMERIC(78,0) NOT NULL,
  nft_contract    TEXT NOT NULL,
  token_id        NUMERIC(78,0) NOT NULL,
  amount          NUMERIC(78,0) NOT NULL,
  seller          TEXT NOT NULL,
  reserve_price   NUMERIC(78,0) NOT NULL,
  end_time        BIGINT NOT NULL,
  highest_bidder  TEXT,
  highest_bid     NUMERIC(78,0) NOT NULL DEFAULT 0,
  settled         BOOLEAN NOT NULL DEFAULT false,
  block_number    BIGINT NOT NULL,
  PRIMARY KEY (network, auction_id)
);
CREATE INDEX IF NOT EXISTS marketplace_auction_browse_idx
  ON marketplace_auction (network, nft_contract, token_id);
CREATE INDEX IF NOT EXISTS marketplace_auction_active_idx
  ON marketplace_auction (network, end_time) WHERE NOT settled;

CREATE TABLE IF NOT EXISTS marketplace_royalty_override (
  network       TEXT NOT NULL,
  nft_contract  TEXT NOT NULL,
  receiver      TEXT NOT NULL,
  bps           INTEGER NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, nft_contract)
);
```

## Config additions

`src/config.ts`'s `EvmNetworkConfig` gains two optional fields, following
the exact pattern `minarAddress` already established (optional, omitted
until deployed, no error when absent):

```ts
export type EvmNetworkConfig = {
  // ...existing fields...
  marketplaceAddress?: string;
  royaltyRegistryAddress?: string;
};
```

New env vars: `MAINNET_MARKETPLACE_ADDRESS`, `TESTNET_MARKETPLACE_ADDRESS`,
`MAINNET_ROYALTY_REGISTRY_ADDRESS`, `TESTNET_ROYALTY_REGISTRY_ADDRESS` —
all optional, documented in `.env.example` the same way MINAR's are.

## HTTP API

All new endpoints respect the existing `isAuthorised()`/`x-api-key` gate
(not added to `PUBLIC_PATHS`) and the existing `send()` JSON-response
helper.

- `GET /listings?network=&collection=&tokenId=&maker=` — open listings,
  newest first, optionally filtered. `collection`/`tokenId` filter by
  `nft_contract`/`token_id`; `maker` filters by maker address (for "my
  listings").
- `POST /listings` — body: the signed `Order` (mirrors
  `Marketplace.sol`'s struct field names exactly: `nftContract`,
  `tokenId`, `amount`, `price`, `maker`, `expiry`, `salt`, `nonce`) plus
  `signature`. Verifies the EIP-712 signature server-side (domain name
  `"NagaraMarketplace"`, version `"1"`, `chainId` from the network's
  config, `verifyingContract` = that network's configured
  `marketplaceAddress`) before insert. 400 on bad signature/missing
  field/missing configured marketplace address for that network, 429 on
  rate-limit, 201 with the computed `orderHash` on success.
- `GET /offers?network=&collection=&tokenId=` — active offers.
- `GET /auctions?network=&collection=&tokenId=&status=active|ended` —
  auctions; `status=active` means `NOT settled AND end_time > now()`.
- `GET /collections/:address/royalty?network=` — returns the
  `marketplace_royalty_override` row for that address if one exists,
  else `{ receiver: null, bps: null }`. This does **not** call the
  deployed `RoyaltyRegistry.getRoyalty()` on-chain (which would also
  check EIP-2981) — it only reports the override half, since the
  override is the only part this indexer is the source of truth for; a
  frontend needing the full resolved royalty (EIP-2981 OR override)
  calls the contract directly, same as any other read.

## Signature verification & rate limiting

New file `src/evm/orderSignature.ts`:

```ts
import { verifyTypedData } from "viem";

export async function verifyListingSignature(
  chainId: number,
  verifyingContract: `0x${string}`,
  order: {
    nftContract: `0x${string}`; tokenId: bigint; amount: bigint;
    price: bigint; maker: `0x${string}`; expiry: bigint; salt: bigint; nonce: bigint;
  },
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedData({
    address: order.maker,
    domain: { name: "NagaraMarketplace", version: "1", chainId, verifyingContract },
    types: {
      Order: [
        { name: "nftContract", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "price", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "expiry", type: "uint256" },
        { name: "salt", type: "uint256" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "Order",
    message: order,
    signature,
  });
}
```

New file `src/rateLimit.ts` — in-memory token bucket, two buckets:

```ts
type Bucket = { tokens: number; lastRefillMs: number };

export function makeLimiter(capacity: number, refillPerSec: number) {
  const buckets = new Map<string, Bucket>();
  return function allow(key: string): boolean {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: capacity, lastRefillMs: now };
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.lastRefillMs = now;
    if (b.tokens < 1) { buckets.set(key, b); return false; }
    b.tokens -= 1;
    buckets.set(key, b);
    return true;
  };
}
```

`POST /listings` applies an IP-keyed limiter (strict, e.g. 5/min) before
signature verification, then a signer-address-keyed limiter (looser,
e.g. 20/min) after the signature recovers successfully — a valid signer
can list reasonably often; an unauthenticated IP cannot force expensive
recovery work repeatedly.

## Router changes

`src/server.ts`'s `switch (url.pathname)` gains:

- Method dispatch: `/listings` now needs both GET and POST, so that case
  branches on `request.method` internally.
- One parameterized route: `/collections/:address/royalty`, matched with
  a regex check (`/^\/collections\/(0x[0-9a-fA-F]{40})\/royalty$/`)
  placed before the `switch`'s `default` — the switch still handles
  every literal-path route unchanged, this is additive, not a
  restructure of the existing routing.
- A new `readJsonBody(request)` helper (collects the request stream into
  a buffer, `JSON.parse`s it, with a size cap — e.g. 8 KB, a signed
  `Order` is a few hundred bytes — to avoid an unbounded body DoS) since
  nothing in this codebase has needed a request body before now.

## Testing

Following the existing convention exactly (`node --test`, real local
Postgres via `DATABASE_URL`, a unique fake `network` id per test file to
isolate rows in shared tables — see `test/evmQueries.test.ts`):

- `test/marketplaceIngest.test.ts` — feeds synthetic logs (matching the
  real ABI's encoding) through the new classifier + `ingestBlock`
  integration, asserts the resulting rows in all four new tables for
  every event in the mapping above, including the reactive
  `OrdersCancelledForMaker` mass-cancellation.
- `test/orderSignature.test.ts` — valid signature accepted, wrong signer
  rejected, tampered field (e.g. price changed after signing) rejected.
- `test/marketplaceQueries.test.ts` — browse queries (`listListings`,
  `listOffers`, `listAuctions`, `getRoyaltyOverride`) against seeded
  rows, including the filter combinations the API exposes.
- `test/rateLimit.test.ts` — bucket refills correctly over time
  (fake/controlled clock, not real sleep), rejects over capacity.
- `test/server.test.ts` (existing file, extended) — `POST /listings`
  happy path end-to-end (sign with a real test private key via viem,
  submit, assert 201 + row exists), bad signature → 400, missing
  `marketplaceAddress` config for a network → clear error not a crash,
  rate limit → 429, `GET /collections/:address/royalty` for an address
  with no override → `{ receiver: null, bps: null }`.

## Security notes

- `POST /listings` never trusts the client's claimed `orderHash` — it is
  always recomputed server-side from the submitted fields before storage
  and before signature verification, so a client cannot submit a
  mismatched hash/signature pair that passes by coincidence.
- The contract, not this indexer, is the authority on whether a listing
  is actually fulfillable (ownership, approval, nonce) at the moment
  someone tries to fulfill it — this indexer's `status` field is a
  best-effort cache for browsing, and `fulfillListing` on-chain
  re-validates everything regardless, exactly as `apps/marketplace`'s
  own design spec already establishes. A stale/incorrect row here is a
  UX inconvenience, never a fund-safety issue.
- Rate limiter state is in-memory and per-process — acceptable for a
  single-process deployment (matches this service's actual deployment
  shape per `DEPLOYMENT.md`); restarting the process resets limits,
  which is a known, accepted gap, not silently covered up.

## Explicitly out of scope for this piece (confirmed with the human partner)

- Marketplace frontend UI, wallet-connect/signing UX — a different
  team's responsibility.
- NFT asset/metadata storage (IPFS/S3) — belongs to Subsystem A
  (minting factory), not yet built.
- Dedicated tables/endpoints for `FeeUpdated`, `FeeRecipientUpdated`,
  `Withdrawn`, `OwnershipTransferred` — captured passively in `evm_log`,
  revisit if an admin/ops view needs them.
- Full EIP-2981-aware royalty resolution via this API (only the
  override half is served) — the contract is the full source of truth.
- Redis/external rate-limit store — single in-memory limiter is
  sufficient for this service's actual (single-process) deployment.

## Open questions for implementation planning

- Exact file layout for the new marketplace-indexing code: one
  `src/evm/marketplace.ts` module (classifier + ABI constants) plus one
  `src/evm/marketplaceQueries.ts` (browse queries), mirroring
  `tokens.ts`/`queries.ts`'s existing split — or finer-grained — decide
  during planning.
- Whether `readJsonBody`'s 8 KB cap needs to be configurable — start
  hardcoded, revisit if a real payload ever needs more.
