import { describe, it, expect, vi } from "vitest";
import { ConventionExtractor } from "../../../src/analyzers/conventions.js";
import type { Commit } from "../../../src/types.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

function makeCommit(subject: string): Commit {
  return {
    sha: "abc",
    shortSha: "abc",
    author: "test",
    email: "test@test.com",
    date: "2024-01-01",
    message: subject,
    subject,
    body: "",
    filesChanged: ["src/index.ts"],
    insertions: 1,
    deletions: 0,
    isMerge: false,
  };
}

describe("ConventionExtractor", () => {
  it("detects conventional commits", () => {
    const commits = [
      makeCommit("feat: add login"),
      makeCommit("fix(auth): resolve token bug"),
      makeCommit("chore: update deps"),
    ];
    const extractor = new ConventionExtractor("/fake", commits);
    const conventions = extractor.extract();
    const commitConv = conventions.find((c) => c.type === "commit");
    expect(commitConv).toBeDefined();
    expect(commitConv!.pattern).toBe("conventional");
  });

  it("detects jira-prefixed commits", () => {
    const commits = [
      makeCommit("PROJ-123 add login"),
      makeCommit("PROJ-456 fix auth"),
      makeCommit("AUTH-789 update tokens"),
    ];
    const extractor = new ConventionExtractor("/fake", commits);
    const conventions = extractor.extract();
    const commitConv = conventions.find((c) => c.type === "commit");
    expect(commitConv!.pattern).toBe("jira");
  });

  it("detects file naming patterns", () => {
    const commits = [
      {
        ...makeCommit("test"),
        filesChanged: [
          "src/user-service.ts",
          "src/auth-handler.ts",
          "src/api-client.ts",
        ],
      },
    ];
    const extractor = new ConventionExtractor("/fake", commits);
    const conventions = extractor.extract();
    const fileConv = conventions.find((c) => c.type === "file");
    expect(fileConv).toBeDefined();
    expect(fileConv!.pattern).toBe("kebab");
  });

  it("detects test structure", () => {
    const commits = [
      {
        ...makeCommit("test"),
        filesChanged: [
          "tests/unit/auth.test.ts",
          "tests/integration/api.test.ts",
        ],
      },
    ];
    const extractor = new ConventionExtractor("/fake", commits);
    const conventions = extractor.extract();
    const testConv = conventions.find((c) => c.type === "test");
    expect(testConv).toBeDefined();
    expect(testConv!.pattern).toBe("separate-dir");
  });

  it("returns empty for no commits", () => {
    const extractor = new ConventionExtractor("/fake", []);
    const conventions = extractor.extract();
    expect(conventions.find((c) => c.type === "commit")).toBeUndefined();
  });
});
