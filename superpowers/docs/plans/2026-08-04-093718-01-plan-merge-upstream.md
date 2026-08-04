# Merge claude-mem upstream

**Goal:** Merge the frozen upstream revision into the fork while preserving CustomAgent behavior on the current upstream architecture.
**Why planning is required:** The operation creates a consequential two-parent merge commit, changes generated plugin artifacts, and must preserve recoverable Git/index state until verification completes.
**Acceptance:** Merge only the persisted upstream SHA; preserve the persisted pre-merge HEAD; stop on any failed required command without restoring `plugin/` protection; commit only after all conflicts, tests, typecheck, build, diff checks, and Worker health/version checks pass; verify both merge parents; restore skip-worktree for every tracked `plugin/` file; remove the merge state directory only after success.

### Outcome 1: Frozen and recoverable merge inputs
- Work: Persist the named upstream ref, exact upstream commit, and pre-merge HEAD under the repository Git directory; keep `plugin/` unlocked through merge and verification.
- Risks/open questions: Upstream deletes the fork-owned CustomAgent implementation and tests, so deletion handling must be semantic rather than mechanical.
- Verify: `git status --short && git diff --name-only --diff-filter=U`

### Outcome 2: Upstream architecture with fork behavior retained
- Work: Merge the frozen SHA, inspect base/local/upstream for every conflict, accept upstream structure, and migrate only confirmed CustomAgent and fork integration behavior.
- Risks/open questions: Generated plugin output and upstream source moves may conceal missing runtime wiring even when merge attributes suppress text conflicts.
- Verify: `bun test tests/worker/custom-agent-*.test.ts tests/worker/gemini-sse-parser.test.ts tests/parser-json-observations.test.ts tests/sdk/parser.test.ts tests/sdk/prompts.test.ts`

### Outcome 3: Verified merge state and generated artifacts
- Work: Run the full test suite, typecheck, build-and-sync, inspect staged/unstaged/untracked paths, stage only merge-owned results, and verify the running Worker reports the package version.
- Verify: `npm test && npm run typecheck && npm run build-and-sync`

### Outcome 4: Delivered merge commit and restored protection
- Work: Create a versioned merge commit from the reviewed staged diff, verify both parents and a clean worktree, restore skip-worktree on all tracked plugin files, then remove persistent merge state.
- Verify: `git status --short && git ls-files -v plugin/`
