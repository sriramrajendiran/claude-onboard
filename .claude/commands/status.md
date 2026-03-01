---
name: status
description: Check documentation health
---

Check the health of the onboarding documentation in this repo:

1. Verify `.claude/CLAUDE.md` exists and read it.
2. Read `.claude/.onboarder-meta.json` to check when docs were last generated.
3. Run `git log --oneline --since` from that date to count commits since last update.
4. If more than 20 commits have landed since the last update, recommend running `npx claude-onboard update`.
5. Report whether docs appear stale.
