import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepositoryAnalyzer } from "../../src/analyzers/repository.js";
import { DocumentGenerator } from "../../src/generators/documents.js";
import { HookInstaller } from "../../src/hooks/installer.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
  }).trim();
}

describe("Integration: Full Onboard", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-onboard-test-"));
    // Create a real git repo with some history
    git(tmpDir, ["init"]);
    git(tmpDir, ["config", "user.name", "Test User"]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);

    // Add some files
    const { writeFileSync, mkdirSync } = require("node:fs");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), 'console.log("hello");\n');
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        dependencies: { express: "^4.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
    );
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");

    git(tmpDir, ["add", "."]);
    git(tmpDir, ["commit", "-m", "feat: initial commit"]);

    writeFileSync(join(tmpDir, "src/server.ts"), 'import express from "express";\n');
    git(tmpDir, ["add", "."]);
    git(tmpDir, ["commit", "-m", "feat: add server"]);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("analyzes a real git repo", async () => {
    const analyzer = new RepositoryAnalyzer({
      repoPath: tmpDir,
      maxCommits: 100,
      maxPRs: 0,
      forceRegenerate: false,
      verbose: false,
    });

    const analysis = await analyzer.analyze();
    expect(analysis.commits.length).toBeGreaterThanOrEqual(2);
    expect(analysis.primaryLanguage).toBe("TypeScript");
    expect(analysis.frameworks).toContain("Express");
    expect(analysis.repoName).toBeTruthy();
  });

  it("generates documentation files", async () => {
    const analyzer = new RepositoryAnalyzer({
      repoPath: tmpDir,
      maxCommits: 100,
      maxPRs: 0,
      forceRegenerate: false,
      verbose: false,
    });

    const analysis = await analyzer.analyze();
    const docGen = new DocumentGenerator(tmpDir, analysis);
    const files = await docGen.generateAll(true);

    expect(files.length).toBeGreaterThan(3);
    expect(existsSync(join(tmpDir, ".claude", "CLAUDE.md"))).toBe(true);

    const claudeMd = readFileSync(
      join(tmpDir, ".claude", "CLAUDE.md"),
      "utf-8",
    );
    expect(claudeMd).toContain("TypeScript");
  });

  it("installs git hooks", async () => {
    const installer = new HookInstaller(tmpDir);
    const hooks = await installer.installAll();
    expect(hooks).toContain("post-commit");
    expect(hooks).toContain("post-merge");

    expect(
      existsSync(join(tmpDir, ".git", "hooks", "post-commit")),
    ).toBe(true);

    const isInstalled = await installer.isInstalled();
    expect(isInstalled).toBe(true);
  });

  it("uninstalls hooks cleanly", async () => {
    const installer = new HookInstaller(tmpDir);
    const removed = await installer.uninstall();
    expect(removed.length).toBeGreaterThan(0);

    const isInstalled = await installer.isInstalled();
    expect(isInstalled).toBe(false);
  });
});

describe("Integration: Doc Health", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-onboard-health-"));
    git(tmpDir, ["init"]);
    git(tmpDir, ["config", "user.name", "Test User"]);
    git(tmpDir, ["config", "user.email", "test@example.com"]);

    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tmpDir, "README.md"), "# Test\n");
    git(tmpDir, ["add", "."]);
    git(tmpDir, ["commit", "-m", "init"]);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports health for repo without docs", async () => {
    const analyzer = new RepositoryAnalyzer({
      repoPath: tmpDir,
      maxCommits: 100,
      maxPRs: 0,
      forceRegenerate: false,
      verbose: false,
    });

    const report = await analyzer.checkDocHealth();
    expect(report.grade).toBe("F");
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});
