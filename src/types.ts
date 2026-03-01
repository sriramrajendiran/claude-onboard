// ── Enums ───────────────────────────────────────────────────────────────────

export enum AnalysisTier {
  /** Instant: git metadata only (branch, remotes, HEAD SHA). No log parsing. */
  Zero = 0,
  /** Fast (<2s): single-pass git log + language detection + conventions. */
  One = 1,
  /** Medium (<15s): deep source analysis + import graph + co-change. Default for init. */
  Two = 2,
  /** Background (no limit): PR analysis + full blame. */
  Three = 3,
}

// ── Analyzer Output ─────────────────────────────────────────────────────────

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: string;
  message: string;
  subject: string;
  body: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  isMerge: boolean;
}

export interface Contributor {
  name: string;
  email: string;
  commits: number;
  firstSeen: string;
  lastSeen: string;
  primaryAreas: string[];
  languages: string[];
}

export interface Convention {
  type: "commit" | "branch" | "file" | "code" | "test";
  pattern: string;
  description: string;
  examples: string[];
  counterExamples?: string[];
  confidence: number;
  detectedFrom: "git-log" | "file-scan" | "pr-analysis";
}

export interface ArchitectureInsight {
  style: "monolith" | "microservices" | "monorepo" | "library" | "unknown";
  entryPoints: string[];
  layers: string[];
  keyModules: string[];
  databasePatterns: string[];
  apiPatterns: string[];
  testStructure: "colocated" | "separate-dir" | "mixed" | "none";
  hasDockerfile: boolean;
  hasInfraAsCode: boolean;
}

export interface CodePattern {
  name: string;
  description: string;
  examples: string[];
  antiPatterns: string[];
  confidence: number;
}

export interface PRInsight {
  number: number;
  title: string;
  description: string;
  author: string;
  mergedAt: string | null;
  baseBranch: string;
  labels: string[];
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  patterns: string[];
  hasTests: boolean;
  reviewers: string[];
  commentCount: number;
}

export interface RepositoryAnalysis {
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
  analyzedAt: string;

  commits: Commit[];
  contributors: Contributor[];

  primaryLanguage: string;
  languages: Array<{ name: string; files: number; percentage: number }>;

  frameworks: string[];
  testFrameworks: string[];
  buildTools: string[];
  ciSystems: string[];
  packageManagers: string[];

  conventions: Convention[];
  criticalPaths: Array<{
    path: string;
    changeCount: number;
    lastChanged: string;
  }>;
  architecture: ArchitectureInsight;
  patterns: CodePattern[];
  prInsights: PRInsight[];

  // Deep source analysis
  sourceAnalysis?: import("./analyzers/source.js").SourceAnalysis;

  // Import graph (fan-in analysis)
  importGraph?: ImportGraphData;

  // Co-change coupling
  coChangePairs?: CoChangePair[];

  testCoverage: "high" | "medium" | "low" | "none";
  documentationCoverage: "high" | "medium" | "low" | "none";
  ciCoverage: "full" | "partial" | "none";
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface OnboardOptions {
  repoPath: string;
  githubRepo?: string;
  maxCommits: number;
  maxPRs: number;
  forceRegenerate: boolean;
  verbose: boolean;
  tier?: AnalysisTier;
}

export interface UpdateOptions {
  repoPath: string;
  sinceCommit?: string;
  changedFiles?: string[];
  mode: "commit" | "merge" | "rebase" | "manual";
}

// ── Generated Output ─────────────────────────────────────────────────────────

export interface GeneratedFile {
  path: string;
  content: string;
  action: "created" | "updated" | "skipped";
  reason?: string;
}

export interface OnboardResult {
  success: boolean;
  repoPath: string;
  generatedFiles: GeneratedFile[];
  installedHooks: string[];
  builtAgents: string[];
  analysis: {
    commitsAnalyzed: number;
    contributors: number;
    primaryLanguage: string;
    frameworks: string[];
    conventions: string[];
    criticalPaths: number;
    prAnalyzed: number;
  };
  warnings: string[];
  errors: string[];
  nextSteps: string[];
}

// ── Health Check ─────────────────────────────────────────────────────────────

export interface DocHealthReport {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  lastUpdated: string;
  commitsSinceUpdate: number;
  issues: Array<{ severity: "error" | "warning" | "info"; message: string }>;
  recommendations: string[];
  fileStatus: Array<{
    path: string;
    exists: boolean;
    stale: boolean;
    lastModified: string;
  }>;
}

export interface ConfidenceGap {
  dimension: string;
  question: string;
  context: string;
  impact: "high" | "medium" | "low";
  currentGuess?: string;
}

export interface ConfidenceScore {
  total: number;
  grade: "A" | "B" | "C" | "D" | "F";
  gaps: ConfidenceGap[];
  breakdown: {
    projectIdentity: { score: number; max: number; details: string[] };
    buildAndRun: { score: number; max: number; details: string[] };
    architecture: { score: number; max: number; details: string[] };
    codePatterns: { score: number; max: number; details: string[] };
    domainContext: { score: number; max: number; details: string[] };
    testing: { score: number; max: number; details: string[] };
  };
}

export interface HumanAnswers {
  projectDescription?: string;
  buildCommands?: string[];
  architectureNotes?: string;
  codePatterns?: string[];
  domainContext?: string[];
  testingNotes?: string;
  domainQA?: Array<{ question: string; answer: string }>;
  answeredAt?: string;
}

export interface SmartQuestion {
  question: string;
  context?: string;
  dimension: string;
  category: "hot-file" | "architecture" | "coupling" | "load-bearing" | "tribal" | "gap";
}

// ── Import Graph ────────────────────────────────────────────────────────────

export interface ImportGraphData {
  /** adjacency[file] = set of files it imports (resolved to repo-relative paths) */
  adjacency: Map<string, Set<string>>;
  /** inDegree[file] = number of files that import this file */
  inDegree: Map<string, number>;
  /** Top files sorted by in-degree (most depended-upon) */
  topByFanIn: Array<{ file: string; fanIn: number }>;
}

// ── Co-change Coupling ──────────────────────────────────────────────────────

export interface CoChangePair {
  fileA: string;
  fileB: string;
  /** Number of commits where both files changed together */
  count: number;
  /** Coupling strength: count / min(freqA, freqB) */
  strength: number;
}

// ── Analysis Snapshot (for incremental updates) ─────────────────────────────

export interface AnalysisSnapshot {
  sha: string;
  analyzedAt: string;
  fileFrequency: Record<string, number>;
  coChangeMatrix: Record<string, Record<string, number>>;
  importGraph: {
    inDegree: Record<string, number>;
    topByFanIn: Array<{ file: string; fanIn: number }>;
  };
  keyTypes: Array<{
    name: string;
    file: string;
    kind: string;
    linesOfCode: number;
    description: string;
  }>;
  criticalPaths: Array<{
    path: string;
    changeCount: number;
    lastChanged: string;
  }>;
}
