import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as Y from "yjs";
import { CommentsError } from "./errors.js";

/** The most bytes a saved document holds. A save over this is refused, so a file never grows past what a load accepts. */
export const MAX_FILE = 50 * 1024 * 1024;
const MAGIC = Buffer.from("ACV1");
const HASH = 32;
const POLL_MS = 25;
const EMPTY_LOCK_MS = 2_000;
/** A write takes milliseconds. A lock older than this is left over, even when its process id is taken again. */
const LOCK_MAX_AGE_MS = 60_000;
const ATTEMPTS = 4;

export interface FileStoreOptions {
  /** How long a write waits for another process. A whole number of ms, 0 or more. Default 5,000. */
  lockTimeoutMs?: number;
}

/** Read the lock timeout from `AGENTIC_COMMENTS_LOCK_TIMEOUT_MS`. Anything but a whole number of ms is an error. */
export function lockTimeoutFrom(env: Record<string, string | undefined>): number | undefined {
  const raw = env.AGENTIC_COMMENTS_LOCK_TIMEOUT_MS;
  if (raw === undefined) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw new CommentsError("USAGE", "AGENTIC_COMMENTS_LOCK_TIMEOUT_MS must be a whole number of milliseconds");
  return Number(raw);
}

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const digest = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();

function encode(ydoc: Y.Doc): Buffer {
  const update = Y.encodeStateAsUpdate(ydoc);
  return Buffer.concat([MAGIC, digest(update), update]);
}

function decode(bytes: Buffer, path: string): Y.Doc {
  const body = bytes.subarray(MAGIC.length + HASH);
  if (bytes.length < MAGIC.length + HASH || !bytes.subarray(0, MAGIC.length).equals(MAGIC) || !bytes.subarray(MAGIC.length, MAGIC.length + HASH).equals(digest(body))) {
    throw new CommentsError("STORE_CORRUPT", `${path} is not a saved document, or it is damaged`);
  }
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, new Uint8Array(body));
  } catch {
    throw new CommentsError("STORE_CORRUPT", `${path} is not a saved document, or it is damaged`);
  }
  return ydoc;
}

/** Write every byte. A write can stop short on a full disk or a size limit, and that must not pass as success. */
function writeAll(handle: number, data: Buffer): void {
  let done = 0;
  while (done < data.length) {
    const wrote = writeSync(handle, data, done, data.length - done);
    if (wrote <= 0) throw Object.assign(new Error("a write made no progress"), { code: "ENOSPC" });
    done += wrote;
  }
}

const FULL = new Set(["ENOSPC", "EFBIG", "EDQUOT"]);

/** Write a file in full, sync it, and remove it when anything fails. A full disk becomes STORE_FULL. */
function writeDurably(path: string, data: Buffer): void {
  let handle: number | undefined;
  try {
    handle = openSync(path, "wx");
    writeAll(handle, data);
    fsyncSync(handle);
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    handle = undefined;
    try {
      unlinkSync(path);
    } catch {
      /* never created */
    }
    if (FULL.has((error as NodeJS.ErrnoException).code ?? "")) throw new CommentsError("STORE_FULL", "the file could not be written: the disk is full or a file size limit applies");
    throw error;
  }
  closeSync(handle);
}

