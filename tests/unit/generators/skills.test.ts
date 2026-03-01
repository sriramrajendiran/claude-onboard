import { describe, it, expect } from "vitest";
import { SkillBuilder } from "../../../src/generators/skills.js";
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

describe("SkillBuilder", () => {
  it("builds base skills for any repo", async () => {
    const builder = new SkillBuilder("/test", makeAnalysis({ frameworks: [] }));
    const files = await builder.buildAll();
    const names = files.map((f) => f.path);
    expect(names).toContain(".claude/skills/debugging.md");
    expect(names).toContain(".claude/skills/testing.md");
    expect(names).toContain(".claude/skills/pr-workflow.md");
    expect(names).toContain(".claude/skills/code-review.md");
    expect(names).toContain(".claude/skills/refactoring.md");
    expect(names).toContain(".claude/skills/documentation.md");
  });

  it("includes framework skills when detected", async () => {
    const builder = new SkillBuilder("/test", makeAnalysis());
    const files = await builder.buildAll();
    const names = files.map((f) => f.path);
    expect(names).toContain(".claude/skills/nextjs.md");
    expect(names).toContain(".claude/skills/react.md");
  });

  it("excludes framework skills when not detected", async () => {
    const builder = new SkillBuilder(
      "/test",
      makeAnalysis({ frameworks: ["Express"] }),
    );
    const files = await builder.buildAll();
    const names = files.map((f) => f.path);
    expect(names).not.toContain(".claude/skills/nextjs.md");
    expect(names).toContain(".claude/skills/express.md");
  });

  it("skill content includes repo name", async () => {
    const builder = new SkillBuilder("/test", makeAnalysis());
    const files = await builder.buildAll();
    expect(files[0]!.content).toContain("test-repo");
  });
});
