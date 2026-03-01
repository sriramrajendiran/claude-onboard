import { describe, it, expect } from "vitest";
import { AgentBuilder } from "../../../src/generators/agents.js";
import type { RepositoryAnalysis } from "../../../src/types.js";

function makeAnalysis(overrides?: Partial<RepositoryAnalysis>): RepositoryAnalysis {
  return {
    repoPath: "/test/repo",
    repoName: "test-repo",
    defaultBranch: "main",
    remoteUrl: null,
    analyzedAt: "2024-01-01T00:00:00Z",
    commits: [],
    contributors: [],
    primaryLanguage: "TypeScript",
    languages: [{ name: "TypeScript", files: 50, percentage: 100 }],
    frameworks: ["Next.js", "React"],
    testFrameworks: ["Vitest"],
    buildTools: [],
    ciSystems: [],
    packageManagers: ["npm"],
    conventions: [],
    criticalPaths: [],
    architecture: {
      style: "monolith",
      entryPoints: ["src/index.ts"],
      layers: [],
      keyModules: ["src"],
      databasePatterns: [],
      apiPatterns: [],
      testStructure: "separate-dir",
      hasDockerfile: false,
      hasInfraAsCode: false,
    },
    patterns: [],
    prInsights: [],
    testCoverage: "medium",
    documentationCoverage: "low",
    ciCoverage: "none",
    ...overrides,
  };
}

describe("AgentBuilder", () => {
  it("builds always-on agents for any repo", async () => {
    const builder = new AgentBuilder("/test", makeAnalysis({ testFrameworks: [] }));
    const files = await builder.buildAll();
    const names = files.map((f) => f.path);
    expect(names).toContain(".claude/agents/reviewer.md");
    expect(names).toContain(".claude/agents/doc-maintainer.md");
    expect(names).toContain(".claude/agents/security-auditor.md");
  });

  it("includes test-writer when test frameworks detected", async () => {
    const builder = new AgentBuilder("/test", makeAnalysis());
    const files = await builder.buildAll();
    const names = files.map((f) => f.path);
    expect(names).toContain(".claude/agents/test-writer.md");
  });

  it("excludes test-writer when no test frameworks", async () => {
    const builder = new AgentBuilder("/test", makeAnalysis({ testFrameworks: [] }));
    const files = await builder.buildAll();
    const names = files.map((f) => f.path);
    expect(names).not.toContain(".claude/agents/test-writer.md");
  });

  it("agent content includes repo name", async () => {
    const builder = new AgentBuilder("/test", makeAnalysis());
    const files = await builder.buildAll();
    expect(files[0]!.content).toContain("test-repo");
  });

  it("agent files have frontmatter with tools", async () => {
    const builder = new AgentBuilder("/test", makeAnalysis());
    const files = await builder.buildAll();
    for (const file of files) {
      expect(file.content).toMatch(/^---\n/);
      expect(file.content).toContain("description:");
      expect(file.content).toContain("tools:");
    }
  });

  it("agent files have auto-markers for regeneration", async () => {
    const builder = new AgentBuilder("/test", makeAnalysis());
    const files = await builder.buildAll();
    for (const file of files) {
      expect(file.content).toContain("<!-- onboarder:auto-start -->");
      expect(file.content).toContain("<!-- onboarder:auto-end -->");
    }
  });
});
