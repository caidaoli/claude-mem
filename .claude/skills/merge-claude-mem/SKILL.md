---
name: merge-claude-mem
description: Use when Codex 或 Claude Code 需要在包含 CustomAgent 定制和 plugin/ skip-worktree 状态的 claude-mem Fork 中同步 upstream 变更。
---

# 合并 claude-mem 上游

## 不变量

- 保留 Fork 行为，不保留过期代码形状；采用上游架构并迁移 CustomAgent 行为。
- 将合并前 HEAD 和 upstream 精确 commit 持久化到 Git 目录；不用对话记忆、移动 ref 或 `HEAD~1`。
- merge、测试或构建未完成时保持 `plugin/` 解锁；成功提交或明确 abort 后才恢复保护。
- `.gitattributes` 的 `merge=ours` 不能替代删除冲突处理和行为测试。
- 不批量选择 ours/theirs，不用 rebase 代替 upstream merge，不因构建失败自动修改依赖。

每个代码块都整块交给新的 bash 进程执行并检查退出码；非 0 立即停止。Claude Code 的 Bash 工具在忽略 errexit 的上下文中运行命令，直接粘贴时块内 `set -euo pipefail` 不生效，门禁会失败后继续执行：

```bash
bash -c "$(cat <<'SH'
<代码块原文>
SH
)"
echo "exit=$?"
```

## 1. Preflight 与快照

先检查中断状态。状态目录存在时不要覆盖，转到“中断恢复与 Abort”：

```bash
set -euo pipefail
for cmd in git bun npm node jq curl; do command -v "$cmd" >/dev/null; done
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
if test -d "$STATE_DIR"; then
  printf 'Interrupted merge state: %s\n' "$STATE_DIR"
  for file in pre-merge-head upstream-ref upstream-head; do
    test ! -f "$STATE_DIR/$file" || printf '%s=%s\n' \
      "$file" "$(sed -n '1p' "$STATE_DIR/$file")"
  done
  git status --short
  exit 1
fi
```

普通流程必须从干净的命名分支开始。冻结 upstream commit，验证 attributes 和合并前 CustomAgent 行为，再创建状态目录：

```bash
set -euo pipefail
test -n "$(git branch --show-current)"
test -z "$(git status --porcelain=v1)" || { git status --short; exit 1; }
git remote get-url upstream >/dev/null
git config merge.ours.driver true

git fetch upstream
git symbolic-ref --quiet --short refs/remotes/upstream/HEAD >/dev/null || \
  git remote set-head upstream --auto
UPSTREAM_REF=$(git symbolic-ref --quiet --short refs/remotes/upstream/HEAD)
UPSTREAM_HEAD=$(git rev-parse --verify "${UPSTREAM_REF}^{commit}")
UPSTREAM_COUNT=$(git rev-list --count HEAD.."$UPSTREAM_HEAD")
test "$UPSTREAM_COUNT" -gt 0 || { printf 'No upstream commits to merge.\n'; exit 1; }

git check-attr merge -- \
  src/services/worker/CustomAgent.ts \
  tests/worker/custom-agent-session.test.ts \
  tests/worker/custom-agent-utils.test.ts \
  tests/worker/custom-agent-history-truncation.test.ts \
  tests/worker/gemini-sse-parser.test.ts |
  awk -F': ' '{ count++; if ($3 != "ours") bad = 1 }
                 END { exit !(count == 5 && !bad) }'

bun test tests/worker/custom-agent-*.test.ts \
  tests/worker/gemini-sse-parser.test.ts \
  tests/parser-json-observations.test.ts \
  tests/sdk/parser.test.ts tests/sdk/prompts.test.ts

git log --oneline --left-right --cherry-pick HEAD..."$UPSTREAM_HEAD"
git diff --stat HEAD "$UPSTREAM_HEAD"

STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
mkdir "$STATE_DIR"
git rev-parse HEAD > "$STATE_DIR/pre-merge-head"
printf '%s\n' "$UPSTREAM_REF" > "$STATE_DIR/upstream-ref"
printf '%s\n' "$UPSTREAM_HEAD" > "$STATE_DIR/upstream-head"
```

## 2. 解锁 plugin

取消全部 skip-worktree，并从当前 HEAD 丢弃本地生成物。状态目录位于 `.git`，不会污染工作区：

