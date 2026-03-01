import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import {
  renderPostCommitHook,
  renderPostMergeHook,
  renderPostRewriteHook,
  renderPrepareCommitMsgHook,
  renderUpdateDocsScript,
  MARKER_START,
  MARKER_END,
} from "./scripts.js";

type HookManager = "husky" | "lefthook" | "simple-git-hooks" | "raw";

export class HookInstaller {
  constructor(private readonly repoPath: string) {}

  async installAll(): Promise<string[]> {
    const installed: string[] = [];
    const manager = this.detectHookManager();

    // Install update-docs.sh runner script
    const hooksDir = join(this.repoPath, ".claude", "hooks");
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true });
    }
    writeFileSync(
      join(hooksDir, "update-docs.sh"),
      renderUpdateDocsScript(),
      "utf-8",
    );
    chmodSync(join(hooksDir, "update-docs.sh"), 0o755);

    const hooks: [string, string][] = [
      ["post-commit", renderPostCommitHook()],
      ["post-merge", renderPostMergeHook()],
      ["post-rewrite", renderPostRewriteHook()],
      ["prepare-commit-msg", renderPrepareCommitMsgHook()],
    ];

    for (const [hookName, content] of hooks) {
      if (!content) continue; // skip hooks with no content
      try {
        if (manager === "husky") {
          this.installHusky(hookName, content);
        } else {
          this.installRawHook(hookName, content);
        }
        installed.push(hookName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[claude-onboard] Could not install ${hookName} hook: ${msg}`,
        );
      }
    }

    return installed;
  }

  async uninstall(): Promise<string[]> {
    const removed: string[] = [];
    const hookNames = [
      "post-commit",
      "post-merge",
      "post-rewrite",
      "prepare-commit-msg",
    ];

    for (const hookName of hookNames) {
      const hookPath = join(this.repoPath, ".git", "hooks", hookName);
      if (!existsSync(hookPath)) continue;

      const existing = readFileSync(hookPath, "utf-8");
      const cleaned = this.removeMarked(existing);

      if (cleaned.trim()) {
        writeFileSync(hookPath, cleaned, "utf-8");
      } else {
        // File is now empty — remove it
        const { unlinkSync } = await import("node:fs");
        unlinkSync(hookPath);
      }
      removed.push(hookName);
    }

    return removed;
  }

  async isInstalled(): Promise<boolean> {
    const hookPath = join(
      this.repoPath,
      ".git",
      "hooks",
      "post-commit",
    );
    if (!existsSync(hookPath)) return false;
    const content = readFileSync(hookPath, "utf-8");
    return content.includes(MARKER_START);
  }

  private detectHookManager(): HookManager {
    if (existsSync(join(this.repoPath, ".husky"))) return "husky";
    if (existsSync(join(this.repoPath, "lefthook.yml"))) return "lefthook";
    if (
      existsSync(join(this.repoPath, "package.json"))
    ) {
      try {
        const pkg = JSON.parse(
          readFileSync(join(this.repoPath, "package.json"), "utf-8"),
        ) as Record<string, unknown>;
        if (pkg["simple-git-hooks"]) return "simple-git-hooks";
      } catch {
        // ignore
      }
    }
    return "raw";
  }

  private installHusky(hookName: string, content: string): void {
    const huskyDir = join(this.repoPath, ".husky");
    const hookPath = join(huskyDir, hookName);
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes(MARKER_START)) return; // already installed
      writeFileSync(hookPath, this.appendMarked(existing, content), "utf-8");
    } else {
      writeFileSync(hookPath, `#!/bin/sh\n${content}\n`, "utf-8");
      chmodSync(hookPath, 0o755);
    }
  }

  private installRawHook(hookName: string, content: string): void {
    const hooksDir = join(this.repoPath, ".git", "hooks");
    if (!existsSync(hooksDir)) {
      // Not a git repo or hooks dir missing
      throw new Error(`.git/hooks directory not found`);
    }

    const hookPath = join(hooksDir, hookName);
    if (existsSync(hookPath)) {
      const existing = readFileSync(hookPath, "utf-8");
      if (existing.includes(MARKER_START)) return; // already installed
      writeFileSync(hookPath, this.appendMarked(existing, content), "utf-8");
    } else {
      writeFileSync(hookPath, `#!/bin/sh\n${content}\n`, "utf-8");
    }
    chmodSync(hookPath, 0o755);
  }

  private appendMarked(existing: string, toAppend: string): string {
    return `${existing.trimEnd()}\n\n${toAppend}\n`;
  }

  private removeMarked(existing: string): string {
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END);
    if (startIdx === -1 || endIdx === -1) return existing;
    return (
      existing.slice(0, startIdx) +
      existing.slice(endIdx + MARKER_END.length)
    ).trim() + "\n";
  }
}
