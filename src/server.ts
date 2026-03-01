import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RepositoryAnalyzer } from "./analyzers/repository.js";
import { DocumentGenerator } from "./generators/documents.js";
import { HookInstaller } from "./hooks/installer.js";
import { GitHubClient } from "./analyzers/github.js";
import { join } from "node:path";
import type { OnboardResult } from "./types.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "claude-onboard",
    version: "0.1.0",
  });

  server.tool(
    "onboard",
    "Analyze a git repository and generate comprehensive Claude Code documentation",
    {
      repo_path: z.string().min(1).describe("Path to the git repository"),
      github_repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .optional()
        .describe("GitHub repo in owner/repo format (optional)"),
      max_commits: z
        .number()
        .int()
        .min(10)
        .max(5000)
        .default(500)
        .describe("Maximum commits to analyze"),
      max_prs: z
        .number()
        .int()
        .min(0)
        .max(500)
        .default(100)
        .describe("Maximum PRs to analyze"),
      force_regenerate: z
        .boolean()
        .default(false)
        .describe("Force regenerate all files"),
    },
    async ({ repo_path, github_repo, max_commits, max_prs, force_regenerate }) => {
      try {
        const opts: import("./types.js").OnboardOptions = {
          repoPath: repo_path,
          maxCommits: max_commits,
          maxPRs: max_prs,
          forceRegenerate: force_regenerate,
          verbose: false,
        };
        if (github_repo) opts.githubRepo = github_repo;
        const analyzer = new RepositoryAnalyzer(opts);

        const analysis = await analyzer.analyze();

        const docGen = new DocumentGenerator(repo_path, analysis);
        const files = await docGen.generateAll(force_regenerate);

        const hookInstaller = new HookInstaller(repo_path);
        const hooks = await hookInstaller.installAll();

        const result: OnboardResult = {
          success: true,
          repoPath: repo_path,
          generatedFiles: files,
          installedHooks: hooks,
          builtSkills: files
            .filter((f) => f.path.includes("skills/"))
            .map((f) => f.path),
          analysis: {
            commitsAnalyzed: analysis.commits.length,
            contributors: analysis.contributors.length,
            primaryLanguage: analysis.primaryLanguage,
            frameworks: analysis.frameworks,
            conventions: analysis.conventions.map((c) => c.pattern),
            criticalPaths: analysis.criticalPaths.length,
            prAnalyzed: analysis.prInsights.length,
          },
          warnings: [],
          errors: [],
          nextSteps: [
            "Open Claude Code in this directory",
            "Claude now has full context about your codebase",
            "Try: /project:status to verify docs are healthy",
            "Try: /project:ask how does auth work?",
          ],
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "update_docs",
    "Incrementally update documentation based on recent changes",
    {
      repo_path: z.string().min(1).describe("Path to the git repository"),
      since_commit: z
        .string()
        .length(40)
        .optional()
        .describe("Commit SHA to start from"),
      changed_files: z
        .array(z.string())
        .optional()
        .describe("List of changed files"),
      mode: z
        .enum(["commit", "merge", "rebase", "manual"])
        .default("manual")
        .describe("Update trigger mode"),
    },
    async ({ repo_path, since_commit, changed_files, mode }) => {
      try {
        const analyzer = new RepositoryAnalyzer({
          repoPath: repo_path,
          maxCommits: 500,
          maxPRs: 0,
          forceRegenerate: false,
          verbose: false,
        });

        const analysis = await analyzer.analyze();
        const docGen = new DocumentGenerator(repo_path, analysis);
        const updateOpts = { repoPath: repo_path, mode } as {
          repoPath: string;
          sinceCommit?: string;
          changedFiles?: string[];
          mode: "commit" | "merge" | "rebase" | "manual";
        };
        if (since_commit) updateOpts.sinceCommit = since_commit;
        if (changed_files) updateOpts.changedFiles = changed_files;

        const files = await docGen.updateIncremental(updateOpts);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  updatedFiles: files.filter((f) => f.action !== "skipped")
                    .length,
                  files: files.map((f) => ({
                    path: f.path,
                    action: f.action,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "analyze_pr",
    "Analyze a pull request and update documentation",
    {
      repo_path: z.string().min(1).describe("Path to the git repository"),
      pr_number: z.number().int().positive().describe("PR number"),
      github_repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .describe("GitHub repo in owner/repo format"),
    },
    async ({ repo_path, pr_number, github_repo }) => {
      try {
        const ghClient = new GitHubClient({
          repo: github_repo,
          cacheDir: join(repo_path, ".claude"),
        });

        const pr = await ghClient.fetchSinglePR(pr_number);
        if (!pr) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Could not fetch PR. Ensure gh CLI is installed (https://cli.github.com) and authenticated (gh auth login).",
              },
            ],
            isError: true,
          };
        }

        const analyzer = new RepositoryAnalyzer({
          repoPath: repo_path,
          githubRepo: github_repo,
          maxCommits: 100,
          maxPRs: 0,
          forceRegenerate: false,
          verbose: false,
        });

        const analysis = await analyzer.analyze();
        const docGen = new DocumentGenerator(repo_path, analysis);
        const files = await docGen.updateFromPR(pr);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  pr: {
                    number: pr.number,
                    title: pr.title,
                    author: pr.author,
                    filesChanged: pr.filesChanged.length,
                    hasTests: pr.hasTests,
                  },
                  updatedFiles: files.filter((f) => f.action !== "skipped")
                    .length,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "check_doc_health",
    "Check the health of generated documentation",
    {
      repo_path: z.string().min(1).describe("Path to the git repository"),
    },
    async ({ repo_path }) => {
      try {
        const analyzer = new RepositoryAnalyzer({
          repoPath: repo_path,
          maxCommits: 500,
          maxPRs: 0,
          forceRegenerate: false,
          verbose: false,
        });

        const report = await analyzer.checkDocHealth();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
