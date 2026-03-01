import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitReader } from "../../../src/analyzers/git.js";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

describe("GitReader", () => {
  const reader = new GitReader("/fake/repo");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isGitRepo", () => {
    it("returns true for valid git repo", () => {
      mockExec.mockReturnValue("true");
      expect(reader.isGitRepo()).toBe(true);
    });

    it("returns false when git fails", () => {
      mockExec.mockImplementation(() => {
        throw new Error("not a repo");
      });
      expect(reader.isGitRepo()).toBe(false);
    });
  });

  describe("getDefaultBranch", () => {
    it("detects main from symbolic-ref", () => {
      mockExec.mockReturnValue("refs/remotes/origin/main");
      expect(reader.getDefaultBranch()).toBe("main");
    });

    it("falls back to checking branch names", () => {
      mockExec
        .mockReturnValueOnce("") // symbolic-ref fails
        .mockImplementationOnce(() => {
          throw new Error("no main");
        }) // main
        .mockReturnValueOnce("abc123"); // master exists
      expect(reader.getDefaultBranch()).toBe("master");
    });
  });

  describe("getRemoteUrl", () => {
    it("returns remote URL", () => {
      mockExec.mockReturnValue("git@github.com:owner/repo.git");
      expect(reader.getRemoteUrl()).toBe("git@github.com:owner/repo.git");
    });

    it("returns null when no remote", () => {
      mockExec.mockImplementation(() => {
        throw new Error("no remote");
      });
      expect(reader.getRemoteUrl()).toBeNull();
    });
  });

  describe("getCommits", () => {
    it("parses commits from git log", () => {
      const logOutput = [
        `abc1234567890abc1234567890abc1234567890ab\x1eAlice\x1ealice@test.com\x1e2024-01-01 10:00:00 +0000\x1efeat: add thing\x1ebody text\x1eparent1\x1e---COMMIT---`,
      ].join("");

      mockExec
        .mockReturnValueOnce("refs/remotes/origin/main") // resolveDefaultBranch -> symbolic-ref
        .mockReturnValueOnce(logOutput) // git log
        .mockReturnValueOnce("1 file changed, 10 insertions(+), 2 deletions(-)") // shortstat
        .mockReturnValueOnce("src/index.ts"); // diff-tree

      const commits = reader.getCommits({ limit: 10, skipMerges: false });
      expect(commits).toHaveLength(1);
      expect(commits[0]!.author).toBe("Alice");
      expect(commits[0]!.subject).toBe("feat: add thing");
      expect(commits[0]!.insertions).toBe(10);
      expect(commits[0]!.deletions).toBe(2);
    });

    it("returns empty array for empty repo", () => {
      mockExec.mockImplementation(() => {
        throw new Error("no commits");
      });
      expect(reader.getCommits({ limit: 10, skipMerges: false })).toEqual([]);
    });
  });

  describe("getTrackedFiles", () => {
    it("returns file list", () => {
      mockExec.mockReturnValue("src/index.ts\nsrc/types.ts\n");
      expect(reader.getTrackedFiles()).toEqual([
        "src/index.ts",
        "src/types.ts",
      ]);
    });
  });

  describe("getFileChangeFrequency", () => {
    it("counts file changes", () => {
      mockExec
        .mockReturnValueOnce("refs/remotes/origin/main") // resolveDefaultBranch
        .mockReturnValueOnce("src/a.ts\nsrc/b.ts\nsrc/a.ts\n"); // git log
      const freq = reader.getFileChangeFrequency(100);
      expect(freq.get("src/a.ts")).toBe(2);
      expect(freq.get("src/b.ts")).toBe(1);
    });
  });

  describe("getRemoteBranches", () => {
    it("returns branch list", () => {
      mockExec.mockReturnValue("origin/main\norigin/develop\n");
      expect(reader.getRemoteBranches()).toEqual(["main", "develop"]);
    });
  });
});
