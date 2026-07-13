# Optimize merge-claude-mem Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `merge-claude-mem` 重构为简洁、可恢复、以 Git 快照和行为验证为准的 upstream merge 工作流。

**Architecture:** 只重写 `.claude/skills/merge-claude-mem/SKILL.md`，Codex 继续通过现有目录链接读取同一文件。流程持久记录 `PRE_MERGE_HEAD`，显式管理 merge、plugin skip-worktree 和 abort 状态，不新增 helper 脚本。

**Tech Stack:** Markdown、YAML frontmatter、Git、Bun、npm、jq、curl

## Global Constraints

- `.claude/skills/merge-claude-mem/SKILL.md` 必须继续是唯一主文件。
- `.agents/skills/merge-claude-mem` 必须继续是相对目录符号链接。
- 不新增辅助脚本、测试文件或第二份 `SKILL.md`。
- 删除静态 CustomAgent 符号清单、过期 `.gitattributes` 说明、rebase 建议和自动 `npm install` 建议。
- `plugin/` 正常完成后的不变量是所有 tracked 文件都设置 skip-worktree。
- 本次是文档重构；按项目 Testing Policy 不新增内容实现测试，只验证公开 Skill 契约和链接。
- 不修改用户现有 `.gitignore` 变更。

---

### Task 1: 重写可恢复的 upstream merge 工作流

**Files:**
- Modify: `.claude/skills/merge-claude-mem/SKILL.md:1`
- Verify: `.agents/skills/merge-claude-mem`
- Test: 不新增测试文件；运行 `quick_validate.py`、链接契约检查和 Git diff 检查

**Interfaces:**
- Consumes: 当前 `.gitattributes` 的 `merge=ours` 属性、`merge.ours.driver=true`、`npm test`、`npm run typecheck`、`npm run build-and-sync` 和 Worker `/api/health`。
- Produces: Claude Code 与 Codex 共用的单一 `merge-claude-mem` 工作流。

- [ ] **Step 1: 记录当前文档漂移证据**

Run:

```bash
git check-attr merge -- \
  src/services/worker/CustomAgent.ts \
  tests/worker/custom-agent-session.test.ts \
  tests/worker/custom-agent-utils.test.ts \
  tests/worker/custom-agent-history-truncation.test.ts \
  tests/worker/gemini-sse-parser.test.ts
npm pkg get scripts.test scripts.typecheck scripts.build-and-sync
```

Expected: 五个路径的 merge 属性均为 `ours`；npm scripts 分别解析为 `bun test`、两个 TypeScript typecheck 和 build/sync/restart 流程。这证明旧 Skill 的“未配置 merge=ours”说法已失效。

- [ ] **Step 2: 用以下完整内容替换主 Skill**

```markdown
---
name: merge-claude-mem
description: Use when Codex 或 Claude Code 需要在包含 CustomAgent 定制和 plugin/ skip-worktree 状态的 claude-mem Fork 中同步 upstream 变更。
---

# 合并 claude-mem 上游

## 核心原则

- 保留 Fork 行为，不保留过期代码形状。采用上游架构，将 CustomAgent 行为迁移到新结构。
- 以持久化的 `PRE_MERGE_HEAD` 作为合并前唯一快照，不依赖对话记忆或 `HEAD~1`。
- 冲突、测试或构建未完成时保持 `plugin/` 解锁；成功提交或明确 abort 后才恢复保护。
- `.gitattributes` 的 `merge=ours` 只能影响内容合并，不能处理所有删除场景，也不能替代测试。
- 禁止批量选择 ours/theirs，禁止用 rebase 代替 upstream merge，禁止因构建失败自动修改依赖。
- 遵循仓库 `AGENTS.md` 与 `CLAUDE.md`，先修根因，再处理冲突表象。

## 1. Preflight

确认工具、分支、工作区和 upstream：

```bash
set -euo pipefail
command -v git >/dev/null
command -v bun >/dev/null
command -v npm >/dev/null
command -v node >/dev/null
command -v jq >/dev/null
command -v curl >/dev/null

test -n "$(git branch --show-current)"
test -z "$(git status --porcelain=v1)" || {
  git status --short
  exit 1
}
git remote get-url upstream >/dev/null
git config merge.ours.driver true
test "$(git config --get merge.ours.driver)" = "true"
```

如果持久状态已存在，说明上次流程被中断。不要覆盖；读取其中的 commit，结合 `git status` 和 `MERGE_HEAD` 恢复或 abort：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
if test -e "$STATE_DIR/pre-merge-head"; then
  sed -n '1p' "$STATE_DIR/pre-merge-head"
  test -e "$STATE_DIR/upstream-ref" && sed -n '1p' "$STATE_DIR/upstream-ref"
  git status --short
  exit 1
fi
```

获取上游并解析其真实默认分支：

