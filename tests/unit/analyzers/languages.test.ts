import { describe, it, expect, vi, beforeEach } from "vitest";
import { LanguageDetector } from "../../../src/analyzers/languages.js";

vi.mock("../../../src/analyzers/git.js", () => ({
  GitReader: class {
    isGitRepo() { return true; }
    getTrackedFiles() {
      return [
        "src/index.ts",
        "src/types.ts",
        "src/app.tsx",
        "src/utils.js",
        "main.py",
        "package.json",
        "tsconfig.json",
      ];
    }
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      const existing = new Set([
        "/fake/repo/package.json",
        "/fake/repo/package-lock.json",
        "/fake/repo/tsconfig.json",
      ]);
      return existing.has(path as string);
    }),
    readFileSync: vi.fn((path: string) => {
      if ((path as string).endsWith("package.json")) {
        return JSON.stringify({
          dependencies: { react: "^18.0.0", "react-dom": "^18.0.0", next: "^14.0.0" },
          devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" },
        });
      }
      return "";
    }),
  };
});

describe("LanguageDetector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects languages from file extensions", () => {
    const detector = new LanguageDetector("/fake/repo");
    const result = detector.detect();
    expect(result.languages[0]!.name).toBe("TypeScript");
    expect(result.languages.some((l) => l.name === "JavaScript")).toBe(true);
    expect(result.languages.some((l) => l.name === "Python")).toBe(true);
  });

  it("detects frameworks from package.json", () => {
    const detector = new LanguageDetector("/fake/repo");
    const result = detector.detect();
    expect(result.frameworks).toContain("Next.js");
    expect(result.frameworks).toContain("React");
  });

  it("detects test frameworks", () => {
    const detector = new LanguageDetector("/fake/repo");
    const result = detector.detect();
    expect(result.testFrameworks).toContain("Vitest");
  });

  it("detects package managers from lockfiles", () => {
    const detector = new LanguageDetector("/fake/repo");
    const result = detector.detect();
    expect(result.packageManagers).toContain("npm");
  });
});
