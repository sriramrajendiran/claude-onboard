import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PRInsight } from "../types.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TEST_FILE_RE =
  /\.(test|spec)\.(ts|tsx|js|jsx)$|_test\.(go|py|rb)$|Test\.java$|test_.*\.py$/;

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

export class GitHubClient {
  private readonly repo: string;
  private readonly cacheDir: string;

  constructor(options: { repo: string; cacheDir?: string }) {
    this.repo = options.repo;
    this.cacheDir = options.cacheDir ?? ".claude";
  }

  isAvailable(): boolean {
    // Check gh is installed
    try {
      execFileSync("gh", ["--version"], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      console.error(
        "[claude-onboard] gh CLI is not installed. Install it for PR analysis: https://cli.github.com",
      );
      return false;
    }

    // Check gh is authenticated
    try {
      execFileSync("gh", ["auth", "status", "--active"], {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return true;
    } catch {
      console.error(
        "[claude-onboard] gh CLI is not authenticated. Run: gh auth login",
      );
      return false;
    }
  }

  async fetchPRs(options: {
    limit: number;
    state: "merged" | "open" | "all";
  }): Promise<PRInsight[]> {
    if (!this.isAvailable()) return [];

    const cacheKey = `prs-${this.repo}-${options.state}-${options.limit}`;
    const cached = this.readCache(cacheKey);
    if (cached) return cached as PRInsight[];

    const results: PRInsight[] = [];
    let fetched = 0;
    const batchSize = Math.min(options.limit, 100);

    while (fetched < options.limit) {
      const remaining = options.limit - fetched;
      const limit = Math.min(remaining, batchSize);

      const args = [
        "pr",
        "list",
        "--repo",
        this.repo,
        "--state",
        options.state,
        "--limit",
        String(limit),
        "--json",
        "number,title,body,author,mergedAt,files,labels,additions,deletions,reviews,comments,baseRefName",
      ];

      const raw = this.execGh(args);
      if (!raw) break;

      let prs: unknown[];
      try {
        prs = JSON.parse(raw) as unknown[];
      } catch {
        break;
      }

      if (prs.length === 0) break;

      for (const pr of prs) {
        results.push(this.mapPR(pr as Record<string, unknown>));
      }

      fetched += prs.length;
      if (prs.length < limit) break;
    }

    this.writeCache(cacheKey, results);
    return results;
  }

  async fetchSinglePR(prNumber: number): Promise<PRInsight | null> {
    if (!this.isAvailable()) return null;

    const cacheKey = `pr-${this.repo}-${prNumber}`;
    const cached = this.readCache(cacheKey);
    if (cached) return cached as PRInsight;

    const args = [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.repo,
      "--json",
      "number,title,body,author,mergedAt,files,labels,additions,deletions,reviews,comments,baseRefName",
    ];

    const raw = this.execGh(args);
    if (!raw) return null;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }

    const result = this.mapPR(data);
    this.writeCache(cacheKey, result);
    return result;
  }

  private mapPR(pr: Record<string, unknown>): PRInsight {
    const files = (pr.files as Array<Record<string, string>> | null) ?? [];
    const labels = (pr.labels as Array<Record<string, string>> | null) ?? [];
    const reviews =
      (pr.reviews as Array<Record<string, unknown>> | null) ?? [];
    const comments =
      (pr.comments as Array<Record<string, unknown>> | null) ?? [];
    const filesChanged = files.map((f) => f.path ?? "");
    const author = pr.author as Record<string, string> | null;

    return {
      number: pr.number as number,
      title: (pr.title as string) ?? "",
      description: (pr.body as string) ?? "",
      author: author?.login ?? "",
      mergedAt: (pr.mergedAt as string) ?? null,
      baseBranch: (pr.baseRefName as string) ?? "",
      labels: labels.map((l) => l.name ?? ""),
      filesChanged,
      linesAdded: (pr.additions as number) ?? 0,
      linesRemoved: (pr.deletions as number) ?? 0,
      patterns: this.detectPRPatterns(
        (pr.title as string) ?? "",
        labels.map((l) => l.name ?? ""),
      ),
      hasTests: filesChanged.some((f) => TEST_FILE_RE.test(f)),
      reviewers: [
        ...new Set(
          reviews
            .map(
              (r) =>
                ((r.author as Record<string, string> | null)?.login ?? ""),
            )
            .filter(Boolean),
        ),
      ],
      commentCount: comments.length,
    };
  }

  private detectPRPatterns(title: string, labels: string[]): string[] {
    const patterns: string[] = [];
    const lower = title.toLowerCase();
    const allLabels = labels.map((l) => l.toLowerCase());

    if (
      lower.includes("breaking") ||
      allLabels.includes("breaking-change")
    )
      patterns.push("breaking-change");
    if (lower.includes("security") || allLabels.includes("security"))
      patterns.push("security");
    if (
      lower.includes("perf") ||
      lower.includes("performance") ||
      allLabels.includes("performance")
    )
      patterns.push("perf");
    if (lower.includes("fix") || lower.includes("bug"))
      patterns.push("bugfix");
    if (lower.includes("feat") || lower.includes("feature"))
      patterns.push("feature");
    if (lower.includes("refactor")) patterns.push("refactor");
    if (lower.includes("deps") || lower.includes("dependab"))
      patterns.push("dependencies");

    return patterns;
  }

  private execGh(args: string[]): string | null {
    try {
      return execFileSync("gh", args, {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      console.error(`[claude-onboard] gh command failed: ${message}`);
      return null;
    }
  }

  private readCache(key: string): unknown | null {
    const cachePath = this.getCachePath();
    if (!existsSync(cachePath)) return null;

    try {
      const data = JSON.parse(
        readFileSync(cachePath, "utf-8"),
      ) as Record<string, CacheEntry>;
      const entry = data[key];
      if (entry && entry.expiresAt > Date.now()) {
        return entry.data;
      }
    } catch {
      // ignore corrupt cache
    }
    return null;
  }

  private writeCache(key: string, data: unknown): void {
    const cachePath = this.getCachePath();
    let existing: Record<string, CacheEntry> = {};

    if (existsSync(cachePath)) {
      try {
        existing = JSON.parse(
          readFileSync(cachePath, "utf-8"),
        ) as Record<string, CacheEntry>;
      } catch {
        // start fresh
      }
    }

    // Prune expired entries
    const now = Date.now();
    for (const k of Object.keys(existing)) {
      if (existing[k]!.expiresAt <= now) {
        delete existing[k];
      }
    }

    existing[key] = { data, expiresAt: now + CACHE_TTL_MS };

    const dir = join(this.cacheDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(cachePath, JSON.stringify(existing, null, 2));
  }

  private getCachePath(): string {
    return join(this.cacheDir, ".github-cache.json");
  }
}
