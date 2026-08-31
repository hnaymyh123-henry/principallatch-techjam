import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export async function ensureTrustedRoot(
  rootPath: string,
  label: string,
): Promise<string> {
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  return verifyRealDirectory(rootPath, label);
}

export async function ensureManagedChildDirectory(
  parentPath: string,
  childPath: string,
  label: string,
): Promise<string> {
  const lexicalParent = path.resolve(parentPath);
  const lexicalChild = path.resolve(childPath);
  if (!samePath(path.dirname(lexicalChild), lexicalParent)) {
    throw new Error(`${label} must be a direct child of its managed parent`);
  }

  const canonicalParent = await verifyRealDirectory(parentPath, `${label} parent`);
  try {
    await mkdir(childPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonicalChild = await verifyRealDirectory(childPath, label);
  if (!samePath(path.dirname(canonicalChild), canonicalParent)) {
    throw new Error(`${label} escapes its managed workspace boundary`);
  }
  return canonicalChild;
}

export async function replaceManagedFile(
  parentPath: string,
  fileName: string,
  content: string,
): Promise<string> {
  if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new Error("Managed file name must be a basename");
  }
  const canonicalParent = await verifyRealDirectory(parentPath, "managed file parent");
  const target = path.join(canonicalParent, fileName);
  const temporary = path.join(
    canonicalParent,
    `.${fileName}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      const targetStatus = await lstat(target);
      if (targetStatus.isDirectory() && !targetStatus.isSymbolicLink()) {
        throw new Error(`Managed file target is a directory: ${target}`);
      }
      await unlink(target);
      await rename(temporary, target);
    }
    return target;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function writeManagedFileIfMissing(
  parentPath: string,
  fileName: string,
  content: string,
): Promise<void> {
  if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
    throw new Error("Managed file name must be a basename");
  }
  const canonicalParent = await verifyRealDirectory(parentPath, "managed file parent");
  const target = path.join(canonicalParent, fileName);
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const status = await lstat(target);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`Managed file target is not a regular file: ${target}`);
    }
  }
}

async function verifyRealDirectory(
  directoryPath: string,
  label: string,
): Promise<string> {
  const status = await lstat(directoryPath);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link`);
  }
  return realpath(directoryPath);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