```bash
set -euo pipefail
test -n "$(git ls-files plugin/ | sed -n '1p')"
git ls-files -z plugin/ | xargs -0 git update-index --no-skip-worktree --
git restore --source=HEAD --worktree -- plugin/
test -z "$(git status --porcelain=v1)" || { git status --short; exit 1; }
```

从此处到成功提交或 abort，不能恢复 skip-worktree。

## 3. 合并与冲突

只合并已冻结的 SHA：

```bash
set -euo pipefail
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
UPSTREAM_HEAD=$(sed -n '1p' "$STATE_DIR/upstream-head")
git cat-file -e "${UPSTREAM_HEAD}^{commit}"
git merge --no-commit --no-ff "$UPSTREAM_HEAD"
```

Fork 不保留 GitHub Actions。无论是否冲突，都删除上游带回的工作流；这也会解决 modify/delete 冲突：

```bash
git rm -r -q --ignore-unmatch -- .github/workflows
```

发生冲突时：

1. 用 `git diff --name-only --diff-filter=U` 和 `git ls-files -u` 列出冲突。
2. 读取 base、local、upstream 三方语义；采用上游架构并迁移本地行为。
3. 若 `.codegraph/` 存在，理解移动后的符号和调用路径时先使用 CodeGraph。
4. 逐个编辑、验证和 `git add`；不得批量 checkout ours/theirs。
5. `plugin/` 下的冲突是构建产物：不手改、不选 ours/theirs，源码冲突解决后由第 4 节的构建重新生成并暂存。

