// `pg` returns NUMERIC as a string to avoid float precision loss. These two
// helpers are the only place a NUMERIC column should be converted to/from a
// JS bigint in the EVM ingestion path.

export function toNumeric(v: bigint): string {
  return v.toString();
}

export function fromNumeric(v: string | null): bigint {
  return v === null ? 0n : BigInt(v);
}
