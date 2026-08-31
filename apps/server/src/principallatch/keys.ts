import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface PrincipalLatchKeyMaterial {
  passportPrivateKey: KeyObject;
  passportPublicKey: KeyObject;
  passportSeed: Uint8Array;
  mandateSeed: Uint8Array;
}

export function keyMaterialFromSeeds(
  passportSeed: Uint8Array,
  mandateSeed: Uint8Array,
): PrincipalLatchKeyMaterial {
  assertSeed(passportSeed, "Passport");
  assertSeed(mandateSeed, "Mandate");
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(passportSeed)]),
    format: "der",
    type: "pkcs8",
  });
  return {
    passportPrivateKey: privateKey,
    passportPublicKey: createPublicKey(privateKey),
    passportSeed: Uint8Array.from(passportSeed),
    mandateSeed: Uint8Array.from(mandateSeed),
  };
}

export async function loadOrCreateKeyMaterial(
  keyDirectory: string,
): Promise<PrincipalLatchKeyMaterial> {
  await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
  const [passportSeed, mandateSeed] = await Promise.all([
    loadOrCreateSeed(path.join(keyDirectory, "passport-ed25519.seed")),
    loadOrCreateSeed(path.join(keyDirectory, "mandate-ed25519.seed")),
  ]);
  return keyMaterialFromSeeds(passportSeed, mandateSeed);
}

async function loadOrCreateSeed(filePath: string): Promise<Uint8Array> {
  try {
    const existing = await readFile(filePath);
    assertSeed(existing, path.basename(filePath));
    return Uint8Array.from(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const generated = randomBytes(32);
  try {
    const handle = await open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(generated);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return Uint8Array.from(generated);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await readFile(filePath);
    assertSeed(raced, path.basename(filePath));
    return Uint8Array.from(raced);
  }
}

function assertSeed(seed: Uint8Array, label: string): void {
  if (seed.byteLength !== 32) {
    throw new Error(`${label} Ed25519 seed must contain exactly 32 bytes`);
  }
}
