#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { RepositoryAnalyzer } from "./analyzers/repository.js";
import { DocumentGenerator } from "./generators/documents.js";
import { HookInstaller } from "./hooks/installer.js";
import { GitHubClient } from "./analyzers/github.js";
import { join, dirname } from "node:path";
import type { OnboardOptions, GeneratedFile, HumanAnswers, ConfidenceScore, ConfidenceGap } from "./types.js";

const program = new Command();

program
  .name("claude-onboard")
  .description(
    "Auto-onboard any repo with self-maintaining Claude Code documentation",
  )
  .version("0.1.0");

// ── Helpers ──

function displayConfidenceScore(
  score: ConfidenceScore,
  c: typeof import("chalk").default,
): void {
  const scoreColor = score.total >= 80 ? c.green : score.total >= 50 ? c.yellow : c.red;
  console.log(
    `\n${c.blue("📊")} Documentation Confidence: ${scoreColor(`${score.total}/100 (${score.grade})`)}`,
  );
  const bd = score.breakdown;
  for (const [label, dim] of [
    ["Project Identity", bd.projectIdentity],
    ["Build & Run", bd.buildAndRun],
    ["Architecture", bd.architecture],
    ["Code Patterns", bd.codePatterns],
    ["Domain Context", bd.domainContext],
    ["Testing", bd.testing],
  ] as const) {
    const check = dim.score >= dim.max ? c.green("✓") : dim.score >= dim.max * 0.5 ? c.yellow("~") : c.red("✗");
    const detail = dim.details.length > 0 ? c.gray(` (${dim.details.join(", ")})`) : "";
    console.log(`   ${label.padEnd(20)} ${String(dim.score).padStart(2)}/${dim.max} ${check}${detail}`);
  }
  console.log("");
}

function loadAnswers(repoPath: string): HumanAnswers | null {
  const answersPath = join(repoPath, ".claude", ".onboard-answers.json");
  if (!existsSync(answersPath)) return null;
  try {
    return JSON.parse(readFileSync(answersPath, "utf-8")) as HumanAnswers;
  } catch {
    return null;
  }
}

