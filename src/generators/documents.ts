import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
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
  renderFolderClaudeMd,
  renderOnboardCommand,
  renderStatusCommand,
  renderUpdateDocsCommand,
  renderPRReviewCommand,
  renderAskCommand,
  renderArchitectureContext,
  renderPatternsContext,
  renderHotfilesContext,
  AUTO_START,
  AUTO_END,
  flattenModules,
} from "./templates.js";
import { GitReader } from "../analyzers/git.js";
import type { AnalysisSnapshot } from "../types.js";
import { AgentBuilder } from "./agents.js";

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

    // ── Layered context files ──
    files.push(
      this.smartWrite(
        ".claude/context/architecture.md",
        renderArchitectureContext(this.analysis),
        force,
      ),
    );
    files.push(
      this.smartWrite(
        ".claude/context/patterns.md",
        renderPatternsContext(this.analysis, this.humanAnswers),
        force,
      ),
    );
    files.push(
      this.smartWrite(
        ".claude/context/hotfiles.md",
        renderHotfilesContext(this.analysis),
        force,
      ),
    );

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

    // Clean up legacy skills directory
    const skillsDir = join(this.repoPath, ".claude", "skills");
    if (existsSync(skillsDir)) {
      rmSync(skillsDir, { recursive: true, force: true });
    }

    // Agents
    const agentBuilder = new AgentBuilder(this.repoPath, this.analysis);
    const agentFiles = await agentBuilder.buildAll();
    for (const af of agentFiles) {
      files.push(this.smartWrite(af.path, af.content, force));
    }

    // Folder-level CLAUDE.md for progressive context disclosure
    const sa = this.analysis.sourceAnalysis;
    if (sa) {
      const allModules = flattenModules(sa.modules);
      for (const dir of sa.hotpathDirs) {
        const module = allModules.find((m) => m.path === dir);
        if (module) {
          const content = renderFolderClaudeMd(this.analysis, module);
          files.push(this.smartWrite(`${dir}/CLAUDE.md`, content, force));
        }
      }
    }

    // ── Save analysis snapshot for incremental updates ──
    const git = new GitReader(this.repoPath);
    const currentSha = git.getHead();
    if (currentSha) {
      const snapshot: AnalysisSnapshot = {
        sha: currentSha,
        analyzedAt: new Date().toISOString(),
        fileFrequency: Object.fromEntries(
          this.analysis.criticalPaths.map((p) => [p.path, p.changeCount]),
        ),
        coChangeMatrix: {},
        importGraph: this.analysis.importGraph
          ? {
              inDegree: Object.fromEntries(this.analysis.importGraph.inDegree),
              topByFanIn: this.analysis.importGraph.topByFanIn,
            }
          : { inDegree: {}, topByFanIn: [] },
        keyTypes: (this.analysis.sourceAnalysis?.keyTypes ?? []).map((kt) => ({
          name: kt.name,
          file: kt.file,
          kind: kt.kind,
          linesOfCode: kt.linesOfCode,
          description: kt.description,
        })),
        criticalPaths: this.analysis.criticalPaths,
      };
      this.writeFile(
        join(this.repoPath, ".claude", ".onboard-snapshot.json"),
        JSON.stringify(snapshot, null, 2),
      );
    }

    // Meta file
    const metaContent = JSON.stringify(
      {
        version: "0.1.0",
        lastUpdated: new Date().toISOString(),
        lastAnalyzedSha: currentSha ?? "",
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



  private writeFile(fullPath: string, content: string): void {
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf-8");
  }
}