```bash
git fetch upstream
git symbolic-ref --quiet --short refs/remotes/upstream/HEAD >/dev/null || \
  git remote set-head upstream --auto
UPSTREAM_REF=$(git symbolic-ref --quiet --short refs/remotes/upstream/HEAD)
test -n "$UPSTREAM_REF"

UPSTREAM_COUNT=$(git rev-list --count HEAD.."$UPSTREAM_REF")
test "$UPSTREAM_COUNT" -gt 0 || {
  printf 'No upstream commits to merge.\n'
  exit 1
}

git log --oneline --left-right --cherry-pick HEAD..."$UPSTREAM_REF"
git diff --stat HEAD "$UPSTREAM_REF"
```

验证当前 attributes 契约并运行合并前行为基线：

```bash
git check-attr merge -- \
  src/services/worker/CustomAgent.ts \
  tests/worker/custom-agent-session.test.ts \
  tests/worker/custom-agent-utils.test.ts \
  tests/worker/custom-agent-history-truncation.test.ts \
  tests/worker/gemini-sse-parser.test.ts |
  awk -F': ' '$3 != "ours" { bad = 1 } END { exit bad }'

bun test \
  tests/worker/custom-agent-*.test.ts \
  tests/worker/gemini-sse-parser.test.ts \
  tests/parser-json-observations.test.ts \
  tests/sdk/parser.test.ts \
  tests/sdk/prompts.test.ts
```

基线通过后持久化状态：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
UPSTREAM_REF=$(git symbolic-ref --quiet --short refs/remotes/upstream/HEAD)
mkdir -p "$STATE_DIR"
git rev-parse HEAD > "$STATE_DIR/pre-merge-head"
printf '%s\n' "$UPSTREAM_REF" > "$STATE_DIR/upstream-ref"
```

## 2. 解锁 plugin 生成目录

`plugin/` 必须包含 tracked 文件。取消全部 skip-worktree，并从当前 `HEAD` 丢弃本地生成物：

```bash
test -n "$(git ls-files plugin/ | sed -n '1p')"
git ls-files -z plugin/ |
  xargs -0 git update-index --no-skip-worktree --
git restore --source=HEAD --worktree -- plugin/
test -z "$(git status --porcelain=v1)" || {
  git status --short
  exit 1
}
```

从此处开始，直至成功或 abort，不能恢复 skip-worktree。

## 3. 合并

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
UPSTREAM_REF=$(sed -n '1p' "$STATE_DIR/upstream-ref")
git merge --no-commit --no-ff "$UPSTREAM_REF"
```

如果发生冲突：

1. 用 `git diff --name-only --diff-filter=U` 和 `git ls-files -u` 列出冲突。
2. 对每个文件读取 base、local、upstream 三方内容，理解语义后再编辑。
3. 接受上游的新架构和修复，将 CustomAgent 行为迁移到对应位置。
4. 逐个 `git add` 已解决文件；不得批量 checkout ours/theirs。
5. 若 `.codegraph/` 存在，理解移动后的符号和调用路径时先使用 CodeGraph。

合并前版本始终从持久快照读取：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")
git diff --name-status "$PRE_MERGE_HEAD"
git diff --name-only --diff-filter=U
```

仅在确定行为丢失后，用 `git show "${PRE_MERGE_HEAD}:src/services/worker/CustomAgent.ts"` 这类精确命令理解旧实现，并适配到上游结构；不要机械恢复整个文件。

## 4. 验证合并结果

所有冲突必须解决，attributes 契约必须仍然有效：

```bash
test -z "$(git diff --name-only --diff-filter=U)"
git check-attr merge -- \
  src/services/worker/CustomAgent.ts \
  tests/worker/custom-agent-session.test.ts \
  tests/worker/custom-agent-utils.test.ts \
  tests/worker/custom-agent-history-truncation.test.ts \
  tests/worker/gemini-sse-parser.test.ts |
  awk -F': ' '$3 != "ours" { bad = 1 } END { exit bad }'
```

按从快到慢的顺序验证公开行为：

```bash
bun test \
  tests/worker/custom-agent-*.test.ts \
  tests/worker/gemini-sse-parser.test.ts \
  tests/parser-json-observations.test.ts \
  tests/sdk/parser.test.ts \
  tests/sdk/prompts.test.ts
npm test
npm run typecheck
npm run build-and-sync
```

任何一步失败都停止：保持 merge 进行中和 `plugin/` 解锁，修复根因后重新运行完整验证。不要自动执行 `npm install`。

检查 build 产生的变更，只暂存理解且属于合并结果的文件：

```bash
git status --short
git diff --check
git diff --cached --check
git diff --cached --stat
```

确认 Worker 使用本地配置端口、状态健康且版本与代码一致：

```bash
WORKER_PORT=$(jq -r '.CLAUDE_MEM_WORKER_PORT // empty' \
  ~/.claude-mem/settings.json 2>/dev/null || true)
