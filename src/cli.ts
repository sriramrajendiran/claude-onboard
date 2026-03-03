#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { RepositoryAnalyzer } from "./analyzers/repository.js";
import { DocumentGenerator } from "./generators/documents.js";
import { HookInstaller } from "./hooks/installer.js";
import { GitHubClient } from "./analyzers/github.js";
import { join, dirname } from "node:path";
import { AnalysisTier } from "./types.js";
import type { OnboardOptions, UpdateOptions, GeneratedFile, HumanAnswers, ConfidenceScore, SmartQuestion } from "./types.js";

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
    answers.testingNotes ||
    answers.domainQA?.length
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
  if (answers.domainQA?.length) {
    const boost = Math.min(10, answers.domainQA.length * 3);
    score.breakdown.domainContext.score = Math.min(
      score.breakdown.domainContext.max,
      score.breakdown.domainContext.score + boost,
    );
    score.breakdown.domainContext.details.push(`${answers.domainQA.length} Q&A`);
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

/** Prompt the user with all questions in a batch editor. Returns answers. */
async function promptForGaps(
  questions: SmartQuestion[],
  existing: HumanAnswers,
  c: typeof import("chalk").default,
): Promise<HumanAnswers> {
  const { editor } = await import("@inquirer/prompts");
  const answers: HumanAnswers = { ...existing };

  // Show preview of questions
  console.log(`\n   ${c.blue("📋")} ${c.bold(`${questions.length} questions about your codebase`)} (opens in $EDITOR):\n`);
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const badge = q.category === "gap"
      ? c.yellow(`[${q.dimension}]`)
      : c.cyan(`[${q.category}]`);
    console.log(`   ${c.gray(`${i + 1}.`)} ${badge} ${q.question}`);
  }
  console.log(`\n   ${c.gray("Leave any answer blank to skip. Save and close the editor when done.")}\n`);

  // Build editor template
  let template = "# Onboarding Questions — answer below each question (leave blank to skip)\n\n";
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    template += `## ${i + 1}. ${q.question}\n`;
    if (q.context) template += `> ${q.context}\n`;
    template += "\n\n\n";
  }

  const result = await editor({
    message: "Answer onboarding questions (save & close when done)",
    default: template,
    postfix: ".md",
  });

  // Parse answers from ## N. headers
  const sections = result.split(/^## \d+\./m).slice(1); // skip preamble
  for (let i = 0; i < Math.min(sections.length, questions.length); i++) {
    const q = questions[i]!;
    const section = sections[i]!;
    // First line is the question text, then > context lines, then blank, then user's answer
    const lines = section.split("\n");
    const answerLines: string[] = [];
    let inHeader = true;
    for (const line of lines) {
      if (inHeader) {
        // Skip question text line, > context lines, and blanks before answer
        if (line.startsWith(">") || line.trim() === "") continue;
        // First non-empty non-> line: check if it looks like the question (contains ?)
        if (line.includes("?") && answerLines.length === 0) continue;
        inHeader = false;
      }
      answerLines.push(line);
    }
    const answer = answerLines.join("\n").trim();
    if (!answer) continue;

    // Route answer to the right field
    if (q.category === "gap") {
      if (q.dimension === "Project Identity") {
        answers.projectDescription = answer;
      } else if (q.dimension === "Build & Run") {
        answers.buildCommands = answer.split(";").map((s) => s.trim()).filter(Boolean);
      } else if (q.dimension === "Architecture") {
        answers.architectureNotes = (answers.architectureNotes ? answers.architectureNotes + "\n" : "") + answer;
      } else if (q.dimension === "Code Patterns") {
        answers.codePatterns = answer.split(";").map((s) => s.trim()).filter(Boolean);
      } else if (q.dimension === "Domain Context") {
        answers.domainContext = answer.split(";").map((s) => s.trim()).filter(Boolean);
      } else if (q.dimension === "Testing") {
        answers.testingNotes = answer;
      }
    } else {
      // Domain Q&A — store in domainQA array
      if (!answers.domainQA) answers.domainQA = [];
      answers.domainQA.push({ question: q.question, answer });
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
        tier: AnalysisTier.Two,
      };
      if (opts.githubRepo) options.githubRepo = opts.githubRepo as string;

      // ── Step 1: Analyze ──
      const analyzer = new RepositoryAnalyzer(options);
      const analysis = await analyzer.analyze((step, _pct) => {
        if (spinner) spinner.text = step;
      });

      if (opts.dryRun) {
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
      const agents = files.filter((f) => f.path.includes("agents/"));

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
      for (const f of files.filter((f) => !f.path.includes("agents/"))) {
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

      if (agents.length > 0) {
        console.log(
          `${c.blue("🤖")} Agents (${agents.length} built)`,
        );
        console.log(
          `   ${agents.map((a) => a.path.split("/").pop()?.replace(".md", "")).join(", ")}`,
        );
        console.log("");
      }

      // ── Step 4: Confidence score + interactive loop ──
      const baseScore = analyzer.computeConfidenceScore(analysis);
      let score = hasNewContent(answers) ? computeConfidenceWithAnswers(baseScore, answers) : baseScore;
      displayConfidenceScore(score, c);

      if (interactive && score.total < threshold) {
        const { confirm } = await import("@inquirer/prompts");

        let round = 1;
        const MAX_ROUNDS = 5;

        while (score.total < threshold && round <= MAX_ROUNDS) {
          // Generate smart questions based on current gaps (re-evaluated each round)
          const smartQuestions = analyzer.generateSmartQuestions(analysis, score.gaps, answers);
          if (smartQuestions.length === 0) break;

          if (round === 1) {
            console.log(
              `   ${c.yellow(`Score ${score.total} is below target ${threshold}.`)} Let's fill the gaps.\n`,
            );
          } else {
            console.log(
              `\n   ${c.yellow(`Round ${round}:`)} Score is ${score.total}/${threshold} — ${smartQuestions.length} question${smartQuestions.length > 1 ? "s" : ""} remaining.`,
            );
          }

          const newAnswers = await promptForGaps(smartQuestions, answers, c);

          // Check if user provided anything new
          const answeredSomething =
            newAnswers.projectDescription !== answers.projectDescription ||
            newAnswers.buildCommands !== answers.buildCommands ||
            newAnswers.architectureNotes !== answers.architectureNotes ||
            newAnswers.codePatterns !== answers.codePatterns ||
            newAnswers.domainContext !== answers.domainContext ||
            newAnswers.testingNotes !== answers.testingNotes ||
            (newAnswers.domainQA?.length ?? 0) > (answers.domainQA?.length ?? 0);

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
          if (round < MAX_ROUNDS) {
            const keepGoing = await confirm({
              message: `Score is ${score.total}/${threshold}. Continue improving?`,
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

      console.log(`   ${c.blue("💡")} For deeper context extraction, spawn the context-maintainer agent in Claude Code\n`);

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
  .option("--interactive", "Run confidence scoring loop and ask smart questions")
  .option("--confidence-threshold <n>", "Target confidence score (0-100)", "80")
  .action(async (path: string, opts: Record<string, unknown>) => {
    const repoPath = resolve(path);
    try {
      const analyzer = new RepositoryAnalyzer({
        repoPath,
        maxCommits: 500,
        maxPRs: 0,
        forceRegenerate: false,
        verbose: false,
        tier: AnalysisTier.Two,
      });

      // Try incremental first (uses snapshot + delta since last SHA)
      const updateOpts: UpdateOptions = {
        repoPath,
        mode: (opts.mode as "commit" | "merge" | "rebase" | "manual") ?? "manual",
      };
      if (opts.since) updateOpts.sinceCommit = opts.since as string;

      const result = await analyzer.analyzeIncremental(updateOpts);

      if (!result) {
        console.log("No changes since last analysis. Documentation is up to date.");
        return;
      }

      if (result.incremental) {
        console.log("Incremental update: merged delta into snapshot.");
      } else {
        console.log("No snapshot found — ran full analysis.");
      }

      let answers = loadAnswers(repoPath) ?? ({} as HumanAnswers);
      const interactive = Boolean(opts.interactive);
      const threshold = Number(opts.confidenceThreshold) || 80;

      // Count churn for display
      const changedFiles = new Set<string>();
      for (const commit of result.analysis.commits) {
        for (const f of commit.filesChanged) changedFiles.add(f);
      }

      // Always regenerate docs first
      let docGen = new DocumentGenerator(repoPath, result.analysis, answers);
      const files = await docGen.updateIncremental(updateOpts);
      const updated = files.filter((f: GeneratedFile) => f.action !== "skipped");
      console.log(`Updated ${updated.length} files.`);

      if (interactive) {
        const chalk = await import("chalk");
        const c = chalk.default;
        const ora = await import("ora");
        const { confirm } = await import("@inquirer/prompts");

        if (changedFiles.size > 0) {
          console.log(`\n   ${c.blue(`${changedFiles.size} files changed`)} since last update.`);
        }

        // Compute confidence and run the scoring loop (same as init)
        const baseScore = analyzer.computeConfidenceScore(result.analysis);
        let score = hasNewContent(answers) ? computeConfidenceWithAnswers(baseScore, answers) : baseScore;
        displayConfidenceScore(score, c);

        let round = 1;
        const MAX_ROUNDS = 5;

        while (score.total < threshold && round <= MAX_ROUNDS) {
          const smartQuestions = analyzer.generateSmartQuestions(result.analysis, score.gaps, answers);
          if (smartQuestions.length === 0) break;

          if (round === 1) {
            console.log(
              `   ${c.yellow(`Score ${score.total} is below target ${threshold}.`)} Let's fill the gaps.\n`,
            );
          } else {
            console.log(
              `\n   ${c.yellow(`Round ${round}:`)} Score is ${score.total}/${threshold} — ${smartQuestions.length} question${smartQuestions.length > 1 ? "s" : ""} remaining.`,
            );
          }

          const newAnswers = await promptForGaps(smartQuestions, answers, c);

          const answeredSomething =
            newAnswers.projectDescription !== answers.projectDescription ||
            newAnswers.buildCommands !== answers.buildCommands ||
            newAnswers.architectureNotes !== answers.architectureNotes ||
            newAnswers.codePatterns !== answers.codePatterns ||
            newAnswers.domainContext !== answers.domainContext ||
            newAnswers.testingNotes !== answers.testingNotes ||
            (newAnswers.domainQA?.length ?? 0) > (answers.domainQA?.length ?? 0);

          if (!answeredSomething) {
            console.log(`\n   ${c.gray("No new answers provided. Finishing up.")}`);
            break;
          }

          answers = newAnswers;
          saveAnswers(repoPath, answers);

          // Regenerate docs with new answers
          const spinner = ora.default("Regenerating documentation...").start();
          docGen = new DocumentGenerator(repoPath, result.analysis, answers);
          await docGen.generateAll(true);
          spinner.stop();

          // Recompute score
          score = computeConfidenceWithAnswers(baseScore, answers);
          displayConfidenceScore(score, c);

          if (score.total >= threshold) {
            console.log(`   ${c.green("Target confidence reached!")}\n`);
            break;
          }

          if (round < MAX_ROUNDS) {
            const keepGoing = await confirm({
              message: `Score is ${score.total}/${threshold}. Continue improving?`,
              default: true,
            });
            if (!keepGoing) break;
          }

          round++;
        }

        if (score.total >= threshold && round === 1) {
          console.log(`   ${c.green("Confidence is already at target.")} No questions needed.\n`);
        }

        console.log(`   ${c.blue("💡")} For deeper context extraction, spawn the context-maintainer agent in Claude Code\n`);
      } else if (changedFiles.size >= 15) {
        console.log(
          `${changedFiles.size} files changed — run with --interactive to answer context questions.`,
        );
      }
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
  .command("questions")
  .description("Output confidence score and smart questions as JSON (for agent consumption)")
  .argument("[path]", "Path to the repository", ".")
  .option("--confidence-threshold <n>", "Target confidence score (0-100)", "80")
  .action(async (path: string, opts: Record<string, unknown>) => {
    const repoPath = resolve(path);
    try {
      const analyzer = new RepositoryAnalyzer({
        repoPath,
        maxCommits: 500,
        maxPRs: 0,
        forceRegenerate: false,
        verbose: false,
        tier: AnalysisTier.Two,
      });

      const analysis = await analyzer.analyze();
      const answers = loadAnswers(repoPath) ?? undefined;
      const baseScore = analyzer.computeConfidenceScore(analysis);
      const score = answers && hasNewContent(answers) ? computeConfidenceWithAnswers(baseScore, answers) : baseScore;
      const threshold = Number(opts.confidenceThreshold) || 80;
      const smartQuestions = analyzer.generateSmartQuestions(analysis, score.gaps, answers);

      const output = {
        score: score.total,
        grade: score.grade,
        threshold,
        belowThreshold: score.total < threshold,
        breakdown: Object.fromEntries(
          Object.entries(score.breakdown).map(([k, v]) => [k, { score: v.score, max: v.max }]),
        ),
        questions: smartQuestions.map((q) => ({
          question: q.question,
          context: q.context,
          category: q.category,
          dimension: q.dimension,
        })),
        answersFile: join(repoPath, ".claude", ".onboard-answers.json"),
      };

      console.log(JSON.stringify(output, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ error: (err as Error).message }));
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
