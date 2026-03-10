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
  renderUpdateContextCommand,
  renderPRReviewCommand,
  renderAskCommand,
  renderDecisionCaptureCommand,
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
      [".claude/commands/update-context.md", renderUpdateContextCommand()],
      [".claude/commands/pr-review.md", renderPRReviewCommand()],
      [".claude/commands/ask.md", renderAskCommand()],
      [".claude/commands/capture-decisions.md", renderDecisionCaptureCommand()],
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

    // ── Decision Memory scaffold ──
    files.push(...this.scaffoldDecisions(force));

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



  private scaffoldDecisions(force: boolean): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    const decisionsDir = join(this.repoPath, ".decisions");

    // Only scaffold if .decisions/ doesn't exist yet (unless forced)
    if (existsSync(decisionsDir) && !force) {
      return files;
    }

    // Create directory structure
    for (const dir of ["active", "knowledge", "superseded", "session-logs"]) {
      const dirPath = join(decisionsDir, dir);
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }
    }

    // INDEX.md
    files.push(this.smartWrite(".decisions/INDEX.md", `# Decision & Knowledge Index — ${this.analysis.repoName}

> Auto-maintained by decision-memory agent. Do not edit manually.

## Active Decisions

_No decisions recorded yet. The decision-memory agent will populate this as decisions are captured._

## Knowledge Base

_No knowledge entries yet. The decision-memory agent will build this over time._

## Statistics

- Decisions: 0
- Knowledge entries: 0
- Maturity: 🌱 Uninitialized
`, force));

    // README.md
    files.push(this.smartWrite(".decisions/README.md", `# Decision Memory

This directory contains the institutional knowledge for this repository — decisions, rationale, rejected alternatives, and learned knowledge captured by the decision-memory agent.

## Structure

- \`active/\` — Current, in-effect decisions (ARCH-*, CONV-*, REJ-*, SCOPE-*, BEH-*)
- \`knowledge/\` — Learned knowledge from Q&A (KNOW-*, PROC-*, DOM-*, PREF-*, CONST-*, HIST-*)
- \`superseded/\` — Decisions that were later overridden
- \`session-logs/\` — Per-session capture logs
- \`questions-asked.log\` — Dedup log of every question asked
- \`INDEX.md\` — Auto-generated decision + knowledge log

## How It Works

The decision-memory agent is triggered automatically on pre-commit hooks. It:
1. Reviews staged changes for decisions and ambiguous code
2. Checks existing knowledge before asking questions
3. Asks the developer via AskUserQuestion until every change is understood
4. Records all decisions and knowledge permanently

You can also trigger it manually by spawning the decision-memory agent.

## Categories

### Decisions
| Prefix | Category | Examples |
|--------|----------|----------|
| ARCH | Architectural | Database choice, API design, service boundaries |
| CONV | Convention | Naming, file structure, code style |
| REJ | Rejection | Why we didn't use GraphQL, why not microservices |
| SCOPE | Scope | Deferred features, priority calls |
| BEH | Behavioral | Error handling, UX choices, edge cases |

### Knowledge
| Prefix | Category | Examples |
|--------|----------|----------|
| KNOW | Codebase | Module boundaries, why code exists |
| PROC | Process | Deploy flow, PR review, release process |
| DOM | Domain | Business logic, customer requirements |
| PREF | Preference | Team work style, implicit conventions |
| CONST | Constraint | Compliance limits, infrastructure constraints |
| HIST | History | Why code is this way, past incidents |
`, force));

    // questions-asked.log (empty)
    const logPath = join(decisionsDir, "questions-asked.log");
    if (!existsSync(logPath)) {
      writeFileSync(logPath, "# Questions Asked Log — tracks every question to prevent duplicates\n# Format: date | id | question | status\n", "utf-8");
      files.push({ path: ".decisions/questions-asked.log", content: "", action: "created" });
    }

    // .gitkeep files for empty directories
    for (const dir of ["active", "knowledge", "superseded", "session-logs"]) {
      const keepPath = join(decisionsDir, dir, ".gitkeep");
      if (!existsSync(keepPath)) {
        writeFileSync(keepPath, "", "utf-8");
      }
    }

    return files;
  }

  private writeFile(fullPath: string, content: string): void {
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf-8");
  }
}
