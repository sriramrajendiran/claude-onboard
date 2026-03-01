import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type {
  RepositoryAnalysis,
  GeneratedFile,
  UpdateOptions,
  PRInsight,
  HumanAnswers,
} from "../types.js";
import {
  renderClaudeMd,
  renderRootClaudeMd,
  renderFolderClaudeMd,
  renderOnboardCommand,
  renderStatusCommand,
  renderUpdateDocsCommand,
  renderPRReviewCommand,
  renderAskCommand,
} from "./templates.js";
import { SkillBuilder } from "./skills.js";

const AUTO_START = "<!-- onboarder:auto-start -->";
const AUTO_END = "<!-- onboarder:auto-end -->";

export class DocumentGenerator {
  constructor(
    private readonly repoPath: string,
    private readonly analysis: RepositoryAnalysis,
    private readonly humanAnswers?: HumanAnswers,
  ) {}

  async generateAll(force: boolean): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];

    // Main docs — single CLAUDE.md in .claude/
    const docFiles: [string, string][] = [
      [".claude/CLAUDE.md", renderClaudeMd(this.analysis, this.humanAnswers)],
    ];

    for (const [path, content] of docFiles) {
      if (content) files.push(this.smartWrite(path, content, force));
    }

    // Commands
    const commands: [string, string][] = [
      [".claude/commands/onboard.md", renderOnboardCommand()],
      [".claude/commands/status.md", renderStatusCommand()],
      [".claude/commands/update-docs.md", renderUpdateDocsCommand()],
      [".claude/commands/pr-review.md", renderPRReviewCommand()],
      [".claude/commands/ask.md", renderAskCommand()],
    ];

    for (const [path, content] of commands) {
      files.push(this.smartWrite(path, content, force));
    }

    // Skills
    const skillBuilder = new SkillBuilder(this.repoPath, this.analysis);
    const skillFiles = await skillBuilder.buildAll();
    for (const sf of skillFiles) {
      files.push(this.smartWrite(sf.path, sf.content, force));
    }

    // Folder-level CLAUDE.md for progressive context disclosure
    const sa = this.analysis.sourceAnalysis;
    if (sa) {
      const allModules = this.flattenModules(sa.modules);
      for (const dir of sa.hotpathDirs) {
        const module = allModules.find((m) => m.path === dir);
        if (module) {
          const content = renderFolderClaudeMd(this.analysis, module);
          files.push(this.smartWrite(`${dir}/CLAUDE.md`, content, force));
        }
      }
    }

    // Meta file
    const metaContent = JSON.stringify(
      {
        version: "0.1.0",
        lastUpdated: new Date().toISOString(),
        repoName: this.analysis.repoName,
        commitsAnalyzed: this.analysis.commits.length,
        primaryLanguage: this.analysis.primaryLanguage,
      },
      null,
      2,
    );
    files.push(this.smartWrite(".claude/.onboarder-meta.json", metaContent, true));

    return files;
  }

  async updateIncremental(_options: UpdateOptions): Promise<GeneratedFile[]> {
    // Re-generate all files — the smartWrite will skip unchanged ones
    return this.generateAll(false);
  }

  async updateFromPR(_pr: PRInsight): Promise<GeneratedFile[]> {
    return this.generateAll(false);
  }

  private smartWrite(
    relativePath: string,
    newContent: string,
    force: boolean,
  ): GeneratedFile {
    const fullPath = join(this.repoPath, relativePath);

    if (existsSync(fullPath) && !force) {
      const existing = readFileSync(fullPath, "utf-8");

      // Check if file has auto-markers
      if (existing.includes(AUTO_START) && existing.includes(AUTO_END)) {
        const merged = this.preserveManualSections(existing, newContent);
        if (merged === existing) {
          return {
            path: relativePath,
            content: existing,
            action: "skipped",
            reason: "Content unchanged",
          };
        }
        this.writeFile(fullPath, merged);
        return { path: relativePath, content: merged, action: "updated" };
      }

      // No markers — skip to avoid overwriting manual content
      return {
        path: relativePath,
        content: existing,
        action: "skipped",
        reason: "Manual content preserved",
      };
    }

    this.writeFile(fullPath, newContent);
    return {
      path: relativePath,
      content: newContent,
      action: existsSync(fullPath) ? "updated" : "created",
    };
  }

  private preserveManualSections(
    existing: string,
    generated: string,
  ): string {
    const beforeAuto = existing.split(AUTO_START)[0] ?? "";
    const afterAuto = existing.split(AUTO_END).slice(1).join(AUTO_END);
    const autoSection =
      generated.includes(AUTO_START) && generated.includes(AUTO_END)
        ? generated.slice(
            generated.indexOf(AUTO_START),
            generated.indexOf(AUTO_END) + AUTO_END.length,
          )
        : generated;

    return `${beforeAuto}${autoSection}${afterAuto}`;
  }

  private flattenModules(modules: import("../analyzers/source.js").ModuleInfo[]): import("../analyzers/source.js").ModuleInfo[] {
    const flat: import("../analyzers/source.js").ModuleInfo[] = [];
    const recurse = (ms: import("../analyzers/source.js").ModuleInfo[]) => {
      for (const m of ms) {
        flat.push(m);
        recurse(m.children);
      }
    };
    recurse(modules);
    return flat;
  }

  private writeFile(fullPath: string, content: string): void {
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf-8");
  }
}
