/**
 * A block as consumed by the UI. The first eight fields intentionally mirror
 * `BlockItem` from the REST layer so existing components keep working.
 */
export type ChainBlock = {
  id: string;
  blockNumber: number;
  hash: string;
  parentHash: string;
  stateRoot: string;
  extrinsicsRoot: string;
  timestamp: string;
  extrinsicsCount: number;
  /** Block author from the consensus digest — the "sequencer" of the UI. */
  author: string | null;
  /** Consumed refTime weight of the block. */
  weightUsed: number;
  /** Max refTime weight allowed per block. */
  weightMax: number;
  /** weightUsed / weightMax, in percent. */
  weightPercent: number;
  finalized: boolean;
};

/**
 * What kind of activity an extrinsic represents. Drives both the transactions
 * list filter and the plain-language description.
 */
export type ExtrinsicKind =
  | "transfer"
  | "contractDeploy"
  | "contractCall"
  | "contractUpload"
  | "contractOther"
  | "other";

/**
 * An extrinsic as consumed by the UI. Mirrors `TransactionItem` from the REST
 * layer, plus the transfer/contract/fee fields the tables need.
 */
export type ChainExtrinsic = {
  id: string;
  blockNumber: number;
  blockHash: string;
  extrinsicIndex: number;
  extrinsicHash: string;
  isSigned: boolean;
  signer: string | null;
  section: string;
  method: string;
  methodFull: string;
  args: string;
  success: boolean;
  error: string | null;
  timestamp: string;
  /** Destination address for balance transfers and contract calls, else null. */
  dest: string | null;
  /** Formatted transferred amount, else null. */
  amount: string | null;
  /** Formatted fee actually paid, else null. */
  fee: string | null;
  /** Same values in raw chain units — what the indexer stores. */
  amountRaw: string | null;
  feeRaw: string | null;
  kind: ExtrinsicKind;
  /** Contract address involved, for deploys and calls. */
  contract: string | null;
  /** Code hash, for uploads and code updates. */
  codeHash: string | null;
  /**
   * Raw ink! message data of a contract call: `[4-byte selector, ...SCALE args]`.
   * The selector identifies the message by name alone, so a standard-conforming
   * call can be interpreted without the contract's ABI.
   */
  callData: string | null;
  /** How many events the contract emitted — ink! event payloads need its ABI. */
  contractEvents: number;
  /**
   * Raw `contracts.ContractEmitted` payloads, kept as hex so a page holding the
   * matching ink! ABI can decode them into named events.
   */
  contractEmitted: { contract: string; data: string }[];
};
