import { createHash } from "node:crypto";
import * as ed25519 from "@noble/ed25519";
import { canonicalBytes } from "./canonical.js";
import { parseMandate, type MandateV1 } from "./schema.js";

export async function publicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  assertLength(seed, 32, "Ed25519 seed");
  return ed25519.getPublicKeyAsync(seed);
}

export function publicKeyToString(raw: Uint8Array): string {
  assertLength(raw, 32, "Ed25519 public key");
  return `ed25519:${Buffer.from(raw).toString("base64")}`;
}

export function publicKeyFromString(value: string): Uint8Array {
  return decodePrefixed(value, 32, "Ed25519 public key");
}

export function kidForPublicKey(publicKey: string): string {
  return createHash("sha256")
    .update(publicKeyFromString(publicKey))
    .digest("hex")
    .slice(0, 16);
}

export function fingerprintOf(publicKey: string): string {
  return `sha256:${createHash("sha256")
    .update(publicKeyFromString(publicKey))
    .digest("hex")}`;
}

export async function signMandate(
  input: MandateV1,
  privateKeySeed: Uint8Array,
): Promise<MandateV1> {
  assertLength(privateKeySeed, 32, "Ed25519 seed");
  const mandate = parseMandate(input);
  const derivedPublicKey = publicKeyToString(
    await publicKeyFromSeed(privateKeySeed),
  );
  if (mandate.issuer.publicKey !== derivedPublicKey) {
    throw new Error("Embedded issuer public key does not match the signing seed");
  }
  assertIssuerMetadata(mandate);
  const unsigned = structuredClone(mandate);
  unsigned.signature = "";
  const signature = await ed25519.signAsync(
    canonicalBytes(unsigned),
    privateKeySeed,
  );
  return parseMandate({
    ...unsigned,
    signature: `ed25519:${Buffer.from(signature).toString("base64")}`,
  });
}

export async function verifyMandate(input: unknown): Promise<boolean> {
  try {
    const mandate = parseMandate(input);
    if (!mandate.signature) return false;
    assertIssuerMetadata(mandate);
    const signature = decodePrefixed(
      mandate.signature,
      64,
      "Ed25519 signature",
    );
    return await ed25519.verifyAsync(
      signature,
      canonicalBytes(mandate),
      publicKeyFromString(mandate.issuer.publicKey),
    );
  } catch {
    return false;
  }
}

function assertIssuerMetadata(mandate: MandateV1): void {
  if (mandate.issuer.kid !== kidForPublicKey(mandate.issuer.publicKey)) {
    throw new Error("Issuer kid does not match issuer public key");
  }
  if (
    mandate.issuer.fingerprint !== fingerprintOf(mandate.issuer.publicKey)
  ) {
    throw new Error("Issuer fingerprint does not match issuer public key");
  }
}

function decodePrefixed(
  value: string,
  expectedLength: number,
  label: string,
): Uint8Array {
  if (!value.startsWith("ed25519:")) {
    throw new Error(`${label} must use the ed25519 prefix`);
  }
  const encoded = value.slice("ed25519:".length);
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength !== expectedLength ||
    decoded.toString("base64") !== encoded
  ) {
    throw new Error(`${label} must be canonical base64 for ${expectedLength} bytes`);
  }
  return new Uint8Array(decoded);
}

function assertLength(value: Uint8Array, expected: number, label: string): void {
  if (value.byteLength !== expected) {
    throw new Error(`${label} must be ${expected} bytes`);
  }
}
