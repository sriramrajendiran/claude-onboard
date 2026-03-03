import { resolve, basename, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { AnalysisTier } from "../types.js";
import type {
  OnboardOptions,
  UpdateOptions,
  RepositoryAnalysis,
  Contributor,
  DocHealthReport,
  ConfidenceScore,
  ConfidenceGap,
  CoChangePair,
  AnalysisSnapshot,
  SmartQuestion,
} from "../types.js";
import { GitReader } from "./git.js";
import { LanguageDetector, getFrameworkQuestions } from "./languages.js";
import { ConventionExtractor } from "./conventions.js";
import { ArchitectureInferrer } from "./architecture.js";
import { GitHubClient } from "./github.js";
import { SourceAnalyzer } from "./source.js";
import { ImportGraphBuilder } from "./imports.js";

export class RepositoryAnalyzer {
  private readonly options: OnboardOptions;
  private langDetector?: LanguageDetector;

  constructor(options: OnboardOptions) {
    this.options = { ...options, repoPath: resolve(options.repoPath) };
  }

  async analyze(
    onProgress?: (step: string, pct: number) => void,
  ): Promise<RepositoryAnalysis> {
    const { repoPath, maxCommits, maxPRs, githubRepo } = this.options;
    const tier = this.options.tier ?? AnalysisTier.Two;

    const repoName = basename(repoPath);
    const git = new GitReader(repoPath);
    if (!git.isGitRepo()) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    // ── Phase 0 (always): Validate git repo, get metadata ──
    onProgress?.("Reading repository metadata", 5);
    const defaultBranch = git.getDefaultBranch();
    const remoteUrl = git.getRemoteUrl();

    if (tier === AnalysisTier.Zero) {
      onProgress?.("Finalizing analysis", 100);
      return this.buildMinimalAnalysis(repoPath, repoName, defaultBranch, remoteUrl);
    }

    // ── Phase 1 (tier >= 1): Single-pass git log + language detection + conventions ──
    onProgress?.("Reading git history", 10);
    const { commits, fileFrequency: fileFreq, coChangeMatrix } = git.getCommitsSinglePass({
      limit: maxCommits,
      skipMerges: false,
      branch: defaultBranch,
    });
    const trackedFiles = git.getTrackedFiles();

    onProgress?.("Detecting languages and frameworks", 30);
    this.langDetector = new LanguageDetector(repoPath);
    const langDetector = this.langDetector;
    const langInfo = langDetector.detect();

    onProgress?.("Extracting conventions", 40);
    const conventionExtractor = new ConventionExtractor(repoPath, commits);
    const conventions = conventionExtractor.extract();

    const primaryLanguage = langInfo.languages[0]?.name ?? "Unknown";

    if (tier === AnalysisTier.One) {
      onProgress?.("Analyzing contributors", 80);
      const contributors = this.buildContributors(commits);
      const criticalPaths = this.buildCriticalPaths(fileFreq, commits);

      onProgress?.("Finalizing analysis", 100);
      return {
        repoPath,
        repoName,
        defaultBranch,
        remoteUrl,
        analyzedAt: new Date().toISOString(),
        commits,
        contributors,
        primaryLanguage,
        languages: langInfo.languages,
        frameworks: langInfo.frameworks,
        testFrameworks: langInfo.testFrameworks,
        buildTools: langInfo.buildTools,
        ciSystems: langInfo.ciSystems,
        packageManagers: langInfo.packageManagers,
        conventions,
        criticalPaths,
        architecture: { style: "unknown", entryPoints: [], layers: [], keyModules: [], databasePatterns: [], apiPatterns: [], testStructure: "none", hasDockerfile: false, hasInfraAsCode: false },
        patterns: [],
        prInsights: [],
        coChangePairs: this.buildCoChangePairs(coChangeMatrix, fileFreq),
        testCoverage: this.assessTestCoverage(langInfo.testFrameworks, "none"),
        documentationCoverage: this.assessDocCoverage(repoPath),
        ciCoverage: this.assessCICoverage(langInfo.ciSystems),
      };
    }

    // ── Phase 2 (tier >= 2): Deep source analysis + import graph + architecture in parallel ──
    onProgress?.("Analyzing source code and imports", 50);
    const sourceAnalyzer = new SourceAnalyzer(repoPath, fileFreq, commits, trackedFiles);
    const importBuilder = new ImportGraphBuilder(repoPath, trackedFiles);

    const sourceAnalysis = sourceAnalyzer.analyze();
    const importGraph = importBuilder.build();

    onProgress?.("Inferring architecture", 60);
    const archInferrer = new ArchitectureInferrer(
      repoPath,
      langInfo.languages.map((l) => l.name),
    );
    const architecture = archInferrer.infer();

    onProgress?.("Analyzing contributors", 70);
    const contributors = this.buildContributors(commits);

    onProgress?.("Computing critical paths", 80);
    const criticalPaths = this.buildCriticalPaths(fileFreq, commits);

    // ── Phase 3 (tier >= 3): PR analysis ──
    let prInsights: RepositoryAnalysis["prInsights"] = [];
    if (tier >= AnalysisTier.Three && githubRepo && maxPRs > 0) {
      onProgress?.("Fetching PR data", 90);
      const ghClient = new GitHubClient({
        repo: githubRepo,
        cacheDir: join(repoPath, ".claude"),
      });
      prInsights = await ghClient.fetchPRs({
        limit: maxPRs,
        state: "merged",
      });
    }

    onProgress?.("Finalizing analysis", 100);

    return {
      repoPath,
      repoName,
      defaultBranch,
      remoteUrl,
      analyzedAt: new Date().toISOString(),

      commits,
      contributors,

      primaryLanguage,
      languages: langInfo.languages,

      frameworks: langInfo.frameworks,
      testFrameworks: langInfo.testFrameworks,
      buildTools: langInfo.buildTools,
      ciSystems: langInfo.ciSystems,
      packageManagers: langInfo.packageManagers,

      conventions,
      criticalPaths,
      architecture,
      patterns: [],
      prInsights,
      sourceAnalysis,
      importGraph,
      coChangePairs: this.buildCoChangePairs(coChangeMatrix, fileFreq),

      testCoverage: this.assessTestCoverage(langInfo.testFrameworks, architecture.testStructure),
      documentationCoverage: this.assessDocCoverage(repoPath),
      ciCoverage: this.assessCICoverage(langInfo.ciSystems),
    };
  }

  /**
   * Incremental analysis: loads snapshot, gets delta since last SHA,
   * merges into snapshot data. Returns null if nothing changed,
   * or falls back to full analyze() if no snapshot exists.
   */
  async analyzeIncremental(
    _updateOptions: UpdateOptions,
  ): Promise<{ analysis: RepositoryAnalysis; incremental: boolean } | null> {
    const { repoPath } = this.options;
    const git = new GitReader(repoPath);

    // Load persisted snapshot
    const snapshotPath = join(repoPath, ".claude", ".onboard-snapshot.json");
    let snapshot: AnalysisSnapshot | null = null;
    if (existsSync(snapshotPath)) {
      try {
        snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as AnalysisSnapshot;
      } catch {
        // ignore corrupt snapshot
      }
    }

    const currentSha = git.getHead();

    if (!snapshot || !currentSha) {
      // No snapshot — fall back to full analysis
      return { analysis: await this.analyze(), incremental: false };
    }

    if (snapshot.sha === currentSha) {
      // Nothing changed
      return null;
    }

    // Get only commits since the snapshot SHA
    const delta = git.getCommitsSinglePass({
      limit: 200,
      since: snapshot.sha,
      skipMerges: false,
    });

    // If delta found no new commits, still do a lightweight tier-1 analysis
    if (delta.commits.length === 0) {
      return null;
    }

    // Merge file frequency from snapshot + delta
    const mergedFrequency = new Map<string, number>(
      Object.entries(snapshot.fileFrequency),
    );
    for (const [file, count] of delta.fileFrequency) {
      mergedFrequency.set(file, (mergedFrequency.get(file) ?? 0) + count);
    }

    // Update critical paths from merged frequency
    const criticalPaths = [...mergedFrequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([path, changeCount]) => ({ path, changeCount, lastChanged: "" }));

    // Build co-change pairs from delta
    const coChangePairs = this.buildCoChangePairs(delta.coChangeMatrix, mergedFrequency);

    // Reconstruct import graph from snapshot
    const importGraph: RepositoryAnalysis["importGraph"] = snapshot.importGraph
      ? {
          adjacency: new Map(),
          inDegree: new Map(Object.entries(snapshot.importGraph.inDegree)),
          topByFanIn: snapshot.importGraph.topByFanIn,
        }
      : undefined;

    // Save updated snapshot
    const updatedSnapshot: AnalysisSnapshot = {
      sha: currentSha,
      analyzedAt: new Date().toISOString(),
      fileFrequency: Object.fromEntries(mergedFrequency),
      coChangeMatrix: snapshot.coChangeMatrix,
      importGraph: snapshot.importGraph,
      keyTypes: snapshot.keyTypes,
      criticalPaths,
    };

    const dir = join(repoPath, ".claude");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(updatedSnapshot, null, 2), "utf-8");

    // Do a quick tier-1 analysis for language/convention data, then merge in snapshot data
    const tier1 = await this.analyze();
    // Override with merged data from snapshot + delta
    tier1.criticalPaths = criticalPaths;
    tier1.coChangePairs = coChangePairs;
    if (importGraph) tier1.importGraph = importGraph;

    return { analysis: tier1, incremental: true };
  }

  async checkDocHealth(): Promise<DocHealthReport> {
    const repoPath = this.options.repoPath;
    const claudeDir = join(repoPath, ".claude");
    const issues: DocHealthReport["issues"] = [];
    const recommendations: string[] = [];

    const expectedFiles = [
      "CLAUDE.md",
      "commands/onboard.md",
      "commands/status.md",
      ".onboarder-meta.json",
    ];

    const fileStatus: DocHealthReport["fileStatus"] = [];
    let existingCount = 0;
    let staleCount = 0;

    const metaPath = join(claudeDir, ".onboarder-meta.json");
    let lastUpdated = "";
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<
          string,
          string
        >;
        lastUpdated = meta.lastUpdated ?? "";
      } catch {
        // ignore
      }
    }

    const git = new GitReader(repoPath);
    const commitsSinceUpdate = lastUpdated
      ? git.getCommitsSinglePass({ limit: 1000, skipMerges: true })
          .commits.filter((c) => c.date > lastUpdated).length
      : 0;

    for (const file of expectedFiles) {
      const fullPath = join(claudeDir, file);
      const exists = existsSync(fullPath);
      let lastModified = "";
      let stale = false;

      if (exists) {
        existingCount++;
        try {
          lastModified = statSync(fullPath).mtime.toISOString();
          stale = commitsSinceUpdate > 10;
          if (stale) staleCount++;
        } catch {
          // ignore
        }
      } else {
        issues.push({
          severity: "error",
          message: `Missing file: .claude/${file}`,
        });
      }

      fileStatus.push({ path: `.claude/${file}`, exists, stale, lastModified });
    }

    if (staleCount > 0) {
      issues.push({
        severity: "warning",
        message: `${staleCount} files may be stale (${commitsSinceUpdate} commits since last update)`,
      });
      recommendations.push(
        "Run `npx claude-onboard update` to refresh documentation",
      );
    }

    if (existingCount === 0) {
      recommendations.push(
        "Run `npx claude-onboard init` to generate documentation",
      );
    }

    const maxScore = expectedFiles.length * 20;
    const score = Math.round(
      ((existingCount * 20 - staleCount * 5) / maxScore) * 100,
    );
    const clampedScore = Math.max(0, Math.min(100, score));

    const grade: DocHealthReport["grade"] =
      clampedScore >= 90
        ? "A"
        : clampedScore >= 80
          ? "B"
          : clampedScore >= 70
            ? "C"
            : clampedScore >= 60
              ? "D"
              : "F";

    return {
      score: clampedScore,
      grade,
      lastUpdated: lastUpdated || "never",
      commitsSinceUpdate,
      issues,
      recommendations,
      fileStatus,
    };
  }

  computeConfidenceScore(analysis: RepositoryAnalysis): ConfidenceScore {
    const sa = analysis.sourceAnalysis;
    const arch = analysis.architecture;
    const gaps: ConfidenceGap[] = [];

    // ── Project Identity (20 points) ──
    // High confidence = found real description from README/package.json
    // Low confidence = fell back to generic "{name} is a {lang} {style}"
    const idDetails: string[] = [];
    let idScore = 0;
    if (sa?.projectDescription) {
      idScore += 12; idDetails.push("description from source");
    } else {
      gaps.push({
        dimension: "Project Identity",
        question: "What does this project do? Describe its purpose in 1-2 sentences.",
        context: "No project description found in README, package.json, or pom.xml. Generated a generic fallback.",
        impact: "high",
        currentGuess: `${analysis.repoName} is a ${analysis.primaryLanguage} ${arch.style}`,
      });
    }
    if (sa?.packageStructure) { idScore += 4; idDetails.push("package structure"); }
    else { idScore += 1; } // we at least have the repo name
    if (analysis.primaryLanguage !== "Unknown") { idScore += 4; idDetails.push(analysis.primaryLanguage); }
    else {
      gaps.push({
        dimension: "Project Identity",
        question: "What is the primary programming language for this project?",
        context: "Could not detect the primary language from file extensions.",
        impact: "high",
      });
    }

    // ── Build & Run (20 points) ──
    // High confidence = commands from explicit scripts (package.json, Makefile targets)
    // Low confidence = inferred from tool presence (e.g., guessed `mvn install` from pom.xml)
    const buildDetails: string[] = [];
    let buildScore = 0;
    if (sa) {
      const cmds = sa.buildCommands;
      const cmdNames = new Set(cmds.map((c) => c.name));
      // 5pts per command type, but only full credit if from explicit scripts
      for (const [name, label] of [["build", "build"], ["test", "test"], ["run", "run"], ["lint", "lint"]] as const) {
        const matchNames = name === "run" ? ["run", "dev", "start", "run-local"] : name === "lint" ? ["lint", "typecheck", "format"] : [name];
        if (matchNames.some((n) => cmdNames.has(n))) {
          const cmd = cmds.find((c) => matchNames.includes(c.name));
          const isExplicit = cmd && (cmd.source.includes("package.json") || cmd.source.includes("Makefile") || cmd.source.includes("scripts"));
          buildScore += isExplicit ? 5 : 3;
          buildDetails.push(isExplicit ? `${label} (explicit)` : `${label} (inferred)`);
        }
      }

      if (buildScore < 10) {
        const missing = [];
        if (!cmdNames.has("build")) missing.push("build");
        if (!cmdNames.has("test")) missing.push("test");
        if (!["run", "dev", "start", "run-local"].some((n) => cmdNames.has(n))) missing.push("run/start");
        const buildGap: ConfidenceGap = {
          dimension: "Build & Run",
          question: `What are the commands to ${missing.join(", ")} this project?`,
          context: `Only found ${cmds.length} commands. Missing: ${missing.join(", ")}.`,
          impact: "high",
        };
        if (cmds.length > 0) buildGap.currentGuess = cmds.map((c) => c.command).join("; ");
        gaps.push(buildGap);
      }
    } else {
      gaps.push({
        dimension: "Build & Run",
        question: "What commands are used to build, test, and run this project?",
        context: "Source analysis not available — could not detect any build commands.",
        impact: "high",
      });
    }

    // ── Architecture (20 points) ──
    const archDetails: string[] = [];
    let archScore = 0;
    if (arch.style !== "unknown") {
      archScore += 5; archDetails.push(`style: ${arch.style}`);
    } else {
      gaps.push({
        dimension: "Architecture",
        question: "How is this codebase organized? (e.g., monolith, microservices, monorepo, library)",
        context: "Could not confidently determine the architecture style.",
        impact: "high",
      });
    }
    if (arch.entryPoints.length > 0) { archScore += 4; archDetails.push(`${arch.entryPoints.length} entry points`); }
    else {
      gaps.push({
        dimension: "Architecture",
        question: "What are the main entry points to this application?",
        context: "No entry points detected (e.g., main class, index file, server startup).",
        impact: "medium",
      });
    }
    if (arch.layers.length > 0) { archScore += 4; archDetails.push(`${arch.layers.length} layers`); }
    else {
      gaps.push({
        dimension: "Architecture",
        question: "What are the main layers or modules in this codebase? (e.g., API → service → repository → database)",
        context: "No layered architecture detected.",
        impact: "medium",
      });
    }
    if (arch.apiPatterns.length > 0) { archScore += 4; archDetails.push(arch.apiPatterns.join(", ")); }
    if (sa && sa.serviceMap.length > 0) { archScore += 3; archDetails.push(`${sa.serviceMap.length} services`); }
    archScore = Math.min(20, archScore);

    // ── Code Patterns (15 points) ──
    const patDetails: string[] = [];
    let patScore = 0;
    if (sa) {
      const patCount = sa.codePatterns.length;
      patScore += Math.min(9, patCount * 3);
      if (patCount > 0) patDetails.push(`${patCount} patterns found`);

      const typeCount = sa.keyTypes.length;
      patScore += Math.min(6, Math.round(typeCount / 5));
      if (typeCount > 0) patDetails.push(`${typeCount} key types`);

      if (patCount === 0) {
        gaps.push({
          dimension: "Code Patterns",
          question: "What patterns or idioms should developers follow in this codebase? (e.g., DI style, error handling, naming conventions)",
          context: "No code patterns detected from static analysis.",
          impact: "medium",
        });
      }
    } else {
      gaps.push({
        dimension: "Code Patterns",
        question: "What coding patterns and idioms does this project use?",
        context: "Source analysis not available.",
        impact: "medium",
      });
    }
    patScore = Math.min(15, patScore);

    // ── Domain Context (15 points) ──
    // This is almost always low from static analysis — needs human input
    const domDetails: string[] = [];
    let domScore = 0;
    if (sa && sa.teamRules.length > 0) {
      domScore += Math.min(5, sa.teamRules.length * 2);
      domDetails.push(`${sa.teamRules.length} team rules`);
    }
    if (analysis.conventions.length > 0) {
      domScore += Math.min(4, analysis.conventions.length * 2);
      domDetails.push(`${analysis.conventions.length} conventions`);
    }
    if (sa?.commitPatterns.style !== "unknown") {
      domScore += 2; domDetails.push(`commit: ${sa!.commitPatterns.style}`);
    }
    if (sa?.commitPatterns.branchPattern) {
      domScore += 2; domDetails.push("branch pattern");
    }
    if (sa && sa.todoComments.length > 0) {
      domScore += 2; domDetails.push(`${sa.todoComments.length} TODOs`);
    }
    domScore = Math.min(15, domScore);

    if (domScore < 8) {
      gaps.push({
        dimension: "Domain Context",
        question: "What domain-specific rules or gotchas should developers know about? Any tribal knowledge not in code?",
        context: domScore === 0
          ? "No team rules, conventions, or domain documentation found."
          : "Limited domain context found — mostly inferred from git history.",
        impact: domScore === 0 ? "high" : "medium",
      });
    }

    // ── Testing (10 points) ──
    const testDetails: string[] = [];
    let testScore = 0;
    if (analysis.testFrameworks.length > 0) {
      testScore += 3; testDetails.push(analysis.testFrameworks.join(", "));
    }
    if (arch.testStructure !== "none") {
      testScore += 3; testDetails.push(`structure: ${arch.testStructure}`);
    }
    if (sa) {
      const hasTestCmd = sa.buildCommands.some((c) => c.name === "test");
      if (hasTestCmd) { testScore += 4; testDetails.push("test command"); }
      else { testScore += 1; } // at least we know the framework
    }

    if (testScore < 6) {
      gaps.push({
        dimension: "Testing",
        question: "How do you run tests? Any conventions for test organization, naming, or mocking?",
        context: testScore === 0
          ? "No test framework or test structure detected."
          : "Found test framework but limited info on how tests are organized and run.",
        impact: testScore === 0 ? "high" : "low",
      });
    }

    const total = idScore + buildScore + archScore + patScore + domScore + testScore;
    const grade: ConfidenceScore["grade"] =
      total >= 80 ? "A" : total >= 65 ? "B" : total >= 50 ? "C" : total >= 35 ? "D" : "F";

    // Sort gaps: high first, then medium, then low
    const impactOrder = { high: 0, medium: 1, low: 2 };
    gaps.sort((a, b) => impactOrder[a.impact] - impactOrder[b.impact]);

    return {
      total,
      grade,
      gaps,
      breakdown: {
        projectIdentity: { score: idScore, max: 20, details: idDetails },
        buildAndRun: { score: buildScore, max: 20, details: buildDetails },
        architecture: { score: archScore, max: 20, details: archDetails },
        codePatterns: { score: patScore, max: 15, details: patDetails },
        domainContext: { score: domScore, max: 15, details: domDetails },
        testing: { score: testScore, max: 10, details: testDetails },
      },
    };
  }

  generateSmartQuestions(analysis: RepositoryAnalysis, gaps: ConfidenceGap[], existingAnswers?: import("../types.js").HumanAnswers): SmartQuestion[] {
    const questions: SmartQuestion[] = [];
    const sa = analysis.sourceAnalysis;
    // Track already-answered questions to avoid re-asking
    const answeredQuestions = new Set(existingAnswers?.domainQA?.map((qa) => qa.question) ?? []);

    // ── Hot file questions (up to 3) ──
    const topFiles = analysis.criticalPaths.slice(0, 3);
    for (const f of topFiles) {
      const name = basename(f.path);
      questions.push({
        question: `${name} changed ${f.changeCount} times recently — what are the key business rules or invariants it enforces?`,
        context: `Most frequently changed file: ${f.path}`,
        dimension: "domainQA",
        category: "hot-file",
      });
    }

    // ── Architecture "why" questions (up to 2) ──
    const arch = analysis.architecture;
    if (arch.style !== "unknown") {
      questions.push({
        question: `The codebase appears to be a ${arch.style}. Why was this architecture chosen? Any constraints or trade-offs to know about?`,
        context: `Detected ${arch.layers.length} layers, ${arch.entryPoints.length} entry points`,
        dimension: "domainQA",
        category: "architecture",
      });
    }
    if (sa && sa.serviceMap.length > 1) {
      const names = sa.serviceMap.slice(0, 5).map((s) => s.name).join(", ");
      questions.push({
        question: `I see ${sa.serviceMap.length} services (${names}). How do they communicate? Any ordering dependencies or gotchas?`,
        context: "Detected from service map analysis",
        dimension: "domainQA",
        category: "architecture",
      });
    }

    // ── Co-change coupling questions (up to 2) ──
    if (analysis.coChangePairs) {
      for (const pair of analysis.coChangePairs.slice(0, 2)) {
        const nameA = basename(pair.fileA);
        const nameB = basename(pair.fileB);
        questions.push({
          question: `${nameA} and ${nameB} always change together (${pair.count} times). Is this intentional coupling or tech debt?`,
          context: `Co-change strength: ${(pair.strength * 100).toFixed(0)}%`,
          dimension: "domainQA",
          category: "coupling",
        });
      }
    }

    // ── Load-bearing module questions (up to 2) ──
    if (analysis.importGraph) {
      for (const mod of analysis.importGraph.topByFanIn.slice(0, 2)) {
        const name = basename(mod.file);
        questions.push({
          question: `${name} is imported by ${mod.fanIn} other files. Any rules for modifying it? Breaking change risks?`,
          context: `High fan-in module: ${mod.file}`,
          dimension: "domainQA",
          category: "load-bearing",
        });
      }
    }

    // ── Tribal knowledge questions (always asked, up to 3) ──
    questions.push({
      question: "What are the most common gotchas or pitfalls new developers hit in this codebase?",
      dimension: "domainQA",
      category: "tribal",
    });
    questions.push({
      question: "Are there any environment setup steps or secrets/config not documented anywhere?",
      dimension: "domainQA",
      category: "tribal",
    });
    questions.push({
      question: "Any areas of the codebase that are particularly fragile, slow, or tricky to work with?",
      dimension: "domainQA",
      category: "tribal",
    });

    // ── Framework-specific questions (up to 4) ──
    const fwQuestions = getFrameworkQuestions(
      analysis.frameworks,
      analysis.sourceAnalysis?.dependencies
        ?.filter((d) => d.group === "database")
        .map((d) => d.name) ?? [],
      this.langDetector?.deps ?? new Set(),
    );
    for (const fq of fwQuestions.slice(0, 4)) {
      questions.push({
        question: `[${fq.framework}] ${fq.question}`,
        context: fq.context,
        dimension: "domainQA",
        category: "framework",
      });
    }

    // ── Gap-driven questions (from confidence scoring) ──
    for (const gap of gaps.filter((g) => g.impact === "high" || g.impact === "medium")) {
      questions.push({
        question: gap.question,
        context: gap.context,
        dimension: gap.dimension,
        category: "gap",
      });
    }

    // Filter out already-answered questions, then cap at 12
    const filtered = questions.filter((q) => !answeredQuestions.has(q.question));
    return filtered.slice(0, 12);
  }

  private buildMinimalAnalysis(repoPath: string, repoName: string, defaultBranch: string, remoteUrl: string | null): RepositoryAnalysis {
    return {
      repoPath, repoName, defaultBranch, remoteUrl,
      analyzedAt: new Date().toISOString(),
      commits: [], contributors: [],
      primaryLanguage: "unknown",
      languages: [], frameworks: [], testFrameworks: [],
      buildTools: [], ciSystems: [], packageManagers: [],
      conventions: [], criticalPaths: [],
      architecture: { style: "unknown", entryPoints: [], layers: [], keyModules: [], databasePatterns: [], apiPatterns: [], testStructure: "none", hasDockerfile: false, hasInfraAsCode: false },
      patterns: [], prInsights: [],
      testCoverage: "none", documentationCoverage: "none", ciCoverage: "none",
    };
  }

  private buildCoChangePairs(
    matrix: Map<string, Map<string, number>>,
    fileFreq: Map<string, number>,
    topN = 20,
  ): CoChangePair[] {
    const pairs: CoChangePair[] = [];
    for (const [fileA, innerMap] of matrix) {
      for (const [fileB, count] of innerMap) {
        if (count < 3) continue;
        const freqA = fileFreq.get(fileA) ?? 1;
        const freqB = fileFreq.get(fileB) ?? 1;
        const strength = count / Math.min(freqA, freqB);
        pairs.push({ fileA, fileB, count, strength });
      }
    }
    return pairs.sort((a, b) => b.strength - a.strength).slice(0, topN);
  }

  private buildContributors(
    commits: RepositoryAnalysis["commits"],
  ): Contributor[] {
    const map = new Map<
      string,
      {
        name: string;
        email: string;
        commits: number;
        firstSeen: string;
        lastSeen: string;
        areas: Map<string, number>;
      }
    >();

    for (const c of commits) {
      const key = c.email || c.author;
      const existing = map.get(key);
      if (existing) {
        existing.commits++;
        if (c.date < existing.firstSeen) existing.firstSeen = c.date;
        if (c.date > existing.lastSeen) existing.lastSeen = c.date;
        for (const f of c.filesChanged) {
          const dir = f.split("/")[0] ?? "";
          if (dir) existing.areas.set(dir, (existing.areas.get(dir) ?? 0) + 1);
        }
      } else {
        const areas = new Map<string, number>();
        for (const f of c.filesChanged) {
          const dir = f.split("/")[0] ?? "";
          if (dir) areas.set(dir, (areas.get(dir) ?? 0) + 1);
        }
        map.set(key, {
          name: c.author,
          email: c.email,
          commits: 1,
          firstSeen: c.date,
          lastSeen: c.date,
          areas,
        });
      }
    }

    return [...map.values()]
      .sort((a, b) => b.commits - a.commits)
      .map((c) => ({
        name: c.name,
        email: c.email,
        commits: c.commits,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        primaryAreas: [...c.areas.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([dir]) => dir),
        languages: [],
      }));
  }

  private buildCriticalPaths(
    freq: Map<string, number>,
    commits: RepositoryAnalysis["commits"],
  ): RepositoryAnalysis["criticalPaths"] {
    const lastChanged = new Map<string, string>();
    for (const c of commits) {
      for (const f of c.filesChanged) {
        if (!lastChanged.has(f)) lastChanged.set(f, c.date);
      }
    }

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([path, changeCount]) => ({
        path,
        changeCount,
        lastChanged: lastChanged.get(path) ?? "",
      }));
  }

  private assessTestCoverage(
    testFrameworks: string[],
    testStructure: string,
  ): RepositoryAnalysis["testCoverage"] {
    if (testFrameworks.length === 0 && testStructure === "none") return "none";
    if (testFrameworks.length >= 2) return "high";
    if (testFrameworks.length === 1) return "medium";
    return "low";
  }

  private assessDocCoverage(repoPath: string): RepositoryAnalysis["documentationCoverage"] {
    let score = 0;
    if (existsSync(join(repoPath, "README.md"))) score++;
    if (existsSync(join(repoPath, "CONTRIBUTING.md"))) score++;
    if (existsSync(join(repoPath, "docs"))) score++;
    if (existsSync(join(repoPath, "CHANGELOG.md"))) score++;

    if (score >= 3) return "high";
    if (score >= 2) return "medium";
    if (score >= 1) return "low";
    return "none";
  }

  private assessCICoverage(ciSystems: string[]): RepositoryAnalysis["ciCoverage"] {
    if (ciSystems.length >= 2) return "full";
    if (ciSystems.length === 1) return "partial";
    return "none";
  }
}
