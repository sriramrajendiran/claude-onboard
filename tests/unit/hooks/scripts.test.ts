import { describe, it, expect } from "vitest";
import {
  renderPostCommitHook,
  renderPostMergeHook,
  renderPostRewriteHook,
  renderPrepareCommitMsgHook,
  renderUpdateContextScript,
  renderUninstallScript,
  MARKER_START,
  MARKER_END,
} from "../../../src/hooks/scripts.js";

describe("Hook Scripts", () => {
  it("post-commit hook contains markers", () => {
    const script = renderPostCommitHook();
    expect(script).toContain(MARKER_START);
    expect(script).toContain(MARKER_END);
  });

  it("post-commit runs in background", () => {
    const script = renderPostCommitHook();
    expect(script).toContain("&");
  });

  it("post-merge runs synchronously", () => {
    const script = renderPostMergeHook();
    expect(script).not.toMatch(/&\s*$/m);
    expect(script).toContain("update-context.sh");
  });

  it("post-rewrite hook exists", () => {
    const script = renderPostRewriteHook();
    expect(script).toContain("rebase");
  });

  it("prepare-commit-msg returns empty (reserved for future)", () => {
    const script = renderPrepareCommitMsgHook();
    expect(script).toBe("");
  });

  it("update-context script has shebang", () => {
    const script = renderUpdateContextScript();
    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it("update-context script checks for claude-onboard", () => {
    const script = renderUpdateContextScript();
    expect(script).toContain("claude-onboard");
  });

  it("update-context script implements throttling", () => {
    const script = renderUpdateContextScript();
    expect(script).toContain("THROTTLE_SECONDS");
  });

  it("update-context script implements log rotation", () => {
    const script = renderUpdateContextScript();
    expect(script).toContain("1048576");
  });

  it("update-context script uses lock file", () => {
    const script = renderUpdateContextScript();
    expect(script).toContain("LOCK_FILE");
  });

  it("uninstall script removes markers", () => {
    const script = renderUninstallScript();
    expect(script).toContain("claude-onboard start");
    expect(script).toContain("sed");
  });
});
