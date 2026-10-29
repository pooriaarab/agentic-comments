import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as Y from "yjs";
import { CommentsError } from "./errors.js";

const MAX_FILE = 50 * 1024 * 1024;
const POLL_MS = 25;

export interface FileStoreOptions {
  /** How long a write waits for another process to finish. Default 5,000 ms. */
  lockTimeoutMs?: number;
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

/**
 * One file that holds a Yjs document. A write takes a lock file, loads the newest state, runs, and saves
 * with a rename, so two processes never lose each other's work. A lock left by a dead process is cleared.
 */
export class FileStore {
  readonly path: string;
  private readonly lockTimeoutMs: number;

  constructor(path: string, options: FileStoreOptions = {}) {
    this.path = resolve(path);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  /** Create the file. `seed` fills the document before the first save. Refuses to overwrite. */
  create(seed: (ydoc: Y.Doc) => void = () => undefined): void {
    if (existsSync(this.path)) throw new CommentsError("STORE_EXISTS", `${this.path} already exists`);
    mkdirSync(dirname(this.path), { recursive: true });
    const ydoc = new Y.Doc();
    seed(ydoc);
    this.save(ydoc, "wx");
  }

  private load(): Y.Doc {
    if (!existsSync(this.path)) throw new CommentsError("STORE_MISSING", `${this.path} does not exist; run init first`);
    if (statSync(this.path).size > MAX_FILE) throw new CommentsError("STORE_CORRUPT", `${this.path} is larger than ${MAX_FILE} bytes`);
    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, new Uint8Array(readFileSync(this.path)));
    } catch {
      throw new CommentsError("STORE_CORRUPT", `${this.path} is not a saved document`);
    }
    return ydoc;
  }

  private save(ydoc: Y.Doc, flag: "w" | "wx"): void {
    const temporary = `${this.path}.tmp-${process.pid}-${globalThis.crypto.randomUUID()}`;
    writeFileSync(temporary, Y.encodeStateAsUpdate(ydoc), { flag: "wx" });
    if (flag === "wx" && existsSync(this.path)) {
      unlinkSync(temporary);
      throw new CommentsError("STORE_EXISTS", `${this.path} already exists`);
    }
    renameSync(temporary, this.path);
  }

  /** Read the newest saved state. Anything `fn` changes is not saved. */
  read<T>(fn: (ydoc: Y.Doc) => T): T {
    return fn(this.load());
  }

  /** Lock, load the newest state, run `fn`, and save. When `fn` throws, nothing is saved. */
  write<T>(fn: (ydoc: Y.Doc) => T): T {
    const lock = `${this.path}.lock`;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = openSync(lock, "wx");
        writeSync(handle, String(process.pid));
        closeSync(handle);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let holder = 0;
        try {
          holder = Number(readFileSync(lock, "utf8").trim());
        } catch {
          continue;
        }
        if (Number.isSafeInteger(holder) && holder > 0 && !alive(holder)) {
          try {
            unlinkSync(lock);
          } catch {
            /* another process cleared it first */
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new CommentsError("STORE_LOCKED", `${lock} is held by another process; remove it only if nothing uses ${this.path}`);
        }
        sleep(POLL_MS);
      }
    }
    try {
      const ydoc = this.load();
      const result = fn(ydoc);
      this.save(ydoc, "w");
      return result;
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  }
}
