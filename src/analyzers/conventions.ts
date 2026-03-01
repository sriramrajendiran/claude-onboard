import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import type { Commit, Convention } from "../types.js";

const CONVENTIONAL_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+?\))?!?:\s/;
const JIRA_RE = /^[A-Z]{2,10}-\d+\s/;
const GITHUB_REF_RE = /^(closes?|fixes?|resolves?)\s+#\d+/i;
const EMOJI_RE = /^[\p{Emoji_Presentation}\p{Emoji}\u200D]+\s/u;

export class ConventionExtractor {
  constructor(
    private readonly repoPath: string,
    private readonly commits: Commit[],
  ) {}

  extract(): Convention[] {
    const conventions: Convention[] = [];

    const commitStyle = this.detectCommitStyle(
      this.commits.map((c) => c.subject),
    );
    if (commitStyle) conventions.push(commitStyle);

    const fileNaming = this.detectFileNaming(
      this.commits.flatMap((c) => c.filesChanged),
    );
    if (fileNaming) conventions.push(fileNaming);

    const testStructure = this.detectTestStructure();
    if (testStructure) conventions.push(testStructure);

    conventions.push(...this.readCodeStyleConfig());

    return conventions;
  }

  private detectCommitStyle(messages: string[]): Convention | null {
    if (messages.length === 0) return null;

    const counts = { conventional: 0, jira: 0, github: 0, emoji: 0, free: 0 };
    const examples: Record<string, string[]> = {
      conventional: [],
      jira: [],
      github: [],
      emoji: [],
      free: [],
    };

    for (const msg of messages) {
      if (CONVENTIONAL_RE.test(msg)) {
        counts.conventional++;
        if (examples.conventional!.length < 3) examples.conventional!.push(msg);
      } else if (JIRA_RE.test(msg)) {
        counts.jira++;
        if (examples.jira!.length < 3) examples.jira!.push(msg);
      } else if (GITHUB_REF_RE.test(msg)) {
        counts.github++;
        if (examples.github!.length < 3) examples.github!.push(msg);
      } else if (EMOJI_RE.test(msg)) {
        counts.emoji++;
        if (examples.emoji!.length < 3) examples.emoji!.push(msg);
      } else {
        counts.free++;
        if (examples.free!.length < 3) examples.free!.push(msg);
      }
    }

    const total = messages.length;
    const entries = Object.entries(counts) as [string, number][];
    const best = entries.sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;

    const [style, count] = best;
    const confidence = count / total;

    const descriptions: Record<string, string> = {
      conventional: "Conventional Commits (type(scope): description)",
      jira: "Jira-prefixed commits (PROJ-123 description)",
      github: "GitHub-linked commits (Closes #123)",
      emoji: "Emoji-prefixed commits",
      free: "Free-form commit messages",
    };

    return {
      type: "commit",
      pattern: style,
      description: descriptions[style] ?? "Free-form",
      examples: examples[style] ?? [],
      confidence,
      detectedFrom: "git-log",
    };
  }

  private detectFileNaming(files: string[]): Convention | null {
    if (files.length === 0) return null;

    // Only look at source files
    const sourceExts = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".rb",
      ".go",
      ".rs",
      ".java",
      ".php",
    ]);
    const sourceFiles = files.filter((f) => sourceExts.has(extname(f)));
    if (sourceFiles.length === 0) return null;

    const counts = { kebab: 0, snake: 0, camel: 0, pascal: 0 };
    const examples: Record<string, string[]> = {
      kebab: [],
      snake: [],
      camel: [],
      pascal: [],
    };

    for (const file of sourceFiles) {
      const name = basename(file, extname(file));
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) {
        counts.kebab++;
        if (examples.kebab!.length < 3) examples.kebab!.push(file);
      } else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) {
        counts.snake++;
        if (examples.snake!.length < 3) examples.snake!.push(file);
      } else if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) {
        counts.camel++;
        if (examples.camel!.length < 3) examples.camel!.push(file);
      } else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
        counts.pascal++;
        if (examples.pascal!.length < 3) examples.pascal!.push(file);
      }
    }

    const entries = Object.entries(counts) as [string, number][];
    const best = entries.sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] === 0) return null;

    const [style, count] = best;
    const total = sourceFiles.length;

    const descriptions: Record<string, string> = {
      kebab: "kebab-case file naming",
      snake: "snake_case file naming",
      camel: "camelCase file naming",
      pascal: "PascalCase file naming",
    };

    return {
      type: "file",
      pattern: style,
      description: descriptions[style] ?? style,
      examples: examples[style] ?? [],
      confidence: count / total,
      detectedFrom: "file-scan",
    };
  }

  private detectTestStructure(): Convention | null {
    const files = new Set<string>();
    for (const c of this.commits) {
      for (const f of c.filesChanged) {
        files.add(f);
      }
    }

    let colocated = 0;
    let separate = 0;
    const testPatterns = /\.(test|spec)\.(ts|tsx|js|jsx)$|_test\.(go|py|rb)$/;

    for (const file of files) {
      if (testPatterns.test(file)) {
        if (
          file.startsWith("tests/") ||
          file.startsWith("test/") ||
          file.startsWith("__tests__/") ||
          file.startsWith("spec/")
        ) {
          separate++;
        } else {
          colocated++;
        }
      }
    }

    if (colocated === 0 && separate === 0) return null;

    const structure =
      colocated > 0 && separate > 0
        ? "mixed"
        : colocated > separate
          ? "colocated"
          : "separate-dir";

    return {
      type: "test",
      pattern: structure,
      description: `Test files are ${structure === "colocated" ? "colocated with source" : structure === "separate-dir" ? "in a separate directory" : "in both locations"}`,
      examples: [],
      confidence: 0.8,
      detectedFrom: "file-scan",
    };
  }

  private readCodeStyleConfig(): Convention[] {
    const conventions: Convention[] = [];
    const configs: [string, string, string][] = [
      [".eslintrc.json", "ESLint", "code"],
      [".eslintrc.js", "ESLint", "code"],
      [".eslintrc.cjs", "ESLint", "code"],
      ["eslint.config.js", "ESLint (flat config)", "code"],
      [".prettierrc", "Prettier", "code"],
      [".prettierrc.json", "Prettier", "code"],
      ["prettier.config.js", "Prettier", "code"],
      ["biome.json", "Biome", "code"],
      [".editorconfig", "EditorConfig", "code"],
      ["pyproject.toml", "pyproject.toml", "code"],
      ["rustfmt.toml", "rustfmt", "code"],
    ];

    for (const [file, name, type] of configs) {
      if (existsSync(join(this.repoPath, file))) {
        conventions.push({
          type: type as Convention["type"],
          pattern: name,
          description: `Uses ${name} for code formatting/linting`,
          examples: [file],
          confidence: 1.0,
          detectedFrom: "file-scan",
        });
      }
    }

    return conventions;
  }
}
