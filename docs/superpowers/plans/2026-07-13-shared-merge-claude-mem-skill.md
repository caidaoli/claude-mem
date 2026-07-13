# Shared merge-claude-mem Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex 与 Claude Code 从各自的仓库级发现目录加载同一个 `merge-claude-mem` Skill。

**Architecture:** `.claude/skills/merge-claude-mem/` 保持唯一真实目录；`.agents/skills/merge-claude-mem` 使用相对符号链接指向它。Skill 内容保持客户端无关，仅把触发描述改成 Codex 与 Claude Code 均明确适用的标准形式。

**Tech Stack:** Markdown、YAML frontmatter、Git 符号链接、POSIX shell

## Global Constraints

- 唯一真实文件必须是 `.claude/skills/merge-claude-mem/SKILL.md`。
- Codex 入口必须是相对链接 `.agents/skills/merge-claude-mem -> ../../.claude/skills/merge-claude-mem`。
- 不得复制 `SKILL.md`，不得新增包装文件、脚本或元数据。
- 不得修改用户已有的 `.gitignore` 或其他无关工作区内容。
- 本改动不新增运行时代码；按项目测试策略只做 Skill 契约、链接和 Git diff 验证。

---

### Task 1: 建立 Codex 与 Claude Code 的共享 Skill 入口

**Files:**
- Modify: `.claude/skills/merge-claude-mem/SKILL.md:1`
- Create: `.agents/skills/merge-claude-mem`（符号链接）
- Test: 不新增测试文件；使用 shell 和 `quick_validate.py` 验证公开 Skill 契约

**Interfaces:**
- Consumes: Claude Code 从 `.claude/skills` 发现 Skill；Codex 从 `.agents/skills` 发现 Skill 并支持链接目录。
- Produces: 两个客户端读取同一个 `SKILL.md`，Skill 名称继续为 `merge-claude-mem`。

- [ ] **Step 1: 记录 Codex 入口缺失的基线失败**

Run:

```bash
uv run --with pyyaml python /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/merge-claude-mem
```

Expected: FAIL，报告 Skill 目录或 `SKILL.md` 不存在。

- [ ] **Step 2: 将触发描述改成跨客户端标准形式**

Apply:

```diff
 ---
 name: merge-claude-mem
-description: 用于将上游仓库的最新代码合并到当前分支，保护 Fork 定制代码（CustomAgent），处理 `plugin/` 目录的 skip-worktree，并验证运行中的 Worker 版本。
+description: Use when Codex 或 Claude Code 需要在包含 CustomAgent 定制和 plugin/ skip-worktree 状态的 claude-mem Fork 中同步 upstream 变更。
 ---
```

- [ ] **Step 3: 创建唯一的 Codex 链接入口**

Run:

```bash
mkdir -p .agents/skills
ln -s ../../.claude/skills/merge-claude-mem .agents/skills/merge-claude-mem
```

Expected: `.agents/skills/merge-claude-mem` 是相对符号链接，不产生第二份 `SKILL.md`。

- [ ] **Step 4: 验证两个入口、YAML 契约和链接目标**

Run:

```bash
test -L .agents/skills/merge-claude-mem
test "$(readlink .agents/skills/merge-claude-mem)" = "../../.claude/skills/merge-claude-mem"
test "$(realpath .agents/skills/merge-claude-mem)" = "$(realpath .claude/skills/merge-claude-mem)"
cmp .claude/skills/merge-claude-mem/SKILL.md .agents/skills/merge-claude-mem/SKILL.md
uv run --with pyyaml python /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/merge-claude-mem
uv run --with pyyaml python /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/merge-claude-mem
```

Expected: 所有命令退出码为 0；两个 validator 都输出 `Skill is valid!`。

- [ ] **Step 5: 检查并提交精确改动**

Run:

```bash
git add .claude/skills/merge-claude-mem/SKILL.md .agents/skills/merge-claude-mem
git diff --cached --check
git diff --cached --stat
git commit --only -m "chore: share merge skill with Codex and Claude" -- .claude/skills/merge-claude-mem/SKILL.md .agents/skills/merge-claude-mem
```

Expected: staged diff 只包含一个 `SKILL.md` 和一个符号链接；提交成功且不包含 `.gitignore`。
