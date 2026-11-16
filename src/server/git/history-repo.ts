import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { env } from "@/server/env";

/**
 * A customer history repository working copy.
 *
 * Reads are allowed from any process. Writes (commit, tag, notes, push) are
 * allowed only in the worker process, which is the single writer; within the
 * worker, writes to one repository are serialized by an in-process lock.
 */

export interface HistoryRepoConfig {
  id: string;
  name: string;
  remoteUrl: string | null;
  deployKeyFile: string | null;
  defaultBranch: string;
  pushEnabled: boolean;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface FileChange {
  /** Path relative to the repository root, forward slashes */
  path: string;
  /** New content, or null to delete the file */
  content: string | Buffer | null;
}

export interface CommitOptions {
  message: string;
  author: CommitAuthor;
  committer: CommitAuthor;
  /** Author and committer date (the service version's updatedAt) */
  date: Date;
  /** Git trailers appended to the message, e.g. { "Asset-Id": "ki-..." } */
  trailers?: Record<string, string | number | undefined | null>;
  /** Allow a commit with no file changes (metadata-only events still change asset.json, so rarely needed) */
  allowEmpty?: boolean;
}

export interface LogEntry {
  hash: string;
  date: string;
  message: string;
  body: string;
  authorName: string;
  authorEmail: string;
  trailers: Record<string, string>;
}

export class GitWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitWriteError";
  }
}

/** A branch commit was refused because the branch is no longer at the commit the caller started from. */
export class BranchMovedError extends GitWriteError {
  constructor(
    readonly branch: string,
    readonly expected: string,
    readonly actual: string | null,
  ) {
    super(`Branch ${branch} moved: expected ${expected.slice(0, 12)}, found ${actual ? actual.slice(0, 12) : "no branch"}.`);
    this.name = "BranchMovedError";
  }
}

/** Options for commitToBranch: like CommitOptions, plus repeatable trailers and a compare-and-swap guard. */
export interface BranchCommitOptions extends Omit<CommitOptions, "trailers"> {
  /** Trailers in order; a key may repeat (one Finding-Id per finding) */
  trailers?: readonly (readonly [string, string | number | null | undefined])[];
  /** Refuse the commit (BranchMovedError) unless the branch is at this commit */
  expectedHead?: string | null;
}

/** One file of a tree listing (git ls-tree -r -l). */
export interface TreeEntry {
  /** Path relative to the repository root */
  path: string;
  /** Blob object ID */
  blob: string;
  size: number;
}

/** One changed path between two commits (git diff --name-status, renames off). */
export interface PathChange {
  status: "added" | "modified" | "deleted";
  path: string;
}

const ZERO_OID = "0000000000000000000000000000000000000000";
const PLUMBING_BATCH = 500;

/**
 * simple-git 4 rejects any GIT_* variable passed through .env() unless it is
 * named in allowEnvironment, and GIT_SSH_COMMAND also needs allowUnsafeSshCommand.
 * These are the variables this class sets itself; ambient GIT_* variables stay stripped.
 */
const ALLOWED_GIT_ENV = [
  "GIT_TERMINAL_PROMPT",
  "GIT_SSH_COMMAND",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
] as const;

function gitOptions(config: Pick<HistoryRepoConfig, "deployKeyFile">) {
  return {
    allowEnvironment: ALLOWED_GIT_ENV,
    ...(config.deployKeyFile ? { unsafe: { allowUnsafeSshCommand: true } } : {}),
  };
}

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = prev.then(() => fn()).finally(() => release());
  locks.set(
    key,
    prev.then(() => gate),
  );
  return run;
}

function safeRelPath(p: string): string {
  const norm = path.posix.normalize(p.replace(/\\/g, "/"));
  if (norm.startsWith("../") || norm === ".." || path.posix.isAbsolute(norm) || norm.includes("\0")) {
    throw new GitWriteError(`unsafe path: ${p}`);
  }
  return norm;
}

export function parseTrailers(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(lines[i] ?? "");
    if (!m) break;
    out[m[1]!] = m[2]!;
  }
  return out;
}