if test -z "$WORKER_PORT"; then
  WORKER_PORT=$((37700 + $(id -u) % 100))
fi

HEALTH=$(curl --fail --silent --show-error \
  "http://127.0.0.1:${WORKER_PORT}/api/health")
printf '%s\n' "$HEALTH" | jq .

CODE_VERSION=$(node -p "require('./package.json').version")
WORKER_VERSION=$(printf '%s\n' "$HEALTH" | jq -r '.version // empty')
test "$(printf '%s\n' "$HEALTH" | jq -r '.status // empty')" = "ok"
test "$WORKER_VERSION" = "$CODE_VERSION"
```

## 5. 创建 merge commit

确认 `MERGE_HEAD` 存在，检查完整 staged diff，并生成包含真实版本的标题：

```bash
test -f "$(git rev-parse --git-path MERGE_HEAD)"
git diff --cached --check
git diff --cached --stat
VERSION=$(node -p "require('./package.json').version")
printf 'Merge upstream changes (v%s) with local modifications\n' "$VERSION"
```

使用打印出的标题创建 merge commit；正文必须根据当前 staged diff 总结实际上游变化和本地适配。不要引用历史 merge hash，不要提交模板文字。额外修复只有在可独立解释时才拆成后续提交。

## 6. 恢复 plugin 保护并清理状态

merge commit 成功后，将所有当前 tracked plugin 文件设为 skip-worktree，并验证数量严格相等：

```bash
test -z "$(git status --porcelain=v1)" || {
  git status --short
  exit 1
}
git ls-files -z plugin/ |
  xargs -0 git update-index --skip-worktree --

git ls-files -v plugin/ |
  awk 'BEGIN { skip = 0; total = 0 }
       /^S / { skip++ }
       { total++ }
       END {
         printf "skip=%d tracked=%d\n", skip, total
         exit !(total > 0 && skip == total)
       }'
```

清理持久状态并确认普通工作区干净：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
rm -f "$STATE_DIR/pre-merge-head" "$STATE_DIR/upstream-ref"
rmdir "$STATE_DIR"
git status --short
```

## 7. Abort 与恢复

只有用户决定放弃本次合并时才执行：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")

if test -f "$(git rev-parse --git-path MERGE_HEAD)"; then
  git merge --abort
fi
test "$(git rev-parse HEAD)" = "$PRE_MERGE_HEAD"
git restore --source="$PRE_MERGE_HEAD" --staged --worktree -- plugin/
npm run build-and-sync

test -z "$(git status --porcelain=v1)" || {
  git status --short
  exit 1
}
git ls-files -z plugin/ |
  xargs -0 git update-index --skip-worktree --
git ls-files -v plugin/ |
  awk 'BEGIN { skip = 0; total = 0 }
       /^S / { skip++ }
       { total++ }
       END { exit !(total > 0 && skip == total) }'

rm -f "$STATE_DIR/pre-merge-head" "$STATE_DIR/upstream-ref"
rmdir "$STATE_DIR"
git status --short
```

如果 abort 后重建、Worker 检查或保护恢复失败，保留持久状态并报告真实失败，不得声称恢复完成。

## 完成报告

报告：

- upstream ref、版本、合并提交和提交数量；
- 关键上游变化及冲突解决；
- CustomAgent 行为验证、完整测试、typecheck、build 结果；
- Worker 代码版本、运行版本和健康状态；
- plugin skip/tracked 数量；
- 持久状态是否已清理。
```

- [ ] **Step 3: 验证两个客户端读取同一有效 Skill**

Run:

```bash
test -L .agents/skills/merge-claude-mem
test "$(readlink .agents/skills/merge-claude-mem)" = \
  "../../.claude/skills/merge-claude-mem"
test "$(realpath .agents/skills/merge-claude-mem)" = \
  "$(realpath .claude/skills/merge-claude-mem)"
cmp \
  .claude/skills/merge-claude-mem/SKILL.md \
  .agents/skills/merge-claude-mem/SKILL.md
uv run --with pyyaml python \
  /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .claude/skills/merge-claude-mem
uv run --with pyyaml python \
  /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/merge-claude-mem
```

Expected: 所有命令退出码为 0；两个 validator 均输出 `Skill is valid!`。

- [ ] **Step 4: 检查范围并提交**

Run:

```bash
git diff --check -- .claude/skills/merge-claude-mem/SKILL.md
git diff --stat -- .claude/skills/merge-claude-mem/SKILL.md
git status --short
git add .claude/skills/merge-claude-mem/SKILL.md
git diff --cached --check
git diff --cached --name-status
git commit --only -m "refactor: make upstream merge skill recoverable" -- \
  .claude/skills/merge-claude-mem/SKILL.md
```

Expected: commit 只包含唯一主 Skill；`.agents` 链接未变化；用户已有 `.gitignore` 修改保持未暂存。
