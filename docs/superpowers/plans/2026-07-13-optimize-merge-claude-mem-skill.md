# Optimize merge-claude-mem Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `merge-claude-mem` 重构为可恢复、以 Git 快照和行为验证为准的 upstream merge 工作流。

**Architecture:** `.claude/skills/merge-claude-mem/SKILL.md` 是唯一实现；`.agents/skills/merge-claude-mem` 继续链接该目录。Skill 冻结合并两端的精确 commit，显式管理 plugin 解锁/保护和 abort，不新增 helper 脚本。

**Tech Stack:** Markdown、YAML frontmatter、Git、Bun、npm、jq、curl

## Global Constraints

- 不复制 `SKILL.md`，不新增辅助脚本或测试文件。
- 删除静态 CustomAgent 符号清单、过期 attributes 说明、rebase 和自动安装依赖建议。
- 正常完成时，所有 tracked `plugin/` 文件都必须设置 skip-worktree。
- 不修改用户已有的 `.gitignore` 变更。
- 设计细节以 `docs/superpowers/specs/2026-07-13-optimize-merge-claude-mem-skill-design.md` 为准；本计划不复制主文件正文。

---

### Task 1: 重写并验证共享 Skill

**Files:**
- Modify: `.claude/skills/merge-claude-mem/SKILL.md`
- Verify: `.agents/skills/merge-claude-mem`

**Interfaces:**
- Consumes: `merge=ours` attributes、`npm test`、`npm run typecheck`、`npm run build-and-sync`、Worker `/api/health`。
- Produces: Claude Code 与 Codex 共用的单一 upstream merge 工作流。

- [ ] **Step 1: 记录旧文档漂移证据**

```bash
git check-attr merge -- \
  src/services/worker/CustomAgent.ts \
  tests/worker/custom-agent-session.test.ts \
  tests/worker/custom-agent-utils.test.ts \
  tests/worker/custom-agent-history-truncation.test.ts \
  tests/worker/gemini-sse-parser.test.ts
npm pkg get scripts.test scripts.typecheck scripts.build-and-sync
```

Expected: 五个路径均返回 `merge: ours`，npm scripts 与设计使用的命令一致。

- [ ] **Step 2: 重写唯一主文件**

实现以下契约：

- frontmatter 只包含 `name`、纯触发条件 `description`。
- 中断状态检查先于普通工作区 clean gate。
- 持久记录 `PRE_MERGE_HEAD`、upstream ref 和冻结后的 upstream SHA。
- merge 前解锁并恢复 `plugin/`；只合并冻结 SHA。
- 冲突按三方语义解决；行为验证替代静态符号快照。
- 定向测试、完整测试、typecheck、build、Worker 状态与版本全部通过后才提交。
- merge commit parent 必须等于持久化的两个 commit；工作区干净后才能恢复全部 plugin skip-worktree。
- 中断恢复区分 merge 进行中、尚未开始/已 abort、已提交和未知分叉四种状态。
- 成功或 abort 后验证 skip/tracked 数量一致并清理状态目录。

- [ ] **Step 3: 验证公开契约**

```bash
test -L .agents/skills/merge-claude-mem
test "$(readlink .agents/skills/merge-claude-mem)" = \
  "../../.claude/skills/merge-claude-mem"
test "$(realpath .agents/skills/merge-claude-mem)" = \
  "$(realpath .claude/skills/merge-claude-mem)"
cmp .claude/skills/merge-claude-mem/SKILL.md \
  .agents/skills/merge-claude-mem/SKILL.md
uv run --with pyyaml python \
  /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .claude/skills/merge-claude-mem
uv run --with pyyaml python \
  /Users/caidaoli/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/merge-claude-mem
```

Expected: 链接指向唯一目录，两个 validator 均输出 `Skill is valid!`。

- [ ] **Step 4: 检查范围并提交**

```bash
git diff --check -- .claude/skills/merge-claude-mem/SKILL.md
git status --short
git add .claude/skills/merge-claude-mem/SKILL.md
git diff --cached --check
git diff --cached --name-status
git commit --only -m "refactor: make upstream merge skill recoverable" -- \
  .claude/skills/merge-claude-mem/SKILL.md
```

Expected: 实现提交只包含唯一主 Skill；`.agents` 链接不变；`.gitignore` 保持未暂存。
