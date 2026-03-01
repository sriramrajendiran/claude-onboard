import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Commit } from "../types.js";

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
