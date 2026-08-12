import type { ApiPromise } from "@polkadot/api";
import type { TxWithEvent } from "@polkadot/api-derive/types";
import type { DispatchError, Event } from "@polkadot/types/interfaces";
import type { GenericExtrinsic } from "@polkadot/types";
import type { Codec } from "@polkadot/types/types";
import { formatAmount } from "./format.js";
import type { ChainExtrinsic, ExtrinsicKind } from "./types.js";

/** Every Substrate block carries a `timestamp.set` inherent — read it there. */
export function readBlockTimestamp(txs: TxWithEvent[]): number {
  const setter = txs.find(
    (tx) =>
      tx.extrinsic.method.section === "timestamp" &&
      tx.extrinsic.method.method === "set"
  );
  const raw = setter?.extrinsic.method.args[0]?.toString();
  const ms = raw ? Number(raw) : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

/** dispatchInfo.weight is a Weight struct on current runtimes, a u64 on old ones. */
export function readWeight(
  dispatchInfo?: TxWithEvent["dispatchInfo"]
): number {
  const weight = dispatchInfo?.weight as unknown as
    | { refTime?: { toBigInt: () => bigint }; toBigInt?: () => bigint }
    | undefined;
  if (!weight) return 0;
  if (weight.refTime) return Number(weight.refTime.toBigInt());
  if (weight.toBigInt) return Number(weight.toBigInt());
  return 0;
}

function decodeTransfer(
  section: string,
  method: string,
  args: readonly Codec[]
): { dest: string | null; amount: string | null; amountRaw: string | null } {
  if (section !== "balances" || !method.startsWith("transfer")) {
    return { dest: null, amount: null, amountRaw: null };
  }
  const [dest, value] = args;
  const destHuman = dest?.toHuman();
  return {
    dest:
      destHuman && typeof destHuman === "object"
        ? String(Object.values(destHuman)[0] ?? "")
        : (destHuman?.toString() ?? null),
    amount: value ? formatAmount(value.toString()) : null,
    amountRaw: value ? value.toString() : null,
  };
}

/** MultiAddress / AccountId arguments come back as `{ Id: "5…" }` or a string. */
function readAddress(arg?: Codec): string | null {
  const human = arg?.toHuman();
  if (!human) return null;
  if (typeof human === "object") {
    return String(Object.values(human)[0] ?? "") || null;
  }
  return human.toString() || null;
}

/**
 * pallet-contracts call shapes on this runtime (verified against its metadata):
 *   call(dest, value, gasLimit, storageDepositLimit, data)
 *   instantiateWithCode(value, gasLimit, storageDepositLimit, code, data, salt)
 *   instantiate(value, gasLimit, storageDepositLimit, codeHash, data, salt)
 *   uploadCode(code, storageDepositLimit, determinism)
 *   setCode(dest, codeHash) / removeCode(codeHash)
 *
 * A deploy does not carry its own address — that only exists in the
 * `contracts.Instantiated { deployer, contract }` event.
 */
function decodeContract(
  section: string,
  method: string,
  args: readonly Codec[],
  events: Event[]
): {
  kind: ExtrinsicKind;
  contract: string | null;
  codeHash: string | null;
  amount: string | null;
  amountRaw: string | null;
  dest: string | null;
  callData: string | null;
  contractEvents: number;
  emitted: { contract: string; data: string }[];
} | null {
  if (section !== "contracts") return null;

  const emitted = events
    .filter(
      (event) =>
        event.section === "contracts" && event.method === "ContractEmitted"
    )
    .map((event) => ({
      contract: event.data[0]?.toString() ?? "",
      data: event.data[1]?.toHex?.() ?? event.data[1]?.toString() ?? "0x",
    }));
  const contractEvents = emitted.length;

  const eventAddress = (name: string, index: number): string | null => {
    const found = events.find(
      (event) => event.section === "contracts" && event.method === name
    );
    return found ? (found.data[index]?.toString() ?? null) : null;
  };

  const rawValue = (value?: Codec): string | null => {
    const raw = value?.toString();
    return raw && raw !== "0" ? raw : null;
  };
  const withValue = (value?: Codec): string | null => {
    const raw = rawValue(value);
    return raw ? formatAmount(raw) : null;
  };

  if (method.startsWith("call")) {
    const dest = readAddress(args[0]);
    return {
      kind: "contractCall",
      contract: dest,
      codeHash: null,
      amount: withValue(args[1]),
      amountRaw: rawValue(args[1]),
      dest,
      callData: args[4]?.toHex?.() ?? null,
      contractEvents,
      emitted,
    };
  }

  if (method.startsWith("instantiate")) {
    const contract = eventAddress("Instantiated", 1);
    return {
      kind: "contractDeploy",
      contract,
      codeHash: method.startsWith("instantiateWithCode")
        ? eventAddress("CodeStored", 0)
        : (args[3]?.toString() ?? null),
      amount: withValue(args[0]),
      amountRaw: rawValue(args[0]),
      dest: contract,
      callData: args[4]?.toHex?.() ?? null,
      contractEvents,
      emitted,
    };
  }

  if (method === "uploadCode") {
    return {
      kind: "contractUpload",
      contract: null,
      codeHash: eventAddress("CodeStored", 0),
      amount: null,
      amountRaw: null,
      dest: null,
      callData: null,
      contractEvents,
      emitted,
    };
  }

  if (method === "setCode") {
    const dest = readAddress(args[0]);
    return {
      kind: "contractOther",
      contract: dest,
      codeHash: args[1]?.toString() ?? null,
      amount: null,
      amountRaw: null,
      dest,
      callData: null,
      contractEvents,
      emitted,
    };
  }

  return {
    kind: "contractOther",
    contract: null,
    codeHash: null,
    amount: null,
    amountRaw: null,
    dest: null,
    callData: null,
    contractEvents,
    emitted,
  };
}

function decodeDispatchError(api: ApiPromise, error: DispatchError): string {
  if (!error.isModule) return error.type;
  try {
    const meta = api.registry.findMetaError(error.asModule);
    return `${meta.section}.${meta.name}`;
  } catch {
    return error.type;
  }
}

/**
 * Turns one entry of a derived block's `extrinsics` into the flat shape the UI
 * consumes. Note that a TxWithEvent carries bare Events, not EventRecords —
 * there is no `.event` or `.phase` on them, and they are already scoped to this
 * extrinsic.
 */
export function decodeExtrinsic({
  api,
  extrinsic,
  index,
  blockNumber,
  blockHash,
  timestamp,
  events,
  dispatchError,
}: {
  api: ApiPromise;
  extrinsic: GenericExtrinsic;
  index: number;
  blockNumber: number;
  blockHash: string;
  timestamp: string;
  events: Event[];
  dispatchError?: DispatchError;
}): ChainExtrinsic {
  const { section, method, args } = extrinsic.method;

  const feeEvent =
    events.find((event) => event.method === "TransactionFeePaid") ??
    events.find(
      (event) => event.section === "balances" && event.method === "Withdraw"
    );

  const transfer = decodeTransfer(section, method, args);
  const contract = decodeContract(section, method, args, events);

  return {
    id: `${blockNumber}-${index}`,
    blockNumber,
    blockHash,
    extrinsicIndex: index,
    extrinsicHash: extrinsic.hash.toHex(),
    isSigned: extrinsic.isSigned,
    signer: extrinsic.isSigned ? extrinsic.signer.toString() : null,
    section,
    method,
    methodFull: `${section}.${method}`,
    args: JSON.stringify(args.map((arg) => arg.toHuman())),
    success: !dispatchError,
    error: dispatchError ? decodeDispatchError(api, dispatchError) : null,
    timestamp,
    dest: contract?.dest ?? transfer.dest,
    amount: contract?.amount ?? transfer.amount,
    fee: feeEvent ? formatAmount(feeEvent.data[1]?.toString() ?? "0") : null,
    amountRaw: contract?.amountRaw ?? transfer.amountRaw,
    feeRaw: feeEvent ? (feeEvent.data[1]?.toString() ?? "0") : null,
    kind: contract?.kind ?? (transfer.amount ? "transfer" : "other"),
    contract: contract?.contract ?? null,
    codeHash: contract?.codeHash ?? null,
    callData: contract?.callData ?? null,
    contractEvents: contract?.contractEvents ?? 0,
    contractEmitted: contract?.emitted ?? [],
  };
}

/** Decodes a whole derived block's extrinsics in one call. */
export function decodeBlockExtrinsics({
  api,
  txs,
  blockNumber,
  blockHash,
  timestamp,
}: {
  api: ApiPromise;
  txs: TxWithEvent[];
  blockNumber: number;
  blockHash: string;
  timestamp: string;
}): ChainExtrinsic[] {
  return txs.map((tx, index) =>
    decodeExtrinsic({
      api,
      extrinsic: tx.extrinsic,
      index,
      blockNumber,
      blockHash,
      timestamp,
      events: tx.events,
      dispatchError: tx.dispatchError,
    })
  );
}

/**
 * Plain-language sentence for one extrinsic, so the block detail page reads as
 * "what happened" rather than a pile of hashes.
 */
export function describeExtrinsic(extrinsic: ChainExtrinsic): string {
  const {
    section,
    method,
    methodFull,
    signer,
    dest,
    amount,
    args,
    kind,
    contract,
    codeHash,
    contractEvents,
  } = extrinsic;

  if (kind === "transfer") {
    if (amount && signer && dest) {
      return `Transferred ${amount} from ${signer} to ${dest}`;
    }
    if (amount) return `Transferred ${amount}`;
  }

  if (kind === "contractDeploy") {
    const where = contract ? ` at ${contract}` : "";
    const endowment = amount ? ` with an endowment of ${amount}` : "";
    return `${signer ?? "Someone"} deployed a contract${where}${endowment}`;
  }

  if (kind === "contractCall") {
    const target = contract ? ` ${contract}` : "";
    const sent = amount ? `, sending ${amount}` : "";
    const emitted =
      contractEvents > 0
        ? ` — the contract emitted ${contractEvents} event${contractEvents === 1 ? "" : "s"}`
        : "";
    return `${signer ?? "Someone"} called contract${target}${sent}${emitted}`;
  }

  if (kind === "contractUpload") {
    return `${signer ?? "Someone"} uploaded contract code${codeHash ? ` ${codeHash}` : ""}`;
  }

  if (section === "timestamp" && method === "set") {
    return `Set the block timestamp to ${extrinsic.timestamp}`;
  }

  if (signer) return `${signer} called ${methodFull}`;

  // Unsigned inherents and anything not specially handled.
  return `${methodFull} ${args}`;
}

/** True when the extrinsic actually moved funds. */
export function isValueTransfer(extrinsic: ChainExtrinsic): boolean {
  return Boolean(extrinsic.amount && extrinsic.dest);
}

/**
 * What belongs in the transactions list: value movement plus every contract
 * deploy/call/upload. Inherents and other housekeeping extrinsics stay out.
 */
export function isListedTransaction(extrinsic: ChainExtrinsic): boolean {
  return extrinsic.kind !== "other";
}
