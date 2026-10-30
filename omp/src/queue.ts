import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { UUID4, UUID_ANY } from "./util.ts";

/**
 * The queue directory tree from contract/README.md. Directories are 0700 and files 0600.
 * Symbolic links are rejected at every level below the root, and ids are validated as UUIDs
 * before they become path components, so no path can leave the root.
 */
export class Queue {
  constructor(readonly root: string) {}

  #inside(path: string): string {
    const rel = relative(this.root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`path outside queue root: ${path}`);
    }
    return path;
  }

  /** Creates `path` and every missing parent below the root with mode 0700; rejects symlinks. */
  ensureDir(path: string): string {
    this.#inside(path);
    this.#ensureOne(this.root);
    const rel = relative(this.root, path);
    let current = this.root;
    for (const part of rel === "" ? [] : rel.split(sep)) {
      current = join(current, part);
      this.#ensureOne(current);
    }
    return path;
  }

  #ensureOne(dir: string): void {
    let st = tryLstat(dir);
    if (!st) {
      mkdirSync(dir, { mode: 0o700 });
      st = lstatSync(dir);
    }
    if (st.isSymbolicLink()) throw new Error(`refusing symbolic link: ${dir}`);
    if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`);
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  }

  sessionsDir = () => join(this.root, "sessions");
  outboxDir = () => join(this.root, "outbox");
  inboxDir = (sid: string) => join(this.root, "inbox", checkId(sid, UUID_ANY));
  deliveringDir = (sid: string) => join(this.inboxDir(sid), "delivering");
  doneDir = (sid: string) => join(this.inboxDir(sid), "done");

  sessionFile = (sid: string) => join(this.sessionsDir(), `${checkId(sid, UUID_ANY)}.json`);
  inboxFile = (sid: string, msgId: string) => join(this.inboxDir(sid), `${checkId(msgId, UUID4)}.json`);
  marker = (sid: string, msgId: string) => join(this.deliveringDir(sid), checkId(msgId, UUID4));
  doneFile = (sid: string, msgId: string) => join(this.doneDir(sid), `${checkId(msgId, UUID4)}.json`);
  outboxFile = (eventId: string) => join(this.outboxDir(), `${checkId(eventId, UUID4)}.json`);

  /** Writes `<name>.tmp` next to the target and renames it, so readers never see a partial file. */
  writeAtomic(path: string, data: string | Uint8Array): void {
    this.ensureDir(join(path, ".."));
    const tmp = `${path}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  }

  writeJson(path: string, value: unknown): void {
    this.writeAtomic(path, JSON.stringify(value));
  }

  /** Creates an empty file; a no-op when it already exists. */
  touch(path: string): void {
    this.ensureDir(join(path, ".."));
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  /**
   * True when no component between the root and `path` is a symbolic link. Every read, list, stat
   * and delete goes through this, so a link planted at any level cannot redirect an operation
   * outside the root. The last component is checked by the caller's own lstat.
   */
  #clean(path: string): boolean {
    const rel = relative(this.root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    const rootStat = tryLstat(this.root);
    if (!rootStat || !rootStat.isDirectory()) return false;
    let current = this.root;
    const parts = rel === "" ? [] : rel.split(sep);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      const st = tryLstat(current);
      if (!st) return true; // missing below: nothing to follow
      if (!st.isDirectory()) return false;
    }
    return true;
  }

  exists(path: string): boolean {
    return this.#clean(path) && tryLstat(path) !== undefined;
  }

  remove(path: string): void {
    if (this.#clean(path)) rmSync(path, { force: true });
  }

  /** Reads a regular file; a symlink or a non-file reads as absent. */
  readText(path: string): string | undefined {
    if (!this.#clean(path)) return undefined;
    const st = tryLstat(path);
    if (!st || !st.isFile()) return undefined;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

  /** Names of regular files in `dir` matching `pattern`; `*.tmp` never matches. Missing or linked dir lists empty. */
  listFiles(dir: string, pattern: RegExp): string[] {
    if (!this.#clean(join(dir, "x"))) return [];
    const st = tryLstat(dir);
    if (!st || !st.isDirectory()) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && pattern.test(e.name))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  mtimeMs(path: string): number | undefined {
    return this.#clean(path) ? tryLstat(path)?.mtimeMs : undefined;
  }
}

function tryLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function checkId(id: string, pattern: RegExp): string {
  if (!pattern.test(id)) throw new Error(`invalid id: ${id}`);
  return id;
}

export const JSON_FILE = new RegExp(`^${UUID4.source.slice(1, -1)}\\.json$`, "i");
export const MARKER_FILE = UUID4;
