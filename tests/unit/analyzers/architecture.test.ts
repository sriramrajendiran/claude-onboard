import { describe, it, expect, vi } from "vitest";
import { ArchitectureInferrer } from "../../../src/analyzers/architecture.js";

vi.mock("../../../src/analyzers/git.js", () => ({
  GitReader: class {
    isGitRepo() { return true; }
    getTrackedFiles() {
      return [
        "src/index.ts",
        "src/server.ts",
        "src/controllers/auth.ts",
        "src/services/user.ts",
        "src/models/user.ts",
        "tests/auth.test.ts",
        "Dockerfile",
        "docker-compose.yml",
        "prisma/schema.prisma",
      ];
    }
  },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => {
    const existing = new Set([
      "/fake/repo/src/index.ts",
      "/fake/repo/Dockerfile",
      "/fake/repo/docker-compose.yml",
      "/fake/repo/prisma/schema.prisma",
    ]);
    return existing.has(path as string);
  }),
}));

describe("ArchitectureInferrer", () => {
  it("detects monolith style", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.style).toBe("monolith");
  });

  it("detects layers", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.layers).toContain("controllers");
    expect(result.layers).toContain("services");
    expect(result.layers).toContain("models");
  });

  it("detects entry points", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.entryPoints).toContain("src/index.ts");
  });

  it("detects dockerfile", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.hasDockerfile).toBe(true);
  });

  it("detects infra as code", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.hasInfraAsCode).toBe(true);
  });

  it("detects database patterns", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.databasePatterns).toContain("Prisma");
  });

  it("detects test structure", () => {
    const inferrer = new ArchitectureInferrer("/fake/repo", ["TypeScript"]);
    const result = inferrer.infer();
    expect(result.testStructure).toBe("separate-dir");
  });
});
