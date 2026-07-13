# 优化 merge-claude-mem Skill

## 根因

现有 Skill 把一次历史合并的文件和符号清单写成永久事实，并要求代理“读取并记住”代码。该快照已经与仓库漂移：`.gitattributes` 早已配置 `merge=ours`，CustomAgent 设置项也已增加。与此同时，合并过程没有清晰定义 `plugin/` 的状态转换和失败恢复，容易在冲突或构建失败后留下不明确的 index 状态。

## 目标

- 保留 `.claude/skills/merge-claude-mem/SKILL.md` 为唯一主文件，继续通过 `.agents/skills/merge-claude-mem` 链接供 Codex 使用。
- 用 Git 的不可变提交快照和行为验证保护 Fork 定制，不依赖固定代码形状。
- 把合并写成可恢复的状态机；不新增辅助脚本。
- 删除过期事实、重复说明、危险的 rebase 建议和自动修改依赖的故障处理。

## 核心不变量

1. 合并开始前，普通工作区必须干净；`PRE_MERGE_HEAD` 持久写入 `$(git rev-parse --git-path merge-claude-mem)/pre-merge-head`。
2. 执行 merge 前，取消所有已跟踪 `plugin/` 文件的 skip-worktree，并从 `HEAD` 恢复本地生成物。
3. merge 冲突未解决时保持 skip-worktree 取消状态，不能隐藏待处理变更。
4. 只有 merge 已提交且测试、类型检查、构建均成功，或 merge 已明确 abort 后，才能重新保护 `plugin/`。
5. 正常完成时，所有已跟踪 `plugin/` 文件都必须设置 skip-worktree；验证 `skip 数量 == tracked 数量`。
6. 不使用 `ours`/`theirs` 批量覆盖冲突，不用 rebase 替代 upstream merge。
7. 仅在成功完成或确认 abort 后删除持久状态；中断和失败时保留它供恢复。

## 工作流

### 1. Preflight 与基线

- 检查工作区、当前分支、remote 和 merge driver。
- fetch upstream 后，从 `refs/remotes/upstream/HEAD` 解析默认分支；缺失时运行 `git remote set-head upstream --auto`，不猜 `main` 或 `master`。
- 持久记录 `PRE_MERGE_HEAD`，并展示本地独有提交、上游提交及 diff stat。
- 运行 CustomAgent 定向测试，确认合并前基线可信。

### 2. 解锁生成目录

- 对 `git ls-files plugin/` 返回的全部路径取消 skip-worktree。
- 使用 `git restore --source=HEAD --worktree -- plugin/` 丢弃本地生成物。
- 再次检查工作区；如果仍有非预期修改，停止并报告。

### 3. 合并与冲突处理

- 使用 `git merge --no-commit --no-ff <upstream-ref>`，在创建 merge commit 前保留验证和修复机会。
- 基于 base、local、upstream 三方语义逐个解决冲突：采用上游架构，迁移本地 CustomAgent 行为。
- `.gitattributes` 中已有 `merge=ours` 规则和 `merge.ours.driver=true`。它只能影响内容合并，不能证明 CustomAgent 行为完整，也不能替代删除/修改冲突处理和测试。
- 若终止合并，执行 `git merge --abort`，确认工作区回到 `PRE_MERGE_HEAD`，恢复全部 plugin skip-worktree，然后清理持久状态。

### 4. 行为验证与提交

- 用 `PRE_MERGE_HEAD` 随时读取合并前版本或恢复确实丢失的 Fork 行为；不使用模糊的 `HEAD~1`。
- 运行 CustomAgent、JSON parser/prompt 相关定向测试，再运行完整 `npm test` 和 `npm run typecheck`。
- 运行 `npm run build-and-sync`，检查生成产物和 Worker `/api/health` 的 `status`、`version`。
- 验证通过后检查 staged diff，创建一次清晰的 upstream merge commit；只有额外的、可独立解释的修复才使用后续提交。
- 将全部当前 tracked plugin 文件设为 skip-worktree，并验证数量相等。
- 输出完成报告后清理持久状态。

## 失败处理

- **冲突未解决：** 保持 merge 进行中和 plugin 解锁，继续解决或明确 abort。
- **测试、类型检查或构建失败：** 不提交、不恢复 skip-worktree；修复根因后重新运行完整验证。
- **Worker 版本不一致：** 诊断重启与配置端口，不用等待或重复构建掩盖问题。
- **会话中断：** 从 Git state 和持久化的 `pre-merge-head` 恢复上下文，不依赖对话记忆。

## Skill 结构

重写后的 `SKILL.md` 保留以下章节：触发描述、核心不变量、preflight、合并、验证、恢复、完成报告。删除静态符号表、重复验证清单、历史版本故事和散落的故障排除副本。所有命令必须可直接执行，并使用当前仓库真实的 npm 脚本。

## 验证策略

本次只修改 Skill 文档，不新增单元测试。实施后验证：两个链接入口均通过 `quick_validate.py`；链接仍解析到同一主文件；命令引用的 Git/NPM 契约与当前仓库一致；Markdown 无占位符；Git diff 不包含用户现有 `.gitignore` 修改。