无论是否冲突，上游新增的界面文案都要接入 Fork 的 zh-CN。先列出上游的 UI 改动：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")
UPSTREAM_HEAD=$(sed -n '1p' "$STATE_DIR/upstream-head")
git diff --stat "$(git merge-base "$PRE_MERGE_HEAD" "$UPSTREAM_HEAD")" "$UPSTREAM_HEAD" -- src/ui
```

- viewer：组件里用 `useI18n()` 的 `t.<section>.<key>`，键同时加到 `src/ui/viewer/i18n/locales/en.ts` 和 `zh-CN.ts`（typecheck 会检查两边的键是否一致）。
- My Work：用 `t('English {var}', vars)`，中文加到 `src/ui/my-work/src/i18n/zh-CN/*.ts` 对应的字典里，键就是英文原文。

从持久快照读取旧实现，例如：

```bash
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")
git show "${PRE_MERGE_HEAD}:src/services/worker/CustomAgent.ts"
```

只恢复确认丢失的行为，不机械覆盖整个文件。

## 4. 验证并暂存

先构建并暂存 `plugin/`，再跑测试。`committed-plugin-bundles` 会按索引里的路径检查 bundle，而 work-view 每次构建都会换哈希文件名；旧路径如果还留在索引里，这个测试会成片失败：

```bash
set -euo pipefail
test -z "$(git diff --name-only --diff-filter=U -- . ':(exclude)plugin/')"
npm run typecheck
npm run build
rc=0
git grep -n -I -E '^(<<<<<<<|>>>>>>>) ' -- plugin/ || rc=$?
test "$rc" -eq 1
git add -A -- plugin/
test -z "$(git diff --name-only -- plugin/)"
test -z "$(git ls-files --others --exclude-standard -- plugin/)"
```

保持 `MERGE_HEAD` 存在，确认没有冲突且 attributes 契约仍有效：

```bash
set -euo pipefail
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
UPSTREAM_HEAD=$(sed -n '1p' "$STATE_DIR/upstream-head")
MERGE_HEAD_PATH=$(git rev-parse --git-path MERGE_HEAD)
test -f "$MERGE_HEAD_PATH"
test "$(sed -n '1p' "$MERGE_HEAD_PATH")" = "$UPSTREAM_HEAD"
test -z "$(git diff --name-only --diff-filter=U)"

git check-attr merge -- \
  src/services/worker/CustomAgent.ts \
  tests/worker/custom-agent-session.test.ts \
  tests/worker/custom-agent-utils.test.ts \
  tests/worker/custom-agent-history-truncation.test.ts \
  tests/worker/gemini-sse-parser.test.ts |
  awk -F': ' '{ count++; if ($3 != "ours") bad = 1 }
                 END { exit !(count == 5 && !bad) }'
```

CustomAgent 相关测试必须全部通过：

```bash
set -euo pipefail
bun test tests/worker/custom-agent-*.test.ts \
  tests/worker/gemini-sse-parser.test.ts \
  tests/parser-json-observations.test.ts \
  tests/sdk/parser.test.ts tests/sdk/prompts.test.ts
```

全量测试有既有失败，所以不看 `npm test` 的退出码，而是看日志。这一块要跑六七分钟，放到后台执行：

```bash
set -euo pipefail
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
LOG="$STATE_DIR/npm-test.log"
npm test >"$LOG" 2>&1 || printf 'npm test exit=%s\n' "$?"

# 每批的文件数加起来要等于计划的文件数，汇总的失败数要等于 (fail) 行数，且没有测试之外的 error。
awk '
  /^\[test-lanes\] fast: [0-9]+ files in / { expected = $3 }
  /^ *[0-9]+ fail$/ { fail = $1 }
  /^ *[0-9]+ errors?$/ { error = $1 }
  /^Ran [0-9]+ tests across [0-9]+ files\./ { ran += $5; failed += fail; errors += error }
  /^Ran / { fail = 0; error = 0 }
  /^\(fail\) / { listed++ }
  END {
    printf "files expected=%d ran=%d failed=%d listed=%d errors=%d\n",
      expected, ran, failed, listed, errors
    exit !(expected > 0 && ran == expected && failed == listed && errors == 0)
  }' "$LOG"

# 把每个失败归到它前面最近的测试文件标题下，存成“文件<TAB>用例”。
awk '
  /^(tests|src)\/.*(\.test|_test_|\.spec|_spec_).*\.[cm]?[jt]sx?:$/ {
    file = substr($0, 1, length($0) - 1); next
  }
  /^\(fail\) / {
    if (file == "") { bad = 1; next }
    name = substr($0, 8); sub(/ \[[0-9.]+m?s\]$/, "", name)
    print file "\t" name
  }
  END { exit bad }' "$LOG" >"$STATE_DIR/failed-tests"
cat "$STATE_DIR/failed-tests"
```

把每个失败文件分别放在合并结果、合并前 HEAD、upstream 三棵树里单独再跑一次。合并结果里失败、但两个基线里都没有的用例才算回归；合并结果单独跑能通过的，记为只在全量运行时失败：

```bash
set -euo pipefail
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")
UPSTREAM_HEAD=$(sed -n '1p' "$STATE_DIR/upstream-head")
ROOT=$(git rev-parse --show-toplevel)
cut -f1 "$STATE_DIR/failed-tests" | sort -u >"$STATE_DIR/failed-test-files"
test -s "$STATE_DIR/failed-test-files" || { printf 'no failing tests\n'; exit 0; }

WORK=$(mktemp -d)
cleanup() {
  git worktree remove --force "$WORK/pre" 2>/dev/null || true
  git worktree remove --force "$WORK/upstream" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
git worktree add --quiet --detach "$WORK/pre" "$PRE_MERGE_HEAD"
git worktree add --quiet --detach "$WORK/upstream" "$UPSTREAM_HEAD"
for tree in "$WORK/pre" "$WORK/upstream"; do
  git ls-files '*package.json' ':!plugin/' | while IFS= read -r manifest; do
    dir=$(dirname "$manifest")
    if test -d "$dir/node_modules" && test -d "$tree/$dir"; then
      ln -s "$ROOT/$dir/node_modules" "$tree/$dir/node_modules"
    fi
  done
done

# 输出这个文件里失败的用例名；非 0 退出却没有 (fail) 行时输出一行退出码。
failures() {
  local tree=$1 file=$2 rc=0
  test -f "$tree/$file" || return 0
  (cd "$tree" && bun test "./$file") </dev/null >"$WORK/run.log" 2>&1 || rc=$?
  awk '/^\(fail\) / { name = substr($0, 8); sub(/ \[[0-9.]+m?s\]$/, "", name); print name }' \
    "$WORK/run.log" | sort -u >"$WORK/names"
  if test "$rc" -ne 0 && test ! -s "$WORK/names"; then
    printf 'exit %s without (fail) lines\n' "$rc" >"$WORK/names"
  fi
  cat "$WORK/names"
}
count() { wc -l <"$1" | tr -d ' '; }

regressions=0
while IFS= read -r file; do
  awk -F '\t' -v file="$file" '$1 == file' "$STATE_DIR/failed-tests" >"$WORK/full"
  failures "$ROOT" "$file" >"$WORK/merged"
  failures "$WORK/pre" "$file" >"$WORK/pre.names"
  failures "$WORK/upstream" "$file" >"$WORK/upstream.names"
  sort -u "$WORK/pre.names" "$WORK/upstream.names" >"$WORK/baseline"
  comm -23 "$WORK/merged" "$WORK/baseline" >"$WORK/new"
  verdict=pre-existing
  test -s "$WORK/merged" || verdict=full-run-only
  test ! -s "$WORK/new" || verdict=REGRESSION
  printf '%s full=%s merged=%s pre=%s upstream=%s %s\n' "$file" \
    "$(count "$WORK/full")" "$(count "$WORK/merged")" \
    "$(count "$WORK/pre.names")" "$(count "$WORK/upstream.names")" "$verdict"
  sed 's/^/  new: /' "$WORK/new"
  regressions=$((regressions + $(count "$WORK/new")))
done <"$STATE_DIR/failed-test-files"
printf 'regressions=%s\n' "$regressions"
test "$regressions" -eq 0
```

没有回归后再安装到 Claude Code 和 Codex 并重启 Worker。重新构建后 `plugin/` 不能再有未暂存的变化；如果有，说明前面改过源码，回到本节第一步。Bun 崩溃会在仓库根留下 bun 可执行文件的副本 `.<hash>-00000000.bun-build`，确认和 bun 一模一样后删掉：

```bash
set -euo pipefail
npm run build-and-sync
test -z "$(git diff --name-only -- plugin/)"
test -z "$(git ls-files --others --exclude-standard -- plugin/)"

BUN_BIN=$(readlink -f "$(command -v bun)")
for junk in .*.bun-build; do
  test -f "$junk" || continue
  if cmp -s "$junk" "$BUN_BIN"; then
    rm -f -- "$junk"
    printf 'removed %s\n' "$junk"
  fi
done
```

失败时保持 merge 进行中和 `plugin/` 解锁，修复根因后从本节第一步重跑；不要自动执行 `npm install`。

检查 build 产生的 staged、unstaged 和 untracked 变更，逐个暂存属于本次合并的实际路径：

```bash
git status --short
git diff --check
git diff --stat
git diff --cached --check
git diff --cached --stat
git ls-files --others --exclude-standard
```

暂存完成后必须没有遗漏。空白检查排除 `plugin/`：构建产物不能手改，work-view bundle 内联的 CSS 模板字符串本身带行尾空白，上游提交的版本也一样：

```bash
set -euo pipefail
test -z "$(git diff --name-only)"
test -z "$(git ls-files --others --exclude-standard)"
test -n "$(git diff --cached --name-only)"
git diff --cached --check -- . ':(exclude)plugin/'
```

验证 Worker 状态和版本：

```bash
set -euo pipefail
WORKER_PORT=$(jq -r '.CLAUDE_MEM_WORKER_PORT // empty' \
  ~/.claude-mem/settings.json 2>/dev/null || true)
test -n "$WORKER_PORT" || WORKER_PORT=$((37700 + $(id -u) % 100))
HEALTH=$(curl --fail --silent --show-error \
  "http://127.0.0.1:${WORKER_PORT}/api/health")
CODE_VERSION=$(node -p "require('./package.json').version")
printf '%s\n' "$HEALTH" |
  jq -e --arg version "$CODE_VERSION" \
    '.status == "ok" and .version == $version'
```

## 5. 提交、保护与清理

根据 staged diff 编写真实摘要并创建 merge commit。标题使用当前 `package.json` 版本；不要复制历史 hash 或提交模板文字。

提交后验证两个 parent、工作区和 plugin 状态，再删除持久状态：

```bash
set -euo pipefail
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")
UPSTREAM_REF=$(sed -n '1p' "$STATE_DIR/upstream-ref")
UPSTREAM_HEAD=$(sed -n '1p' "$STATE_DIR/upstream-head")

test ! -f "$(git rev-parse --git-path MERGE_HEAD)"
test "$(git rev-parse HEAD^1)" = "$PRE_MERGE_HEAD"
test "$(git rev-parse HEAD^2)" = "$UPSTREAM_HEAD"
test -z "$(git status --porcelain=v1)" || { git status --short; exit 1; }

UPSTREAM_COUNT=$(git rev-list --count "${PRE_MERGE_HEAD}..${UPSTREAM_HEAD}")
printf 'upstream_ref=%s upstream_head=%s merge_commit=%s upstream_commits=%s\n' \
  "$UPSTREAM_REF" "$UPSTREAM_HEAD" "$(git rev-parse HEAD)" "$UPSTREAM_COUNT"

git ls-files -z plugin/ | xargs -0 git update-index --skip-worktree --
git ls-files -v plugin/ |
  awk 'BEGIN { skip = 0; total = 0 }
       /^S / { skip++ }
       { total++ }
       END {
         printf "skip=%d tracked=%d\n", skip, total
         exit !(total > 0 && skip == total)
       }'

rm -f "$STATE_DIR/pre-merge-head" "$STATE_DIR/upstream-ref" "$STATE_DIR/upstream-head" \
  "$STATE_DIR/npm-test.log" "$STATE_DIR/failed-tests" "$STATE_DIR/failed-test-files"
rmdir "$STATE_DIR"
test ! -d "$STATE_DIR"
git status --short
```

## 6. 中断恢复与 Abort

状态目录存在时按 Git state 分类：

- `MERGE_HEAD` 存在：继续解决/验证，或经用户确认后 abort。
- `HEAD == PRE_MERGE_HEAD`：merge 尚未开始或已经 abort，恢复运行时和 plugin 保护。
- 当前 HEAD 的两个 parent 分别等于快照和 upstream SHA：merge 已提交，重跑第 4 节的测试、构建和 Worker 健康检查，确认工作区干净后完成第 5 节。
- 其他情况：保留状态目录，停止并人工检查；不得自动 reset。

只有用户决定放弃未提交 merge，或 HEAD 已回到快照时，才执行：

```bash
set -euo pipefail
STATE_DIR=$(git rev-parse --git-path merge-claude-mem)
PRE_MERGE_HEAD=$(sed -n '1p' "$STATE_DIR/pre-merge-head")
UPSTREAM_HEAD=$(sed -n '1p' "$STATE_DIR/upstream-head")
MERGE_HEAD_PATH=$(git rev-parse --git-path MERGE_HEAD)

if test -f "$MERGE_HEAD_PATH"; then
  test "$(sed -n '1p' "$MERGE_HEAD_PATH")" = "$UPSTREAM_HEAD"
  git merge --abort
elif test "$(git rev-parse HEAD)" != "$PRE_MERGE_HEAD"; then
  printf 'Merge is committed or state diverged; explicit rollback approval is required.\n' >&2
  exit 1
fi

test "$(git rev-parse HEAD)" = "$PRE_MERGE_HEAD"
git ls-files -z plugin/ | xargs -0 git update-index --no-skip-worktree --
git restore --source="$PRE_MERGE_HEAD" --staged --worktree -- plugin/
npm run build-and-sync

WORKER_PORT=$(jq -r '.CLAUDE_MEM_WORKER_PORT // empty' \
  ~/.claude-mem/settings.json 2>/dev/null || true)
test -n "$WORKER_PORT" || WORKER_PORT=$((37700 + $(id -u) % 100))
HEALTH=$(curl --fail --silent --show-error \
  "http://127.0.0.1:${WORKER_PORT}/api/health")
CODE_VERSION=$(node -p "require('./package.json').version")
printf '%s\n' "$HEALTH" |
  jq -e --arg version "$CODE_VERSION" \
    '.status == "ok" and .version == $version' >/dev/null

test -z "$(git status --porcelain=v1)" || { git status --short; exit 1; }

git ls-files -z plugin/ | xargs -0 git update-index --skip-worktree --
git ls-files -v plugin/ |
  awk 'BEGIN { skip = 0; total = 0 }
       /^S / { skip++ }
       { total++ }
       END { exit !(total > 0 && skip == total) }'

rm -f "$STATE_DIR/pre-merge-head" "$STATE_DIR/upstream-ref" "$STATE_DIR/upstream-head" \
  "$STATE_DIR/npm-test.log" "$STATE_DIR/failed-tests" "$STATE_DIR/failed-test-files"
rmdir "$STATE_DIR"
test ! -d "$STATE_DIR"
```

任何恢复步骤失败都保留状态目录并报告真实状态。

## 完成报告

报告 upstream ref/SHA/版本/提交数、merge commit、冲突处理和中文化、测试/typecheck/build、每个失败文件的分类（pre-existing、full-run-only）、Worker 健康与版本、plugin skip/tracked 数量，以及状态目录是否清理。