export class HistoryRepo {
  readonly dir: string;
  private readonly git: SimpleGit;

  private constructor(readonly config: HistoryRepoConfig, dir: string) {
    this.dir = dir;
    this.git = simpleGit({ baseDir: dir, maxConcurrentProcesses: 4, ...gitOptions(config) }).env(this.gitEnv());
  }

  static workingDirFor(config: Pick<HistoryRepoConfig, "name">): string {
    const safe = config.name.replace(/[^\w.-]/g, "_");
    return path.join(env().dataDir, "history", safe);
  }

  /** Open the working copy, cloning or initializing it if it doesn't exist (worker only for creation). */
  static async open(config: HistoryRepoConfig): Promise<HistoryRepo> {
    const dir = HistoryRepo.workingDirFor(config);
    if (!existsSync(path.join(dir, ".git"))) {
      assertWorker("initialize a history repository");
      await mkdir(dir, { recursive: true });
      const repo = new HistoryRepo(config, dir);
      if (config.remoteUrl) {
        await simpleGit({ baseDir: path.dirname(dir), ...gitOptions(config) })
          .env(repo.gitEnv())
          .clone(config.remoteUrl, dir);
        // An empty remote clones with whatever branch name the user's git defaults to
        // (often "master"); point the unborn HEAD at the configured branch so commits
        // and push use the same name.
        if (!(await repo.head())) {
          await repo.git.raw(["symbolic-ref", "HEAD", `refs/heads/${config.defaultBranch}`]);
        }
      } else {
        await repo.git.init(["-b", config.defaultBranch]);
      }
      return repo;
    }
    return new HistoryRepo(config, dir);
  }

