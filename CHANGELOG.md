# Changelog

## 0.1.0 (2025-03-01)

Initial release.

### Features

- **One-command onboarding**: `npx claude-onboard init` analyzes any git repo and generates Claude Code context
- **Documentation confidence scoring**: 0-100 score measuring how confident the plugin is in its generated docs
- **Interactive gap-filling**: Automatically prompts developers to fill knowledge gaps, loops until confidence target is met
- **Progressive context disclosure**: Main `.claude/CLAUDE.md` + folder-level `CLAUDE.md` files for area-specific context
- **Self-maintaining docs**: Git hooks (post-commit, post-merge, post-rewrite) keep documentation fresh
- **Source analysis**: Detects key types, modules, code patterns, build commands, dependencies, and architecture
- **Multi-language support**: Java/Spring Boot, TypeScript/Node.js, Python, Go, Rust, Ruby, PHP
- **Multi-module support**: Maven multi-module projects, monorepos, microservices with docker-compose
- **Skills generation**: Auto-generates debugging, testing, PR workflow, code review, refactoring, and documentation skills
- **Slash commands**: `/project:onboard`, `/project:status`, `/project:ask`, `/project:pr-review`, `/project:update-docs`
- **MCP server**: Exposes tools for Claude Code integration
- **CI mode**: `--ci` flag for JSON output in pipelines
- **Human answers persistence**: Developer answers saved to `.claude/.onboard-answers.json`, survive regenerations
