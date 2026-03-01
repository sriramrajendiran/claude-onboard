import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Commit } from "../types.js";

export interface SinglePassResult {
  commits: Commit[];
  fileFrequency: Map<string, number>;
  coChangeMatrix: Map<string, Map<string, number>>;
}

const COMMIT_SEPARATOR = "---COMMIT---";
const FIELD_SEPARATOR = "\x1e"; // ASCII record separator (safe for args)
const GIT_LOG_FORMAT = `%H%x1e%an%x1e%ae%x1e%ci%x1e%s%x1e%b%x1e%P%x1e${COMMIT_SEPARATOR}`;

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
    }).trim();
  } catch {
    return "";
  }
}

export class GitReader {
  private readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = resolve(repoPath);
  }

  isGitRepo(): boolean {
    const result = git(this.repoPath, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return result === "true";
  }

  getRoot(): string {
    const root = git(this.repoPath, ["rev-parse", "--show-toplevel"]);
    return root || this.repoPath;
  }

  getDefaultBranch(): string {
    // Try symbolic-ref for origin/HEAD
    const ref = git(this.repoPath, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    if (ref) {
      const parts = ref.split("/");
      return parts[parts.length - 1] ?? "main";
    }

    // Check common branch names
    for (const name of ["main", "master", "trunk", "develop"]) {
      const result = git(this.repoPath, ["rev-parse", "--verify", name]);
      if (result) return name;
    }
    return "main";
  }

  getRemoteUrl(): string | null {
    const url = git(this.repoPath, ["remote", "get-url", "origin"]);
    return url || null;
  }

  /** @deprecated Use getCommitsSinglePass() instead. */
  getCommits(options: {
    limit: number;
    since?: string;
    skipMerges: boolean;
    branch?: string;
  }): Commit[] {
    const targetBranch = options.branch ?? this.resolveDefaultBranch();
    const args = [
      "log",
      `--max-count=${options.limit}`,
      `--format=${GIT_LOG_FORMAT}`,
    ];
    if (options.since) {
      args.push(`${options.since}..${targetBranch ?? "HEAD"}`);
    } else if (targetBranch) {
      args.push(targetBranch);
    }
    if (options.skipMerges) args.push("--no-merges");

    const raw = git(this.repoPath, args);
    if (!raw) return [];

    const commits: Commit[] = [];
    const chunks = raw.split(COMMIT_SEPARATOR);

    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;

      const fields = trimmed.split(FIELD_SEPARATOR);
      if (fields.length < 7) continue;

      const sha = fields[0] ?? "";
      const author = fields[1] ?? "";
      const email = fields[2] ?? "";
      const date = fields[3] ?? "";
      const subject = fields[4] ?? "";
      const body = (fields[5] ?? "").trim();
      const parents = fields[6] ?? "";

      const stat = this.getCommitStat(sha);
      const filesChanged = this.getCommitFiles(sha);

      commits.push({
        sha,
        shortSha: sha.slice(0, 7),
        author,
        email,
        date,
        message: body ? `${subject}\n\n${body}` : subject,
        subject,
        body,
        filesChanged,
        insertions: stat.insertions,
        deletions: stat.deletions,
        isMerge: parents.includes(" "),
      });
    }

    return commits;
  }

  /** @deprecated Use getCommitsSinglePass() instead. */
  getCommitStat(sha: string): { insertions: number; deletions: number } {
    const raw = git(this.repoPath, [
      "diff",
      "--shortstat",
      `${sha}^..${sha}`,
    ]);
    if (!raw) return { insertions: 0, deletions: 0 };

    const insertMatch = raw.match(/(\d+) insertion/);
    const deleteMatch = raw.match(/(\d+) deletion/);
    return {
      insertions: insertMatch ? parseInt(insertMatch[1]!, 10) : 0,
      deletions: deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0,
    };
  }

  /** @deprecated Use getCommitsSinglePass() instead. */
  getCommitFiles(sha: string): string[] {
    const raw = git(this.repoPath, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      sha,
    ]);
    return raw ? raw.split("\n").filter(Boolean) : [];
  }

  /** @deprecated Use getCommitsSinglePass() instead. */
  getFileChangeFrequency(limit: number, branch?: string): Map<string, number> {
    const targetBranch = branch ?? this.resolveDefaultBranch();
    const args = [
      "log",
      `--max-count=${limit}`,
      "--name-only",
      "--format=",
    ];
    if (targetBranch) args.splice(1, 0, targetBranch);
    const raw = git(this.repoPath, args);
    const freq = new Map<string, number>();
    if (!raw) return freq;

    for (const line of raw.split("\n")) {
      const file = line.trim();
      if (file) {
        freq.set(file, (freq.get(file) ?? 0) + 1);
      }
    }
    return freq;
  }

  getTrackedFiles(): string[] {
    const raw = git(this.repoPath, ["ls-files"]);
    return raw ? raw.split("\n").filter(Boolean) : [];
  }

  getCommitsSinglePass(options: {
    limit: number;
    since?: string;
    skipMerges?: boolean;
    branch?: string;
  }): SinglePassResult {
    const targetBranch = options.branch ?? this.resolveDefaultBranch();
    const args = [
      "log",
      `--max-count=${options.limit}`,
      `--format=${GIT_LOG_FORMAT}`,
      "--numstat",
      "--first-parent",
    ];
    if (options.since) {
      // When doing delta since a SHA, compare against HEAD (current branch)
      args.push(`${options.since}..HEAD`);
    } else if (targetBranch) {
      args.push(targetBranch);
    }
    if (options.skipMerges) args.push("--no-merges");

    const raw = git(this.repoPath, args);
    if (!raw) {
      return {
        commits: [],
        fileFrequency: new Map(),
        coChangeMatrix: new Map(),
      };
    }

    const commits: Commit[] = [];
    const fileFrequency = new Map<string, number>();
    const coChangeMatrix = new Map<string, Map<string, number>>();

    // git log --numstat format: header + SEPARATOR + \n\n + numstat lines + header2 + SEPARATOR + ...
    // When split on SEPARATOR, chunk[0] = first header, chunk[1] = numstat1 + header2, etc.
    // So: numstat for commit N is at the START of chunk N+1.
    const chunks = raw.split(COMMIT_SEPARATOR);

    // Parse headers from each chunk (header is the last FIELD_SEPARATOR-delimited block)
    const headers: string[] = [];
    const numstatBlocks: string[] = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const trimmed = (chunks[ci] ?? "").trim();
      if (!trimmed) continue;

      if (ci === 0) {
        // First chunk is just the header (no preceding numstat)
        headers.push(trimmed);
      } else {
        // Subsequent chunks: numstat lines (for previous commit) + blank line + header (for this commit)
        // Find the header by looking for a line containing the field separator
        const lines = trimmed.split("\n");
        const numstatLines: string[] = [];
        let headerPart = "";

        for (let li = 0; li < lines.length; li++) {
          const line = lines[li] ?? "";
          if (line.includes(FIELD_SEPARATOR)) {
            // This line and everything after is the header for the next commit
            headerPart = lines.slice(li).join("\n").trim();
            break;
          }
          numstatLines.push(line);
        }

        numstatBlocks.push(numstatLines.join("\n"));
        if (headerPart) {
          headers.push(headerPart);
        }
      }
    }

    // Last chunk's numstat is for the last header but appears after the final SEPARATOR
    // Actually the last chunk after the final SEPARATOR contains the numstat for the last commit
    // plus potentially nothing else. We already handled it above.

    for (let hi = 0; hi < headers.length; hi++) {
      const header = headers[hi] ?? "";
      // numstat for this commit is in numstatBlocks[hi] (offset by 1 since chunk 0 has no numstat)
      const numstatBlock = numstatBlocks[hi] ?? "";

      const fields = header.split(FIELD_SEPARATOR);
      if (fields.length < 7) continue;

      const sha = fields[0] ?? "";
      const author = fields[1] ?? "";
      const email = fields[2] ?? "";
      const date = fields[3] ?? "";
      const subject = fields[4] ?? "";
      const body = (fields[5] ?? "").trim();
      const parents = fields[6] ?? "";

      // Parse numstat lines
      let insertions = 0;
      let deletions = 0;
      const filesChanged: string[] = [];

      for (const line of numstatBlock.split("\n")) {
        const parsed = this.parseNumstatLine(line);
        if (!parsed) continue;

        insertions += parsed.insertions;
        deletions += parsed.deletions;
        filesChanged.push(parsed.filePath);
        fileFrequency.set(parsed.filePath, (fileFrequency.get(parsed.filePath) ?? 0) + 1);
      }

      // Build co-change pairs (skip large commits to avoid O(n²) blowup)
      if (filesChanged.length <= 50) {
        for (let i = 0; i < filesChanged.length; i++) {
          for (let j = i + 1; j < filesChanged.length; j++) {
            const a = filesChanged[i] ?? "";
            const b = filesChanged[j] ?? "";
            const [fileA, fileB] = a < b ? [a, b] : [b, a];
            let inner = coChangeMatrix.get(fileA);
            if (!inner) {
              inner = new Map<string, number>();
              coChangeMatrix.set(fileA, inner);
            }
            inner.set(fileB, (inner.get(fileB) ?? 0) + 1);
          }
        }
      }

      commits.push({
        sha,
        shortSha: sha.slice(0, 7),
        author,
        email,
        date,
        message: body ? `${subject}\n\n${body}` : subject,
        subject,
        body,
        filesChanged,
        insertions,
        deletions,
        isMerge: parents.includes(" "),
      });
    }

    return { commits, fileFrequency, coChangeMatrix };
  }

  getHead(): string | null {
    const sha = git(this.repoPath, ["rev-parse", "HEAD"]);
    return sha || null;
  }

  diffNumstat(
    fromSha: string,
    toSha: string,
  ): Map<string, { insertions: number; deletions: number }> {
    const raw = git(this.repoPath, ["diff", "--numstat", `${fromSha}..${toSha}`]);
    const result = new Map<string, { insertions: number; deletions: number }>();
    if (!raw) return result;

    for (const line of raw.split("\n")) {
      const parsed = this.parseNumstatLine(line);
      if (!parsed) continue;
      result.set(parsed.filePath, { insertions: parsed.insertions, deletions: parsed.deletions });
    }
    return result;
  }

  private parseNumstatLine(line: string): { filePath: string; insertions: number; deletions: number } | null {
    const stripped = line.trim();
    if (!stripped) return null;
    const parts = stripped.split("\t");
    if (parts.length < 3) return null;

    const addStr = parts[0] ?? "0";
    const delStr = parts[1] ?? "0";
    const filePath = this.resolveNumstatPath(parts[2] ?? "");
    const isBinary = addStr === "-";

    return {
      filePath,
      insertions: isBinary ? 0 : (parseInt(addStr, 10) || 0),
      deletions: isBinary ? 0 : (parseInt(delStr, 10) || 0),
    };
  }

  private resolveNumstatPath(raw: string): string {
    const match = raw.match(/^(.*)\{([^}]*) => ([^}]*)\}(.*)$/);
    if (match) {
      const prefix = match[1] ?? "";
      const newPart = match[3] ?? "";
      const suffix = match[4] ?? "";
      return prefix + newPart + suffix;
    }
    return raw;
  }

  /**
   * Resolve the default branch name, returning null if we can't determine it.
   * This ensures we analyze main/master commits, not feature branch commits.
   */
  private resolveDefaultBranch(): string | null {
    // Try symbolic-ref for origin/HEAD
    const ref = git(this.repoPath, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    if (ref) {
      const parts = ref.split("/");
      return parts[parts.length - 1] ?? null;
    }

    // Check common branch names
    for (const name of ["main", "master", "trunk", "develop"]) {
      const result = git(this.repoPath, ["rev-parse", "--verify", name]);
      if (result) return name;
    }

    // Fall back to HEAD (whatever is checked out)
    return null;
  }

  getRemoteBranches(): string[] {
    const raw = git(this.repoPath, ["branch", "-r", "--format=%(refname:short)"]);
    return raw
      ? raw
          .split("\n")
          .filter(Boolean)
          .map((b) => b.replace(/^origin\//, ""))
      : [];
  }
}