function saveAnswers(repoPath: string, answers: HumanAnswers): void {
  const answersPath = join(repoPath, ".claude", ".onboard-answers.json");
  const dir = dirname(answersPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  answers.answeredAt = new Date().toISOString();
  writeFileSync(answersPath, JSON.stringify(answers, null, 2), "utf-8");
}

function hasNewContent(answers: HumanAnswers): boolean {
  return !!(
    answers.projectDescription ||
    answers.buildCommands?.length ||
    answers.architectureNotes ||
    answers.codePatterns?.length ||
    answers.domainContext?.length ||
    answers.testingNotes
  );
}

function computeConfidenceWithAnswers(
  baseScore: ConfidenceScore,
  answers: HumanAnswers,
): ConfidenceScore {
  // Clone the score
  const score: ConfidenceScore = JSON.parse(JSON.stringify(baseScore));

  // Boost dimensions that the human filled
  if (answers.projectDescription) {
    score.breakdown.projectIdentity.score = score.breakdown.projectIdentity.max;
    score.breakdown.projectIdentity.details.push("human-verified");
  }
  if (answers.buildCommands?.length) {
    score.breakdown.buildAndRun.score = score.breakdown.buildAndRun.max;
    score.breakdown.buildAndRun.details.push("human-provided");
  }
  if (answers.architectureNotes) {
    score.breakdown.architecture.score = Math.min(
      score.breakdown.architecture.max,
      score.breakdown.architecture.score + 10,
    );
    score.breakdown.architecture.details.push("human-annotated");
  }
  if (answers.codePatterns?.length) {
    score.breakdown.codePatterns.score = Math.min(
      score.breakdown.codePatterns.max,
      score.breakdown.codePatterns.score + 8,
    );
    score.breakdown.codePatterns.details.push("human-provided");
  }
  if (answers.domainContext?.length) {
    score.breakdown.domainContext.score = Math.min(
      score.breakdown.domainContext.max,
      score.breakdown.domainContext.score + 10,
    );
    score.breakdown.domainContext.details.push("human-provided");
  }
  if (answers.testingNotes) {
    score.breakdown.testing.score = Math.min(
      score.breakdown.testing.max,
      score.breakdown.testing.score + 5,
    );
    score.breakdown.testing.details.push("human-provided");
  }

  // Recalculate total and grade
  score.total = Object.values(score.breakdown).reduce((sum, d) => sum + d.score, 0);
  score.grade = score.total >= 80 ? "A" : score.total >= 65 ? "B" : score.total >= 50 ? "C" : score.total >= 35 ? "D" : "F";

  // Remove gaps that were answered
  score.gaps = score.gaps.filter((g) => {
    if (g.dimension === "Project Identity" && answers.projectDescription) return false;
    if (g.dimension === "Build & Run" && answers.buildCommands?.length) return false;
    if (g.dimension === "Architecture" && answers.architectureNotes) return false;
    if (g.dimension === "Code Patterns" && answers.codePatterns?.length) return false;
    if (g.dimension === "Domain Context" && answers.domainContext?.length) return false;
    if (g.dimension === "Testing" && answers.testingNotes) return false;
    return true;
  });

  return score;
}

/** Prompt the user for ONE round of gap-filling. Returns answers (may be empty if all skipped). */
async function promptForGaps(
  gaps: ConfidenceGap[],
  existing: HumanAnswers,
  c: typeof import("chalk").default,
): Promise<HumanAnswers> {
  const { input } = await import("@inquirer/prompts");
  const answers: HumanAnswers = { ...existing };

  for (const gap of gaps) {
    const impactBadge = gap.impact === "high" ? c.red("[high impact]") : c.yellow("[medium impact]");
    console.log(`\n   ${impactBadge} ${c.bold(gap.dimension)}`);
    console.log(`   ${c.gray(gap.context)}`);
    if (gap.currentGuess) console.log(`   ${c.gray(`Current guess: ${gap.currentGuess}`)}`);

    const answer = await input({ message: gap.question });

    if (!answer.trim()) continue;

    if (gap.dimension === "Project Identity") {
      answers.projectDescription = answer.trim();
    } else if (gap.dimension === "Build & Run") {
      answers.buildCommands = answer.split(";").map((s) => s.trim()).filter(Boolean);
    } else if (gap.dimension === "Architecture") {
      answers.architectureNotes = (answers.architectureNotes ? answers.architectureNotes + "\n" : "") + answer.trim();
    } else if (gap.dimension === "Code Patterns") {
      answers.codePatterns = answer.split(";").map((s) => s.trim()).filter(Boolean);
    } else if (gap.dimension === "Domain Context") {
      answers.domainContext = answer.split(";").map((s) => s.trim()).filter(Boolean);
    } else if (gap.dimension === "Testing") {
      answers.testingNotes = answer.trim();
    }
  }

  return answers;
}

// ── Commands ──

program
  .command("init")
  .description("Full repository onboarding")
  .argument("[path]", "Path to the repository", ".")
  .option("--github-repo <repo>", "GitHub repo (owner/repo)")
  .option("--max-commits <n>", "Max commits to analyze", "500")
  .option("--max-prs <n>", "Max PRs to analyze", "100")
  .option("--force", "Force regenerate all files", false)
  .option("--verbose", "Show verbose output", false)
  .option("--dry-run", "Show what would be generated without writing", false)
  .option("--ci", "CI mode: no spinners, no prompts, JSON output", false)
  .option("--no-interactive", "Skip interactive gap-filling prompts")
  .option("--confidence-threshold <n>", "Target confidence score (0-100)", "80")
  .action(async (path: string, opts: Record<string, unknown>) => {
    const repoPath = resolve(path);
    const ci = Boolean(opts.ci);
    // Interactive is ON by default for TTY, off for CI. --no-interactive disables it.
    const interactive = !ci && opts.interactive !== false && process.stdin.isTTY;
    const threshold = parseInt(opts.confidenceThreshold as string, 10);

    let ora: typeof import("ora") | undefined;
    let chalk: typeof import("chalk") | undefined;
    let spinner: ReturnType<typeof import("ora")["default"]> | undefined;

    if (!ci) {
      ora = await import("ora");
      chalk = await import("chalk");
      spinner = ora.default("Analyzing repository...").start();
    }

    try {
      const options: OnboardOptions = {
        repoPath,
        maxCommits: parseInt(opts.maxCommits as string, 10),
        maxPRs: parseInt(opts.maxPrs as string, 10),
        forceRegenerate: Boolean(opts.force),
        verbose: Boolean(opts.verbose),
      };
      if (opts.githubRepo) options.githubRepo = opts.githubRepo as string;

      // ── Step 1: Analyze ──
      const analyzer = new RepositoryAnalyzer(options);
      const analysis = await analyzer.analyze((step, _pct) => {
        if (spinner) spinner.text = step;
      });

      if (Boolean(opts.dryRun)) {
        spinner?.stop();
        const docGen = new DocumentGenerator(repoPath, analysis);
        const files = await docGen.generateAll(options.forceRegenerate);
        console.log("\nDry run — files that would be generated:\n");
        for (const f of files) {
          console.log(`  ${f.path}`);
        }
        return;
      }

      // ── Step 2: Generate docs (first pass) ──
      let answers = loadAnswers(repoPath) ?? ({} as HumanAnswers);

      if (spinner) spinner.text = "Generating documentation...";
      let docGen = new DocumentGenerator(repoPath, analysis, hasNewContent(answers) ? answers : undefined);
      const files = await docGen.generateAll(options.forceRegenerate);

      if (spinner) spinner.text = "Installing git hooks...";
      const hookInstaller = new HookInstaller(repoPath);
      const hooks = await hookInstaller.installAll();

      spinner?.stop();

      // ── CI mode: JSON output and exit ──
      if (ci) {
        const score = analyzer.computeConfidenceScore(analysis);
        const finalScore = hasNewContent(answers) ? computeConfidenceWithAnswers(score, answers) : score;
        console.log(
          JSON.stringify({
            success: true,
            repoPath,
            files: files.map((f) => ({ path: f.path, action: f.action })),
            hooks,
            confidence: finalScore,
          }),
        );
        return;
      }

      const c = chalk!.default;
      const skills = files.filter((f) => f.path.includes("skills/"));

      // ── Step 3: Display results ──
      console.log(
        `\n${c.green("✅")} claude-onboard complete for: ${c.bold(analysis.repoName)}\n`,
      );

      console.log(`${c.blue("📊")} Analysis`);
      console.log(`   Commits analyzed:  ${analysis.commits.length}`);
      console.log(`   Contributors:      ${analysis.contributors.length}`);
      console.log(`   Primary language:  ${analysis.primaryLanguage}`);
      console.log(
        `   Frameworks:        ${analysis.frameworks.join(", ") || "None"}`,
      );
      console.log(
        `   Conventions:       ${analysis.conventions.map((c) => c.pattern).join(", ") || "None detected"}`,
      );
      console.log("");

      console.log(
        `${c.blue("📁")} Generated (${files.length} files)`,
      );
      for (const f of files.filter((f) => !f.path.includes("skills/"))) {
        const icon =
          f.action === "created"
            ? c.green("✓ created")
            : f.action === "updated"
              ? c.yellow("↻ updated")
              : c.gray("· skipped");
        console.log(`   ${f.path.padEnd(40)} ${icon}`);
      }
      console.log("");

      if (hooks.length > 0) {
        console.log(
          `${c.blue("🪝")} Git Hooks (${hooks.length} installed)`,
        );
        console.log(`   ${hooks.join(", ")}`);
        console.log("");
      }

      if (skills.length > 0) {
        console.log(
          `${c.blue("🧠")} Skills (${skills.length} built)`,
        );
        console.log(
          `   ${skills.map((s) => s.path.split("/").pop()?.replace(".md", "")).join(", ")}`,
        );
        console.log("");
      }

      // ── Step 4: Confidence score + interactive loop ──
      const baseScore = analyzer.computeConfidenceScore(analysis);
      let score = hasNewContent(answers) ? computeConfidenceWithAnswers(baseScore, answers) : baseScore;
      displayConfidenceScore(score, c);

      if (interactive && score.total < threshold && score.gaps.length > 0) {
        const { confirm } = await import("@inquirer/prompts");

        let round = 1;
        const MAX_ROUNDS = 5;

        while (score.total < threshold && score.gaps.length > 0 && round <= MAX_ROUNDS) {
          const actionableGaps = score.gaps.filter((g) => g.impact === "high" || g.impact === "medium");
          if (actionableGaps.length === 0) break;

          if (round === 1) {
            console.log(
              `   ${c.yellow(`Score ${score.total} is below target ${threshold}.`)} Let's fill the gaps.\n`,
            );
            console.log(`   ${c.gray("Press Enter to skip any question you can't answer right now.")}`);
          } else {
            console.log(
              `\n   ${c.yellow(`Round ${round}:`)} Score is ${score.total}/${threshold} — ${actionableGaps.length} gap${actionableGaps.length > 1 ? "s" : ""} remaining.`,
            );
          }

          // Prompt user for this round's gaps
          const newAnswers = await promptForGaps(actionableGaps, answers, c);

          // Check if user provided anything new
          const answeredSomething =
            newAnswers.projectDescription !== answers.projectDescription ||
            newAnswers.buildCommands !== answers.buildCommands ||
            newAnswers.architectureNotes !== answers.architectureNotes ||
            newAnswers.codePatterns !== answers.codePatterns ||
            newAnswers.domainContext !== answers.domainContext ||
            newAnswers.testingNotes !== answers.testingNotes;

          if (!answeredSomething) {
            console.log(`\n   ${c.gray("No new answers provided. Finishing up.")}`);
            break;
          }

          answers = newAnswers;
          saveAnswers(repoPath, answers);

          // Regenerate docs with new answers
          spinner = ora!.default("Regenerating documentation...").start();
          docGen = new DocumentGenerator(repoPath, analysis, answers);
          await docGen.generateAll(true);
          spinner.stop();

          // Recompute score
          score = computeConfidenceWithAnswers(baseScore, answers);
          displayConfidenceScore(score, c);

          if (score.total >= threshold) {
            console.log(`   ${c.green("Target confidence reached!")}\n`);
            break;
          }

          // Ask if user wants to continue
          if (score.gaps.length > 0 && round < MAX_ROUNDS) {
            const keepGoing = await confirm({
              message: `${score.gaps.length} gap${score.gaps.length > 1 ? "s" : ""} remaining. Continue improving?`,
              default: true,
            });
            if (!keepGoing) break;
          }

          round++;
        }
      } else if (!interactive && score.total < threshold && score.gaps.length > 0) {
        console.log(
          `   ${c.yellow(`${score.gaps.length} gap${score.gaps.length > 1 ? "s" : ""} found`)} — re-run without ${c.bold("--no-interactive")} to improve\n`,
        );
      }

      console.log(`${c.blue("🚀")} Next Steps`);
      console.log("   1. Open Claude Code in this directory");
      console.log("   2. Claude now has full context about your codebase");
      console.log("   3. Try: /project:status to verify docs are healthy");
      console.log("   4. Try: /project:ask how does auth work?");
      console.log("");
    } catch (err) {
      spinner?.fail((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("update")
  .description("Incremental documentation update")
  .argument("[path]", "Path to the repository", ".")
  .option("--since <commit>", "Update since this commit SHA")
  .option("--mode <mode>", "Update mode", "manual")
  .action(async (path: string, opts: Record<string, unknown>) => {
    const repoPath = resolve(path);
    try {
      const analyzer = new RepositoryAnalyzer({
        repoPath,
        maxCommits: 500,
        maxPRs: 0,
        forceRegenerate: false,
        verbose: false,
      });

      const analysis = await analyzer.analyze();
      const existingAnswers = loadAnswers(repoPath) ?? undefined;
      const docGen = new DocumentGenerator(repoPath, analysis, existingAnswers);
      const updateOpts: { repoPath: string; sinceCommit?: string; mode: "commit" | "merge" | "rebase" | "manual" } = {
        repoPath,
        mode: (opts.mode as "commit" | "merge" | "rebase" | "manual") ?? "manual",
      };
      if (opts.since) updateOpts.sinceCommit = opts.since as string;
      const files = await docGen.updateIncremental(updateOpts);
      const updated = files.filter((f: GeneratedFile) => f.action !== "skipped");
      console.log(`Updated ${updated.length} files.`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Check documentation health and confidence")
  .argument("[path]", "Path to the repository", ".")
  .action(async (path: string) => {
    const repoPath = resolve(path);
    try {
      const analyzer = new RepositoryAnalyzer({
        repoPath,
        maxCommits: 500,
        maxPRs: 0,
        forceRegenerate: false,
        verbose: false,
      });

      const report = await analyzer.checkDocHealth();
      const chalk = await import("chalk");
      const c = chalk.default;

      console.log(`\n${c.blue("📋")} Doc Health: ${report.grade} (${report.score}/100)\n`);
      console.log(`   Last updated: ${report.lastUpdated}`);
      console.log(`   Commits since update: ${report.commitsSinceUpdate}\n`);

      for (const issue of report.issues) {
        const icon =
          issue.severity === "error"
            ? "❌"
            : issue.severity === "warning"
              ? "⚠️"
              : "ℹ️";
        console.log(`  ${icon} ${issue.message}`);
      }

      if (report.recommendations.length > 0) {
        console.log("\n  Recommendations:");
        for (const rec of report.recommendations) {
          console.log(`    → ${rec}`);
        }
      }

      // Confidence score
      const analysis = await analyzer.analyze();
      const baseScore = analyzer.computeConfidenceScore(analysis);
      const answers = loadAnswers(repoPath);
      const score = answers && hasNewContent(answers) ? computeConfidenceWithAnswers(baseScore, answers) : baseScore;
      displayConfidenceScore(score, c);

      if (score.gaps.length > 0) {
        console.log(`   Run ${c.bold("claude-onboard init")} to fill ${score.gaps.length} gap${score.gaps.length > 1 ? "s" : ""} interactively\n`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("pr")
  .description("Analyze a pull request")
  .argument("<number>", "PR number")
  .argument("[path]", "Path to the repository", ".")
  .option("--github-repo <repo>", "GitHub repo (owner/repo)")
  .action(
    async (
      number: string,
      path: string,
      opts: Record<string, unknown>,
    ) => {
      const repoPath = resolve(path);
      const prNumber = parseInt(number, 10);

      if (!opts.githubRepo) {
        console.error("--github-repo is required for PR analysis");
        process.exit(1);
      }

      try {
        const ghClient = new GitHubClient({
          repo: opts.githubRepo as string,
          cacheDir: join(repoPath, ".claude"),
        });

        const pr = await ghClient.fetchSinglePR(prNumber);
        if (!pr) {
          console.error(
            "Could not fetch PR. Ensure gh CLI is installed (https://cli.github.com) and authenticated (gh auth login).",
          );
          process.exit(1);
        }

        console.log(`\nPR #${pr.number}: ${pr.title}`);
        console.log(`Author: ${pr.author}`);
        console.log(`Files: ${pr.filesChanged.length}`);
        console.log(`+${pr.linesAdded} -${pr.linesRemoved}`);
        console.log(`Tests: ${pr.hasTests ? "Yes" : "No"}`);
        console.log("");
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command("uninstall")
  .description("Remove hooks and generated docs")
  .argument("[path]", "Path to the repository", ".")
  .action(async (path: string) => {
    const repoPath = resolve(path);
    try {
      const hookInstaller = new HookInstaller(repoPath);
      const removed = await hookInstaller.uninstall();
      console.log(`Removed hooks: ${removed.join(", ") || "none"}`);
      console.log("To also remove generated docs, run: rm -rf .claude/");
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parse();
