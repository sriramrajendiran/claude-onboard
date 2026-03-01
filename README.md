# claude-onboard

Auto-onboard any git repo for Claude Code with self-maintaining documentation and interactive confidence scoring.

## What it does

One command analyzes your repository — git history, source code, architecture, conventions — and generates a complete `.claude/` documentation structure. If the plugin isn't confident in what it found, it asks you to fill the gaps. Git hooks keep docs fresh automatically.

```
$ npx claude-onboard init

✅ claude-onboard complete for: my-project

📊 Documentation Confidence: 70/100 (B)
   Project Identity     20/20 ✓ (description from source, package structure, Java)
   Build & Run           9/20 ✗ (build (inferred), test (inferred))
   Architecture          8/20 ✗ (style: microservices, 5 services)
   Code Patterns        12/15 ~ (2 patterns found, 52 key types)
   Domain Context       14/15 ~ (2 team rules, 2 conventions)
   Testing               7/10 ~ (structure: colocated, test command)

   Score 70 is below target 80. Let's fill the gaps.

   [high impact] Build & Run
   Only found 3 commands. Missing: lint.
   ? What are the commands to lint this project? npm run lint

   [medium impact] Architecture
   No layers or entry points detected.
   ? How is the codebase organized? API layer → service → repository → database

✅ Documentation updated with your answers.

📊 Documentation Confidence: 91/100 (A)
   ...
```

## Prerequisites

- Node.js 18+
- git
- gh CLI (optional, for PR analysis): https://cli.github.com

## Quick Start

```bash
# Checkout any repo and run:
npx claude-onboard init

# That's it. Claude Code now has full context about the codebase.
```

## Installation

### npx (zero-install)

```bash
npx claude-onboard init /path/to/repo
```

### Global install

```bash
npm install -g claude-onboard
claude-onboard init
```

### As a dev dependency

```bash
npm install -D claude-onboard
npx claude-onboard init
```

### Claude Code MCP config

Add to `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-onboard": {
      "command": "npx",
      "args": ["claude-onboard"]
    }
  }
}
```

## How Confidence Scoring Works

The plugin scores its own confidence (0-100) across 6 dimensions:

| Dimension | Max | What it measures |
|-----------|-----|-----------------|
| **Project Identity** | 20 | Did we find a real description, or guess from the repo name? |
| **Build & Run** | 20 | Are commands from explicit scripts, or inferred from tool presence? |
| **Architecture** | 20 | Did we detect style + layers + entry points, or fall back to guesses? |
| **Code Patterns** | 15 | Did we find real idioms, or nothing? |
| **Domain Context** | 15 | Did we find team rules/conventions, or just git-inferred data? |
| **Testing** | 10 | Do we know the test framework, structure, and commands? |

When confidence is below the threshold (default 80), the plugin **automatically prompts** you to fill gaps. Your answers are:

- Saved to `.claude/.onboard-answers.json`
- Injected into the generated CLAUDE.md
- Preserved across regenerations and updates
- Used to re-score confidence after each round

The loop continues until the target score is reached, you skip all questions, or 5 rounds complete.

## Generated File Structure

```
.claude/
├── CLAUDE.md                    # Main context file (everything Claude needs)
├── .onboarder-meta.json         # Generation metadata
├── .onboard-answers.json        # Human answers (persisted)
├── commands/
│   ├── onboard.md               # /project:onboard
│   ├── status.md                # /project:status
│   ├── update-docs.md           # /project:update-docs
│   ├── pr-review.md             # /project:pr-review
│   └── ask.md                   # /project:ask
├── skills/
│   ├── debugging.md
│   ├── testing.md
│   ├── pr-workflow.md
│   ├── code-review.md
│   ├── refactoring.md
│   ├── documentation.md
│   └── [framework].md           # Per detected framework
└── hooks/
    └── update-docs.sh           # Auto-update runner

src/components/CLAUDE.md         # Folder-level context (auto-generated for hot directories)
src/api/CLAUDE.md
```

## Self-Maintenance

Git hooks keep docs fresh automatically:

```
commit → post-commit hook → update-docs.sh → docs refresh (background)
merge  → post-merge hook  → docs refresh (synchronous)
rebase → post-rewrite hook → docs refresh
```

Updates are throttled (max once per 5 minutes) and fail silently — they never block git operations. Human answers persist across updates.

## CLI Reference

```bash
# Full onboard (interactive by default in terminal)
claude-onboard init [path] [options]

Options:
  --github-repo <owner/repo>     GitHub repo for PR analysis
  --max-commits <n>              Max commits to analyze (default: 500)
  --max-prs <n>                  Max PRs to analyze (default: 100)
  --confidence-threshold <n>     Target confidence score (default: 80)
  --no-interactive               Skip interactive gap-filling
  --force                        Force regenerate all files
  --dry-run                      Preview without writing
  --ci                           CI mode: JSON output, no prompts

# Incremental update (preserves human answers)
claude-onboard update [path] [--since <sha>] [--mode commit|merge|rebase|manual]

# Health check + confidence score
claude-onboard status [path]

# Analyze a PR
claude-onboard pr <number> [path] --github-repo owner/repo

# Remove hooks
claude-onboard uninstall [path]
```

### Examples

```bash
# Basic usage — clone a repo and onboard
git clone https://github.com/org/project.git
cd project
npx claude-onboard init

# Set a higher confidence bar
npx claude-onboard init --confidence-threshold 90

# CI pipeline — no prompts, JSON output
npx claude-onboard init --ci

# Skip interactive prompts
npx claude-onboard init --no-interactive

# Check if docs are stale
npx claude-onboard status

# Update after many commits
npx claude-onboard update
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `onboard` | Full repository analysis and doc generation |
| `update_docs` | Incremental update based on recent changes |
| `analyze_pr` | Analyze a specific PR and update docs |
| `check_doc_health` | Check documentation freshness and completeness |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/project:onboard` | Get oriented with the codebase |
| `/project:status` | Check doc health and confidence |
| `/project:update-docs` | Update docs for recent changes |
| `/project:pr-review` | Review a PR with project context |
| `/project:ask` | Ask questions about the repo |

## Supported Ecosystems

| Language | Frameworks | Build Tools | ORMs |
|----------|-----------|-------------|------|
| Java | Spring Boot | Maven, Gradle | Hibernate |
| TypeScript/JS | Next.js, React, Vue, Angular, Express, NestJS | npm, yarn, pnpm, Vite, Webpack | Prisma, TypeORM, Drizzle |
| Python | Django, FastAPI, Flask | pip, poetry | SQLAlchemy |
| Go | Gin, Fiber | go build | GORM |
| Rust | Actix, Axum | Cargo | Diesel |
| Ruby | Rails | Bundler | ActiveRecord |
| PHP | Laravel | Composer | Eloquent |

## Uninstalling

```bash
npx claude-onboard uninstall
# To also remove generated docs:
rm -rf .claude/
```

## License

MIT
