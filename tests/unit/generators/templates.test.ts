import { describe, it, expect } from "vitest";
import {
  renderClaudeMd,
  renderRootClaudeMd,
  renderFolderClaudeMd,
  renderOnboardCommand,
  renderStatusCommand,
} from "../../../src/generators/templates.js";
import type { RepositoryAnalysis } from "../../../src/types.js";

function makeAnalysis(overrides?: Partial<RepositoryAnalysis>): RepositoryAnalysis {
  return {
    repoPath: "/test/repo",
    repoName: "test-repo",
    defaultBranch: "main",
    remoteUrl: "git@github.com:owner/test-repo.git",
    analyzedAt: "2024-01-01T00:00:00Z",
    commits: [],
    contributors: [],
    primaryLanguage: "TypeScript",
    languages: [{ name: "TypeScript", files: 50, percentage: 80 }],
    frameworks: ["Next.js"],
    testFrameworks: ["Vitest"],
    buildTools: ["Vite"],
    ciSystems: ["GitHub Actions"],
    packageManagers: ["npm"],
    conventions: [
      {
        type: "commit",
        pattern: "conventional",
        description: "Conventional Commits",
        examples: ["feat: add login"],
        confidence: 0.9,
        detectedFrom: "git-log",
      },
    ],
    criticalPaths: [
      { path: "src/index.ts", changeCount: 42, lastChanged: "2024-01-01" },
    ],
    architecture: {
      style: "monolith",
      entryPoints: ["src/index.ts"],
      layers: ["controllers", "services"],
      keyModules: ["src"],
      databasePatterns: ["Prisma"],
      apiPatterns: ["REST"],
      testStructure: "separate-dir",
      hasDockerfile: true,
      hasInfraAsCode: false,
    },
    patterns: [],
    prInsights: [],
    testCoverage: "medium",
    documentationCoverage: "low",
    ciCoverage: "partial",
    ...overrides,
  };
}

describe("templates", () => {
  const analysis = makeAnalysis();

  it("renderClaudeMd includes project name and architecture", () => {
    const md = renderClaudeMd(analysis);
    expect(md).toContain("test-repo");
    expect(md).toContain("monolith");
    expect(md).toContain("onboarder:auto-start");
    expect(md).toContain("onboarder:auto-end");
  });

  it("renderClaudeMd includes conventions inline", () => {
    const md = renderClaudeMd(analysis);
    expect(md).toContain("Conventional Commits");
  });

  it("renderClaudeMd includes critical paths inline", () => {
    const md = renderClaudeMd(analysis);
    expect(md).toContain("src/index.ts");
    expect(md).toContain("42");
  });

  it("renderClaudeMd handles empty analysis gracefully", () => {
    const md = renderClaudeMd(makeAnalysis({
      conventions: [],
      criticalPaths: [],
    }));
    expect(md).toContain("test-repo");
    expect(md).not.toContain("Conventions");
  });

  it("renderRootClaudeMd is minimal pointer", () => {
    const md = renderRootClaudeMd(analysis);
    expect(md).toContain("test-repo");
    expect(md).toContain(".claude/CLAUDE.md");
  });

  it("renderFolderClaudeMd includes module description", () => {
    const md = renderFolderClaudeMd(analysis, {
      path: "src/services",
      fileCount: 10,
      changeCount: 50,
      keyFiles: ["src/services/auth.ts"],
      classNames: ["AuthService"],
      description: "Business logic services",
      children: [],
    });
    expect(md).toContain("services/");
    expect(md).toContain("Business logic services");
  });

  it("renderOnboardCommand is self-contained", () => {
    const content = renderOnboardCommand();
    expect(content).toContain("onboard");
    expect(content).toContain(".claude/CLAUDE.md");
    expect(content).not.toContain("MCP");
  });

  it("renderStatusCommand is self-contained", () => {
    const content = renderStatusCommand();
    expect(content).toContain("health");
    expect(content).toContain(".onboarder-meta.json");
  });
});