  private gitEnv(): Record<string, string> {
    const e: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_TERMINAL_PROMPT: "0",
    };
    if (this.config?.deployKeyFile) {
      e.GIT_SSH_COMMAND = `ssh -i ${JSON.stringify(this.config.deployKeyFile)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`;
    }
    return e;
  }

  // ---------- reads ----------

  async head(): Promise<string | null> {
    try {
      return (await this.git.revparse(["HEAD"])).trim();
    } catch {
      return null;
    }
  }

  /** Read a file from the working tree (HEAD state for a clean worker-owned tree). */
  async readFile(relPath: string): Promise<string | null> {
    const p = path.join(this.dir, safeRelPath(relPath));
    if (!existsSync(p)) return null;
    return readFile(p, "utf8");
  }

  /** Read a file at a commit. */
  async show(commit: string, relPath: string): Promise<string | null> {
    try {
      return await this.git.show([`${commit}:${safeRelPath(relPath)}`]);
    } catch {
      return null;
    }
  }

  /** Read a file at a commit as raw bytes (binary-safe), or null when it doesn't exist. */
  async showBytes(commit: string, relPath: string): Promise<Buffer | null> {
    try {
      const out: unknown = await this.git.binaryCatFile(["blob", `${commit}:${safeRelPath(relPath)}`]);
      return Buffer.isBuffer(out) ? out : Buffer.from(String(out), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * The commit a ref points at, or null when it doesn't resolve. Accepts
   * "HEAD", a full or abbreviated commit hash, or a tag or branch name; the
   * caller validates the ref's form first (no leading "-").
   */
  async resolveCommit(ref: string): Promise<string | null> {
    if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) return null;
    try {
      const out = (await this.git.raw(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
      return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out) ? out : null;
    } catch {
      return null;
    }
  }

  /** Tags with the commit each points at, newest first. `prefix` limits them to names starting with it. */
  async tagDetails(prefix?: string): Promise<{ name: string; commit: string; date: string; subject: string }[]> {
    const pattern = prefix ? `refs/tags/${prefix}*` : "refs/tags";
    let raw = "";
    try {
      raw = await this.git.raw([
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname:strip=2)%1f%(*objectname)%1f%(objectname)%1f%(creatordate:iso-strict)%1f%(subject)%1e",
        pattern,
      ]);
    } catch {
      return [];
    }
    return raw
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [name = "", peeled = "", object = "", date = "", subject = ""] = rec.split("\x1f");
        return { name, commit: peeled || object, date, subject };
      });
  }

  /** Commits touching a path (file or directory), newest first. */
  async log(opts: { path?: string; maxCount?: number; ref?: string } = {}): Promise<LogEntry[]> {
    const args = ["log", "--format=%H%x1f%aI%x1f%an%x1f%ae%x1f%s%x1f%b%x1e", `-n${opts.maxCount ?? 200}`];
    if (opts.ref) args.push(opts.ref);
    if (opts.path) args.push("--", safeRelPath(opts.path));
    let raw = "";
    try {
      raw = await this.git.raw(args);
    } catch {
      return [];
    }
    return raw
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash, date, authorName, authorEmail, message, body = ""] = rec.split("\x1f");
        return { hash: hash!, date: date!, authorName: authorName!, authorEmail: authorEmail!, message: message!, body, trailers: parseTrailers(body) };
      });
  }

  async diff(from: string, to: string, relPath?: string): Promise<string> {
    const args = [from, to];
    if (relPath) args.push("--", safeRelPath(relPath));
    return this.git.diff(args);
  }

  async listFiles(relDir: string, ref = "HEAD"): Promise<string[]> {
    try {
      const out = await this.git.raw(["ls-tree", "-r", "--name-only", ref, "--", safeRelPath(relDir)]);
      return out.split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  async tags(prefix?: string): Promise<string[]> {
    const t = await this.git.tags(prefix ? [`${prefix}*`] : []);
    return t.all;
  }

  /**
   * Commits on HEAD that the remote doesn't have yet: those ahead of
   * origin/<defaultBranch>, or every commit when that branch was never pushed
   * or the repository has no remote. Reads local refs only (no fetch).
   */
  async unpushedCommitCount(): Promise<number> {
    if (!(await this.head())) return 0;
    let range = "HEAD";
    if (this.config.remoteUrl) {
      const remoteRef = `refs/remotes/origin/${this.config.defaultBranch}`;
      const found = (await this.git.raw(["for-each-ref", "--format=%(objectname)", remoteRef])).trim();
      if (found) range = `${remoteRef}..HEAD`;
    }
    const out = await this.git.raw(["rev-list", "--count", range]);
    return Number.parseInt(out.trim(), 10) || 0;
  }

  async note(commit: string, ref: string): Promise<string | null> {
    try {
      return (await this.git.raw(["notes", `--ref=${ref}`, "show", commit])).trim();
    } catch {
      return null;
    }
  }

  // ---------- branches other than the working copy's (revisions) ----------
  //
  // Revision branches are written with git plumbing against a temporary index
  // file (read-tree, hash-object, update-index, write-tree, commit-tree,
  // update-ref). Nothing is checked out: the working copy stays on the
  // default branch with a clean tree, so sync keeps committing there while
  // revisions are edited, and a branch update is a compare-and-swap on the
  // ref, so two writers can't silently overwrite each other.

  /** Run git with this repository's environment (plus `env`), feeding `input` on stdin. Binary-safe stdout. */
  private plumb(args: string[], opts: { env?: Record<string, string>; input?: Buffer | string } = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...this.gitEnv(), ...opts.env } as NodeJS.ProcessEnv;
      const child = spawn("git", args, { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new GitWriteError(`git ${args[0]} failed: ${Buffer.concat(err).toString("utf8").trim().slice(0, 400)}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
  }

  /** refs/heads/<branch>, after git's own ref-name check. */
  private async branchRef(branch: string): Promise<string> {
    if (!branch || branch.startsWith("-") || /[\s\0\\]/.test(branch)) throw new GitWriteError(`unsafe branch name: ${branch}`);
    const ref = `refs/heads/${branch}`;
    try {
      await this.plumb(["check-ref-format", ref]);
    } catch {
      throw new GitWriteError(`git rejects the branch name ${branch}`);
    }
    return ref;
  }

  /** The commit a local branch points at, or null when there is no such branch. */
  async branchHead(branch: string): Promise<string | null> {
    let ref: string;
    try {
      ref = await this.branchRef(branch);
    } catch {
      return null;
    }
    try {
      const out = (await this.plumb(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).toString("utf8").trim();
      return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(out) ? out : null;
    } catch {
      return null;
    }
  }

  /** Every file under `relDir` at a ref, with blob IDs and sizes (NUL-separated, so no path quoting). */
  async listTree(ref: string, relDir: string): Promise<TreeEntry[]> {
    if (!ref || ref.startsWith("-")) return [];
    let raw: Buffer;
    try {
      raw = await this.plumb(["ls-tree", "-r", "-l", "-z", "--end-of-options", ref, "--", safeRelPath(relDir)]);
    } catch {
      return [];
    }
    const out: TreeEntry[] = [];
    for (const rec of raw.toString("utf8").split("\0")) {
      const m = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t(.+)$/s.exec(rec);
      if (m) out.push({ blob: m[1]!, size: Number(m[2]), path: m[3]! });
    }
    return out;
  }

  /** Read many files at a ref in one git process (cat-file --batch). Missing paths map to null. */
  async readBlobs(ref: string, relPaths: readonly string[]): Promise<Map<string, Buffer | null>> {
    const result = new Map<string, Buffer | null>();
    const wanted = relPaths.filter((p) => !/[\n\r\0]/.test(p));
    for (const p of relPaths) result.set(p, null);
    if (!ref || ref.startsWith("-") || !wanted.length) return result;
    for (let i = 0; i < wanted.length; i += PLUMBING_BATCH) {
      const batch = wanted.slice(i, i + PLUMBING_BATCH);
      const raw = await this.plumb(["cat-file", "--batch"], { input: batch.map((p) => `${ref}:${safeRelPath(p)}\n`).join("") });
      let at = 0;
      for (const p of batch) {
        const nl = raw.indexOf(0x0a, at);
        if (nl < 0) break;
        const header = raw.subarray(at, nl).toString("utf8");
        at = nl + 1;
        const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!m) continue; // "<object> missing" or "ambiguous"
        const size = Number(m[2]);
        if (m[1] === "blob") result.set(p, Buffer.from(raw.subarray(at, at + size)));
        at += size + 1;
      }
    }
    return result;
  }

  /** Paths under `relDir` that differ between two commits. */
  async diffNameStatus(from: string, to: string, relDir: string): Promise<PathChange[]> {
    if ([from, to].some((r) => !r || r.startsWith("-"))) return [];
    const raw = (await this.plumb(["diff", "--name-status", "--no-renames", "-z", from, to, "--", safeRelPath(relDir)])).toString("utf8");
    const parts = raw.split("\0").filter((s) => s !== "");
    const out: PathChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i]!.charAt(0);
      const status = s === "A" ? "added" : s === "D" ? "deleted" : "modified";
      out.push({ status, path: parts[i + 1]! });
    }
    return out;
  }

  /** Create a local branch at a commit. Fails when the branch already exists. Worker only. */
  async createBranch(branch: string, fromCommit: string): Promise<void> {
    assertWorker("create a branch in a history repository");
    const ref = await this.branchRef(branch);
    const commit = await this.resolveCommit(fromCommit);
    if (!commit) throw new GitWriteError(`no commit ${fromCommit}`);
    await withLock(this.dir, () => this.plumb(["update-ref", "-m", "create revision branch", ref, commit, ZERO_OID]));
  }

  /**
   * Commit file changes on a branch that is not checked out, without touching
   * the working copy. Returns the new commit, or null when the changes leave
   * the tree as it was (unless allowEmpty). Worker only; serialized per
   * repository; the ref update is a compare-and-swap against the parent.
   */
  async commitToBranch(branch: string, changes: readonly FileChange[], opts: BranchCommitOptions): Promise<string | null> {
    assertWorker("commit to a history repository");
    const ref = await this.branchRef(branch);
    return withLock(this.dir, async () => {
      const parent = await this.branchHead(branch);
      if (!parent) throw new GitWriteError(`there is no branch ${branch}`);
      if (opts.expectedHead && opts.expectedHead !== parent) throw new BranchMovedError(branch, opts.expectedHead, parent);
      const scratch = path.join(this.dir, ".git", `dam-branch-${randomUUID()}`);
      const indexFile = path.join(scratch, "index");
      const env = { GIT_INDEX_FILE: indexFile };
      await mkdir(scratch, { recursive: true });
      try {
        await this.plumb(["read-tree", parent], { env });
        const adds = changes.filter((c) => c.content !== null).map((c) => ({ rel: safeRelPath(c.path), content: c.content as string | Buffer }));
        const removes = changes.filter((c) => c.content === null).map((c) => safeRelPath(c.path));
        for (let i = 0; i < adds.length; i += PLUMBING_BATCH) {
          const batch = adds.slice(i, i + PLUMBING_BATCH);
          const files = await Promise.all(
            batch.map(async (a, j) => {
              const f = path.join(scratch, `blob-${i + j}`);
              await writeFile(f, a.content);
              return f;
            }),
          );
          // --no-filters: store the bytes exactly (no autocrlf or attribute conversions).
          const oids = (await this.plumb(["hash-object", "-w", "--no-filters", "--", ...files])).toString("utf8").trim().split("\n");
          if (oids.length !== batch.length) throw new GitWriteError("hash-object returned the wrong number of objects");
          await this.plumb(["update-index", "--add", "--replace", ...batch.flatMap((a, j) => ["--cacheinfo", `100644,${oids[j]},${a.rel}`])], { env });
        }
        for (let i = 0; i < removes.length; i += PLUMBING_BATCH) {
          await this.plumb(["update-index", "--force-remove", "--", ...removes.slice(i, i + PLUMBING_BATCH)], { env });
        }
        const tree = (await this.plumb(["write-tree"], { env })).toString("utf8").trim();
        const parentTree = (await this.plumb(["rev-parse", `${parent}^{tree}`])).toString("utf8").trim();
        if (tree === parentTree && !opts.allowEmpty) return null;
        const trailers = (opts.trailers ?? [])
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, " ")}`);
        const message = trailers.length ? `${opts.message.trimEnd()}\n\n${trailers.join("\n")}\n` : opts.message;
        const iso = opts.date.toISOString();
        const commit = (
          await this.plumb(["commit-tree", tree, "-p", parent, "-F", "-"], {
            input: message,
            env: {
              GIT_AUTHOR_NAME: opts.author.name,
              GIT_AUTHOR_EMAIL: opts.author.email,
              GIT_AUTHOR_DATE: iso,
              GIT_COMMITTER_NAME: opts.committer.name,
              GIT_COMMITTER_EMAIL: opts.committer.email,
              GIT_COMMITTER_DATE: iso,
            },
          })
        )
          .toString("utf8")
          .trim();
        try {
          await this.plumb(["update-ref", "-m", "revision save", ref, commit, parent]);
        } catch {
          throw new BranchMovedError(branch, parent, await this.branchHead(branch));
        }
        return commit;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }

  /** Push one local branch. No-op unless the repository has a remote and push is enabled. Worker only. */
  async pushBranch(branch: string): Promise<boolean> {
    assertWorker("push a history repository");
    if (!this.config.remoteUrl || !this.config.pushEnabled) return false;
    const ref = await this.branchRef(branch);
    await withLock(this.dir, () => this.git.push("origin", `${ref}:${ref}`));
    return true;
  }

  // ---------- writes (worker only, serialized per repository) ----------

  async writeAndCommit(changes: FileChange[], opts: CommitOptions): Promise<string | null> {
    assertWorker("commit to a history repository");
    return withLock(this.dir, async () => {
      const added: string[] = [];
      const removed: string[] = [];
      for (const c of changes) {
        const rel = safeRelPath(c.path);
        const abs = path.join(this.dir, rel);
        if (c.content === null) {
          await rm(abs, { force: true });
          removed.push(rel);
        } else {
          await mkdir(path.dirname(abs), { recursive: true });
          await writeFile(abs, c.content);
          added.push(rel);
        }
      }
      // One git invocation per kind of change (a per-file `git add` made baselines slow).
      for (let i = 0; i < removed.length; i += 500) {
        await this.git.raw(["rm", "--cached", "--ignore-unmatch", "-q", "--", ...removed.slice(i, i + 500)]);
      }
      for (let i = 0; i < added.length; i += 500) {
        await this.git.raw(["add", "--", ...added.slice(i, i + 500)]);
      }
      if (!opts.allowEmpty) {
        const anyStaged = (await this.git.raw(["diff", "--cached", "--name-only"])).trim();
        if (!anyStaged) return null;
      }
      const trailers = Object.entries(opts.trailers ?? {})
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`);
      const message = trailers.length ? `${opts.message.trimEnd()}\n\n${trailers.join("\n")}\n` : opts.message;
      const iso = opts.date.toISOString();
      const msgFile = path.join(this.dir, ".git", "DAM_COMMIT_MSG");
      await writeFile(msgFile, message);
      await this.git
        .env({
          ...this.gitEnv(),
          GIT_AUTHOR_NAME: opts.author.name,
          GIT_AUTHOR_EMAIL: opts.author.email,
          GIT_AUTHOR_DATE: iso,
          GIT_COMMITTER_NAME: opts.committer.name,
          GIT_COMMITTER_EMAIL: opts.committer.email,
          GIT_COMMITTER_DATE: iso,
        })
        .raw(["commit", "-q", "--no-verify", ...(opts.allowEmpty ? ["--allow-empty"] : []), "-F", msgFile]);
      return (await this.git.revparse(["HEAD"])).trim();
    });
  }

  /**
   * Create an annotated tag. `tagger` sets the tagger identity (git reads it
   * from the committer variables); without it git falls back to the process's
   * git config, which a container usually lacks.
   */
  async tag(name: string, message: string, commit = "HEAD", tagger?: CommitAuthor & { date?: Date }): Promise<void> {
    assertWorker("tag a history repository");
    await withLock(this.dir, () => {
      const git = tagger
        ? this.git.env({
            ...this.gitEnv(),
            GIT_COMMITTER_NAME: tagger.name,
            GIT_COMMITTER_EMAIL: tagger.email,
            ...(tagger.date ? { GIT_COMMITTER_DATE: tagger.date.toISOString() } : {}),
          })
        : this.git;
      return git.raw(["tag", "-a", name, "-m", message, commit]);
    });
  }

  /**
   * Append a note. `identity` sets the notes commit's author and committer;
   * without it git falls back to the process's git config, which a container
   * usually lacks.
   */
  async addNote(commit: string, text: string, ref: string, identity?: { author: CommitAuthor; committer: CommitAuthor }): Promise<void> {
    assertWorker("add a note to a history repository");
    await withLock(this.dir, () => {
      const git = identity
        ? this.git.env({
            ...this.gitEnv(),
            GIT_AUTHOR_NAME: identity.author.name,
            GIT_AUTHOR_EMAIL: identity.author.email,
            GIT_COMMITTER_NAME: identity.committer.name,
            GIT_COMMITTER_EMAIL: identity.committer.email,
          })
        : this.git;
      return git.raw(["notes", `--ref=${ref}`, "append", "-m", text, commit]);
    });
  }

  /** Push branch, tags and notes. No-op unless the repository has a remote and push is enabled. */
  async push(notesRef?: string): Promise<boolean> {
    assertWorker("push a history repository");
    if (!this.config.remoteUrl || !this.config.pushEnabled) return false;
    await withLock(this.dir, async () => {
      await this.git.push("origin", this.config.defaultBranch, ["--follow-tags"]);
      if (notesRef) await this.git.push("origin", notesRef);
    });
    return true;
  }
}

export function assertWorker(what: string): void {
  if (env().process !== "worker") {
    throw new GitWriteError(`Only the worker process may ${what}.`);
  }
}
