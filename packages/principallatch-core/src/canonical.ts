import type { MandateV1 } from "./schema.js";

export function canonicalBytes(mandate: MandateV1): Uint8Array {
  const payload = structuredClone(mandate);
  payload.signature = "";
  return new TextEncoder().encode(JSON.stringify(sortKeysDeep(payload)));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}
