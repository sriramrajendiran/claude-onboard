---
name: pr-review
description: Review a pull request with project context
---

Review the current PR (or the PR number provided as $ARGUMENTS) using the project's conventions:

1. Read `.claude/CLAUDE.md` for project context, code patterns, and conventions.
2. Get the PR diff with `gh pr diff $ARGUMENTS` (or `git diff` if on a feature branch).
3. Review the changes against:
   - Code patterns listed in CLAUDE.md (DI style, error handling, test conventions)
   - Architecture rules (correct layer placement, dependency direction)
   - Hot files (are high-risk files being changed?)
4. Check if tests are included for new functionality.
5. Provide a structured review with: summary, concerns, suggestions, and approval recommendation.
