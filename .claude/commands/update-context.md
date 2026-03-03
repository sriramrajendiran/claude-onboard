---
name: update-context
description: Update context based on recent changes
---

Update the onboarding context to reflect recent changes:

1. Read `.claude/.onboarder-meta.json` to find the last update timestamp.
2. Run `git log --oneline` since that date to see what changed.
3. Read `.claude/CLAUDE.md`.
4. Based on the recent commits, update any sections that are now outdated:
   - New modules or key files added
   - Changed architecture or dependencies
   - New conventions emerging from recent commits
5. Preserve any manual edits outside the `<!-- onboarder:auto-start -->` / `<!-- onboarder:auto-end -->` markers.
6. Alternatively, run `npx claude-onboard update` to regenerate automatically.
