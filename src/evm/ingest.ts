import type { PublicClient } from "viem";
import { getBlockReceipts } from "./rpc.js";
import { classifyTransferLog, detectToken } from "./tokens.js";
import { toNumeric } from "./numeric.js";
import { getPool, tx } from "../db.js";
import type { NetworkId } from "../config.js";

const lower = (s: string | null | undefined) => (s ? s.toLowerCase() : null);
/** BYTEA columns are written through decode(…, 'hex'), which wants bare hex. */
const bare = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

/**
 * Writes one finalized block and everything in it — transactions, logs, token
 * transfers and the cursor — in a single Postgres transaction. Every insert is
 * idempotent, so re-ingesting a block is a no-op rather than a duplicate.
 *
 * All RPC happens before the transaction opens: a database transaction must
 * never be held open across network I/O.
 */
export async function ingestBlock(
  client: PublicClient,
  network: NetworkId,
  blockNumber: bigint,
): Promise<void> {
  const block = await client.getBlock({ blockNumber, includeTransactions: true });
  const receipts = (await getBlockReceipts(client, blockNumber)) ?? [];

  // Metadata for tokens seen for the first time. Fetched here, before BEGIN,
  // and only for addresses not already recorded — a token row never changes.
  const seen = new Map<string, "erc20" | "erc721" | "erc1155">();
  for (const r of receipts) {
    for (const log of r.logs) {
      const cls = classifyTransferLog(log);
      const address = lower(log.address);
      if (cls && address && !seen.has(address)) seen.set(address, cls[0].standard);
    }
  }
  const metadata = new Map<string, Awaited<ReturnType<typeof detectToken>>>();
  if (seen.size) {
    const { rows: known } = await getPool().query<{ address: string }>(
      "SELECT address FROM evm_token WHERE network = $1 AND address = ANY($2)",
      [network, [...seen.keys()]],
    );
    for (const k of known) seen.delete(k.address);
    for (const [address, type] of seen) {
      metadata.set(address, await detectToken(client, address, type));
    }
  }

  await tx(async (c) => {
    await c.query(
      `INSERT INTO evm_block (network, number, hash, parent_hash, timestamp, author,
                              gas_used, gas_limit, base_fee, tx_count)
       VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10)
       ON CONFLICT (network, number) DO UPDATE SET hash = EXCLUDED.hash`,
      [
        network,
        toNumeric(block.number),
        lower(block.hash),
        lower(block.parentHash),
        Number(block.timestamp),
        lower(block.miner),
        toNumeric(block.gasUsed),
        toNumeric(block.gasLimit),
        block.baseFeePerGas != null ? toNumeric(block.baseFeePerGas) : null,
        block.transactions.length,
      ],
    );

    const byHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));

    for (const [i, t] of block.transactions.entries()) {
      const r = byHash.get(t.hash.toLowerCase());
      await c.query(
        `INSERT INTO evm_tx (network, hash, block_number, tx_index, from_addr, to_addr,
           value, gas_used, gas_price, effective_gas_price, status, nonce, input, contract_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,decode($13,'hex'),$14)
         ON CONFLICT (network, hash) DO NOTHING`,
        [
          network,
          lower(t.hash),
          toNumeric(block.number),
          t.transactionIndex ?? i,
          lower(t.from),
          lower(t.to),
          toNumeric(t.value),
          r ? toNumeric(BigInt(r.gasUsed)) : "0",
          t.gasPrice != null ? toNumeric(t.gasPrice) : null,
          r?.effectiveGasPrice ? toNumeric(BigInt(r.effectiveGasPrice)) : null,
          r ? Number(BigInt(r.status)) : 0,
          toNumeric(BigInt(t.nonce)),
          bare(t.input),
          lower(r?.contractAddress),
        ],
      );
    }

    for (const r of receipts) {
      for (const log of r.logs) {
        const [t0, t1, t2, t3] = log.topics;
        const logIndex = Number(BigInt(log.logIndex));
        await c.query(
          `INSERT INTO evm_log (network, tx_hash, log_index, block_number, address,
                                topic0, topic1, topic2, topic3, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'))
           ON CONFLICT (network, tx_hash, log_index) DO NOTHING`,
          [
            network,
            lower(r.transactionHash),
            logIndex,
            toNumeric(block.number),
            lower(log.address),
            lower(t0),
            lower(t1),
            lower(t2),
            lower(t3),
            bare(log.data),
          ],
        );

        const cls = classifyTransferLog(log);
        if (!cls) continue;
        const address = lower(log.address)!;

        const md = metadata.get(address);
        await c.query(
          `INSERT INTO evm_token (network, address, type, name, symbol, decimals, first_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (network, address) DO NOTHING`,
          [
            network,
            address,
            cls[0].standard,
            md?.name ?? null,
            md?.symbol ?? null,
            md?.decimals ?? null,
            toNumeric(block.number),
          ],
        );

        // One ERC-1155 TransferBatch log expands into several transfers that
        // all share a log_index, so sub_index separates them. Every other
        // standard produces exactly one entry, at sub_index 0.
        for (const [subIndex, x] of cls.entries()) {
          await c.query(
            `INSERT INTO evm_token_transfer (network, tx_hash, log_index, sub_index, block_number,
               token, from_addr, to_addr, value, token_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (network, tx_hash, log_index, sub_index) DO NOTHING`,
            [
              network,
              lower(r.transactionHash),
              logIndex,
              subIndex,
              toNumeric(block.number),
              address,
              x.from,
              x.to,
              x.value != null ? toNumeric(x.value) : null,
              x.tokenId != null ? toNumeric(x.tokenId) : null,
            ],
          );
        }
      }
    }

    await c.query(
      `INSERT INTO evm_cursor (network, last_indexed_block) VALUES ($1,$2)
       ON CONFLICT (network) DO UPDATE
         SET last_indexed_block = GREATEST(evm_cursor.last_indexed_block, EXCLUDED.last_indexed_block)`,
      [network, toNumeric(blockNumber)],
    );
  });
}