function syncDirectory(path: string): void {
  try {
    const handle = openSync(dirname(path), "r");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {
    /* some systems cannot sync a directory */
  }
}

const identity = (path: string): string => {
  const s = statSync(path);
  return `${s.ino}:${s.size}:${s.mtimeMs}`;
};

/**
 * One file that holds a Yjs document, with a hash so damage is seen. A write takes a lock file, loads the
 * newest state, runs, and saves with a rename. If the file changed while it ran, it runs again on the new
 * state. This is built for processes on one machine that share one process table. A lock held across
 * containers or machines cannot be checked for a dead holder.
 */
export class FileStore {
  readonly path: string;
  private readonly lockTimeoutMs: number;

  constructor(path: string, options: FileStoreOptions = {}) {
    const given = resolve(path);
    this.path = existsSync(given) ? realpathSync(given) : given;
    const timeout = options.lockTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) throw new CommentsError("INVALID_INPUT", "lockTimeoutMs must be a whole number of milliseconds, 0 or more");
    this.lockTimeoutMs = timeout;
  }

  /** Create the file. `seed` fills the document before the first save. Refuses to overwrite, even when two run at once. */
  create(seed: (ydoc: Y.Doc) => void = () => undefined): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const ydoc = new Y.Doc();
    seed(ydoc);
    const data = encode(ydoc);
    if (data.length > MAX_FILE) throw new CommentsError("STORE_FULL", `the document is larger than ${MAX_FILE} bytes`);
    const temporary = `${this.path}.tmp-${process.pid}-${globalThis.crypto.randomUUID()}`;
    writeDurably(temporary, data);
    try {
      linkSync(temporary, this.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new CommentsError("STORE_EXISTS", `${this.path} already exists`);
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
      // This filesystem has no hard links. Fall back to a check and a rename, which can race.
      if (existsSync(this.path)) throw new CommentsError("STORE_EXISTS", `${this.path} already exists`);
      renameSync(temporary, this.path);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* moved into place */
      }
    }
    syncDirectory(this.path);
  }

  private load(): { ydoc: Y.Doc; seen: string } {
    if (!existsSync(this.path)) throw new CommentsError("STORE_MISSING", `${this.path} does not exist; run init first`);
    if (statSync(this.path).size > MAX_FILE) throw new CommentsError("STORE_CORRUPT", `${this.path} is larger than ${MAX_FILE} bytes`);
    const seen = identity(this.path);
    return { ydoc: decode(readFileSync(this.path), this.path), seen };
  }

  /** Read the newest saved state. Anything `fn` changes is not saved. */
  read<T>(fn: (ydoc: Y.Doc) => T): T {
    return fn(this.load().ydoc);
  }

  private acquire(lock: string, mine: string): void {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = openSync(lock, "wx");
        try {
          writeAll(handle, Buffer.from(mine));
        } catch (error) {
          closeSync(handle);
          try {
            unlinkSync(lock);
          } catch {
            /* already gone */
          }
          if (FULL.has((error as NodeJS.ErrnoException).code ?? "")) throw new CommentsError("STORE_FULL", "the lock could not be written: the disk is full");
          throw error;
        }
        closeSync(handle);
        return;
      } catch (error) {
        if (error instanceof CommentsError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CommentsError("STORE_LOCKED", `${lock} cannot be created: ${(error as NodeJS.ErrnoException).code ?? "an error"}`);
      }
      if (this.clearStale(lock, mine)) continue;
      if (Date.now() >= deadline) {
        throw new CommentsError("STORE_LOCKED", `${lock} is held by another process; remove it only if nothing uses ${this.path}`);
      }
      sleep(POLL_MS);
    }
  }

  /**
   * Clear a lock whose holder is dead (or is this process, with another mark), an empty one older than a
 * short time, or any one older than a minute. The lock moves to a unique name
   * first, so only one process clears it. If the moved lock is not the one we looked at, it goes back.
   */
  private clearStale(lock: string, mine: string): boolean {
    let held: string;
    let age: number;
    try {
      held = readFileSync(lock, "utf8").trim();
      age = Date.now() - statSync(lock).mtimeMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    const pid = Number(held.split(":")[0]);
    const well = /^\d{1,10}(:[\w-]{1,64})?$/.test(held) && pid > 0;
    // A write in this process is synchronous, so a lock with our id and another mark cannot be live.
    const left = well && (!alive(pid) || (pid === process.pid && held !== mine));
    if (!left && !(held === "" && age > EMPTY_LOCK_MS) && age <= LOCK_MAX_AGE_MS) return false;
    const tomb = `${lock}.stale-${process.pid}-${globalThis.crypto.randomUUID()}`;
    try {
      renameSync(lock, tomb);
    } catch {
      return true;
    }
    try {
      if (readFileSync(tomb, "utf8").trim() !== held) {
        try {
          linkSync(tomb, lock);
        } catch {
          /* another process took the name; nothing more to do */
        }
        return false;
      }
    } catch {
      return true;
    } finally {
      try {
        unlinkSync(tomb);
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  /** Lock, load the newest state, run `fn`, and save. When `fn` throws, nothing is saved. */
  write<T>(fn: (ydoc: Y.Doc) => T): T {
    const lock = `${this.path}.lock`;
    const mine = `${process.pid}:${globalThis.crypto.randomUUID()}`;
    this.acquire(lock, mine);
    try {
      for (let attempt = 1; ; attempt++) {
        const { ydoc, seen } = this.load();
        const result = fn(ydoc);
        const data = encode(ydoc);
        if (data.length > MAX_FILE) throw new CommentsError("STORE_FULL", `the document would pass ${MAX_FILE} bytes, so the change was not saved`);
        if (identity(this.path) !== seen) {
          if (attempt >= ATTEMPTS) throw new CommentsError("STORE_LOCKED", `${this.path} kept changing while it was saved`);
          continue;
        }
        const temporary = `${this.path}.tmp-${process.pid}-${globalThis.crypto.randomUUID()}`;
        writeDurably(temporary, data);
        try {
          renameSync(temporary, this.path);
        } catch (error) {
          unlinkSync(temporary);
          throw error;
        }
        syncDirectory(this.path);
        return result;
      }
    } finally {
      try {
        if (readFileSync(lock, "utf8") === mine) unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}
