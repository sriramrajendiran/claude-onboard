# claude-onboard

Auto-onboard any git repo for Claude Code with self-maintaining context, autonomous agents, and confidence scoring.

## What it does

One command analyzes your repository — git history, source code, architecture, conventions — and generates a complete `.claude/` structure including repo-specific autonomous agents. The **context-maintainer agent** then acts like a senior developer onboarding the repo — extracting context from code, git history, and developer knowledge, asking targeted questions about gaps, and populating it into the right files until confidence is high. Git hooks keep docs fresh automatically.

```
$ npx claude-onboard init

✅ claude-onboard complete for: my-project

📊 Analysis
   Commits analyzed:  500
   Primary language:  Java
   Frameworks:        Spring Boot

🤖 Agents (4 built)
   reviewer, test-writer, context-maintainer, security-auditor

📊 Documentation Confidence: 91/100 (A)
   Project Identity     20/20 ✓
   Build & Run          18/20 ✓
   Architecture         16/20 ~
   Code Patterns        15/15 ✓
   Domain Context       14/15 ~
   Testing              8/10  ~

   💡 For deeper context extraction, spawn the context-maintainer agent in Claude Code
```

## Prerequisites

- Node.js 18+
- git
- gh CLI (optional, for PR analysis): https://cli.github.com

## Quick Start

```bash
# Install and generate baseline docs
npm i -D claude-onboard
npx claude-onboard init

# Then in Claude Code, run /project:update-context to spawn the context-maintainer agent
# for deep quality scoring, targeted questions, and doc improvements
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

## Three-Layer Architecture

claude-onboard generates three complementary layers:

### Agents (`.claude/agents/`)

Autonomous specialists that Claude spawns for delegated work. Each agent carries repo-specific knowledge and has framework-aware instructions.

| Agent | When generated | What it does |
|-------|---------------|-------------|
| **reviewer** | Always | Reviews code against repo conventions, validates co-change pairs, checks blast radius on load-bearing modules |
| **test-writer** | Test framework detected | Generates tests matching the repo's exact framework, structure, and naming patterns |
| **context-maintainer** | Always | Senior-developer onboarding agent. Extracts context from code, git history, and developer knowledge. Verifies and enriches folder-level CLAUDE.md files. Owns the quality scoring loop |
| **security-auditor** | Always | Framework-specific vulnerability scanning (Spring: SpEL/HQL injection, actuator exposure; Express: prototype pollution; etc.) |

Agent frontmatter includes `model`, `permissionMode`, `maxTurns`, `memory`, and `isolation` for precise control. CLAUDE.md tells Claude when to spawn each agent.

### Commands (`.claude/commands/`)

User-invoked interactive workflows accessible via slash commands:

| Command | Description |
|---------|-------------|
| `/project:onboard` | Get oriented — or run first-time setup if not yet onboarded |
| `/project:status` | Check doc health and confidence |
| `/project:update-context` | Update context and spawn context-maintainer for deep extraction |
| `/project:pr-review` | Review a PR with project context |
| `/project:ask` | Ask questions about the repo |

### Context (`.claude/context/` + `CLAUDE.md`)

Shared knowledge base that agents, commands, and Claude conversations all reference:

- `CLAUDE.md` — project identity, commands, architecture, conventions, key types, critical paths, agents
- `context/architecture.md` — detailed architecture breakdown
- `context/patterns.md` — code patterns, conventions, team rules
- `context/hotfiles.md` — critical paths, co-change pairs, load-bearing modules

## Generated File Structure

```
.claude/
├── CLAUDE.md                    # Main context file (everything Claude needs)
├── .onboarder-meta.json         # Generation metadata
├── .onboard-answers.json        # Human answers (persisted)
├── .onboard-score.json          # Doc quality score (written by context-maintainer agent)
├── agents/
│   ├── reviewer.md              # Code review with co-change validation
│   ├── test-writer.md           # Test generation (if test framework detected)
│   ├── context-maintainer.md    # Context extraction and quality scoring
│   └── security-auditor.md      # Framework-specific security auditing
├── commands/
│   ├── onboard.md               # /project:onboard
│   ├── status.md                # /project:status
│   ├── update-context.md        # /project:update-context
│   ├── pr-review.md             # /project:pr-review
│   └── ask.md                   # /project:ask
├── context/
│   ├── architecture.md          # Architecture deep-dive
│   ├── patterns.md              # Code patterns and conventions
│   └── hotfiles.md              # Critical paths and coupling data
└── hooks/
    └── update-context.sh       # Auto-update runner

src/components/CLAUDE.md         # Folder-level context (auto-generated for hot directories)
src/api/CLAUDE.md
```

## How Quality Scoring Works

Documentation quality is evaluated at two levels:

### CLI Heuristic Score (fast, no LLM)

The CLI scores confidence (0-100) across 6 dimensions during `init` and `update`:

| Dimension | Max | What it measures |
|-----------|-----|-----------------|
| **Project Identity** | 20 | Did we find a real description, or guess from the repo name? |
| **Build & Run** | 20 | Are commands from explicit scripts, or inferred from tool presence? |
| **Architecture** | 20 | Did we detect style + layers + entry points, or fall back to guesses? |
| **Code Patterns** | 15 | Did we find real idioms, or nothing? |
| **Domain Context** | 15 | Did we find team rules/conventions, or just git-inferred data? |
| **Testing** | 10 | Do we know the test framework, structure, and commands? |

When confidence is below the threshold (default 80), the CLI **prompts** you to fill gaps via `$EDITOR`. Your answers are saved to `.claude/.onboard-answers.json` and preserved across updates.

### Context-Maintainer Agent Score (deep, reads actual docs + code)

The context-maintainer agent provides the **authoritative** quality score. It:

1. Reads the generated documentation
2. Cross-references against actual source code
3. Scores across 8 dimensions (project identity, build & run, architecture, key types, conventions, framework decisions, domain context, staleness)
4. Asks targeted questions based on real gaps found (not heuristic gaps)
5. Updates docs with answers
6. Re-evaluates until score ≥ 80 or 5 rounds complete
7. Writes the score to `.claude/.onboard-score.json`

Spawn it via `/project:update-context` in Claude Code.

## Self-Maintenance

Git hooks keep docs fresh automatically:

```
commit → post-commit hook → update-context.sh → docs refresh (background)
merge  → post-merge hook  → docs refresh (synchronous)
rebase → post-rewrite hook → docs refresh
```

Updates are throttled (max once per 5 minutes) and fail silently — they never block git operations. Human answers persist across updates. When 15+ files change, the hook warns you to run the context-maintainer agent for deeper review.

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
claude-onboard update --interactive  # Run confidence scoring loop

# Output score and questions as JSON (for agent consumption)
claude-onboard questions [path] [--confidence-threshold <n>]

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

# Generate baseline docs, then use agent for quality scoring
npx claude-onboard init --no-interactive
# In Claude Code: /project:update-context

# Check if docs are stale
npx claude-onboard status

# Update after many commits
npx claude-onboard update
```

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

Framework-specific questions are asked during onboarding (e.g., "App Router or Pages Router?" for Next.js). Security auditor generates framework-specific vulnerability checks.

## Uninstalling

```bash
npx claude-onboard uninstall
# To also remove generated docs:
rm -rf .claude/
```

## License

MIT
