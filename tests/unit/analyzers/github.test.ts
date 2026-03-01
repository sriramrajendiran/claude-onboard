import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubClient } from "../../../src/analyzers/github.js";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const mockExec = vi.mocked(execFileSync);

describe("GitHubClient", () => {
  const client = new GitHubClient({ repo: "owner/repo", cacheDir: "/tmp/test-cache" });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isAvailable", () => {
    it("returns true when gh is installed and authenticated", () => {
      mockExec.mockReturnValue("gh version 2.40.0");
      expect(client.isAvailable()).toBe(true);
    });

    it("returns false when gh is not installed", () => {
      mockExec.mockImplementation(() => {
        throw new Error("command not found: gh");
      });
      expect(client.isAvailable()).toBe(false);
    });

    it("returns false when gh is not authenticated", () => {
      mockExec
        .mockReturnValueOnce("gh version 2.40.0") // --version
        .mockImplementationOnce(() => {
          throw new Error("not authenticated");
        }); // auth status
      expect(client.isAvailable()).toBe(false);
    });
  });

  describe("fetchPRs", () => {
    it("returns empty array when gh not available", async () => {
      mockExec.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = await client.fetchPRs({ limit: 10, state: "merged" });
      expect(result).toEqual([]);
    });

    it("parses PR data from gh output", async () => {
      mockExec
        .mockReturnValueOnce("gh version") // --version
        .mockReturnValueOnce("authenticated") // auth status
        .mockReturnValueOnce(
          JSON.stringify([
            {
              number: 42,
              title: "feat: add auth",
              body: "Adds authentication",
              author: { login: "alice" },
              mergedAt: "2024-01-01T00:00:00Z",
              files: [{ path: "src/auth.ts" }, { path: "tests/auth.test.ts" }],
              labels: [{ name: "feature" }],
              additions: 100,
              deletions: 10,
              reviews: [{ author: { login: "bob" } }],
              comments: [{ body: "LGTM" }],
              baseRefName: "main",
            },
          ]),
        ); // pr list

      const result = await client.fetchPRs({ limit: 10, state: "merged" });
      expect(result).toHaveLength(1);
      expect(result[0]!.number).toBe(42);
      expect(result[0]!.author).toBe("alice");
      expect(result[0]!.hasTests).toBe(true);
      expect(result[0]!.reviewers).toEqual(["bob"]);
      expect(result[0]!.patterns).toContain("feature");
    });
  });

  describe("fetchSinglePR", () => {
    it("returns null when gh not available", async () => {
      mockExec.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = await client.fetchSinglePR(42);
      expect(result).toBeNull();
    });
  });
});
