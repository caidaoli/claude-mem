---
name: merge-claude-mem
description: Use when Codex 或 Claude Code 需要在包含 CustomAgent 定制和 plugin/ skip-worktree 状态的 claude-mem Fork 中同步 upstream 变更。
---
## 前置条件

- 工作区干净（无未提交的更改）
- 已配置 upstream remote（如未配置，需先添加）

## 合并流程

### 1. 检查工作区状态

```bash
git status
git remote -v
```

确认：
- 工作区干净，无未提交更改
- upstream remote 已正确配置
- 如未配置 upstream，提示用户添加：`git remote add upstream <url>`

### 2. 处理 plugin/ 目录的 skip-worktree（合并前）

**重要**：`plugin/` 是编译生成的目录，本地使用 skip-worktree 忽略变更。合并前必须处理。

```bash
# 查看哪些文件设置了 skip-worktree
git ls-files -v plugin/ | grep '^S'

# 取消 plugin/ 目录所有文件的 skip-worktree（批量）
git ls-files plugin/ | xargs git update-index --no-skip-worktree --

# 还原 plugin/ 目录到 git 版本（丢弃本地编译产物）
git checkout -- plugin/
```

### 3. 快照 Fork 定制代码（合并前）

**在执行 merge 之前，必须先记录共享文件中 CustomAgent 定制代码的当前状态。**

读取以下文件，记住其中与 CustomAgent 相关的代码段（import、属性、方法、类型等），作为合并后验证的基准：

| 共享文件 | 需保留的 CustomAgent 代码段 |
|----------|--------------------------|
| `src/services/worker-service.ts` | import CustomAgent/isCustomSelected/isCustomAvailable; `private customAgent` 属性; 构造函数中 `new CustomAgent()`; `getAiStatus()` 中 custom provider 判断; customAgent 传入 SessionRoutes; `getActiveAgent()` 返回类型含 CustomAgent |
| `src/services/worker/http/routes/SessionRoutes.ts` | import CustomAgent/isCustomSelected/isCustomAvailable; 构造函数 customAgent 参数和属性; `getActiveAgent()` 中 custom provider 判断; agent registry 中 `'custom'` 条目 |
| `src/services/worker-types.ts` | `currentProvider` 联合类型包含 `'custom'` |
| `src/shared/SettingsDefaultsManager.ts` | `CLAUDE_MEM_CUSTOM_API_URL`, `CLAUDE_MEM_CUSTOM_API_KEY`, `CLAUDE_MEM_CUSTOM_MODEL`, `CLAUDE_MEM_CUSTOM_PROTOCOL`, `CLAUDE_MEM_CUSTOM_STREAMING`, `CLAUDE_MEM_CUSTOM_TIMEOUT_*` 设置项 |
| `src/shared/EnvManager.ts` | `CUSTOM_API_KEY` 在 `MANAGED_CREDENTIAL_KEYS` 和 `ClaudeMemEnv` 中 |
| `src/services/worker/agents/ResponseProcessor.ts` | `ProcessAgentResponseOptions` 中 `parseJsonObservation`/`parseJsonSummary` 字段; JSON 解析分支 |
| `src/sdk/parser.ts` | `parseObservationsJson()`, `parseSummaryJson()` 函数 |
| `src/sdk/prompts.ts` | `buildInitPromptJson`, `buildContinuationPromptJson`, `buildSummaryPromptJson`, `buildObservationPrompt` 中 JSON 格式段 |

**注意**：当前项目 `.gitattributes` **未配置** `merge=ours` 规则，CustomAgent 专有文件（`src/services/worker/CustomAgent.ts`、`tests/worker/custom-agent-*.test.ts`、`tests/worker/gemini-sse-parser.test.ts`）的留存依赖三路合并逻辑（上游删除时 git 通常会自动删除它们）。

**如果上游再次出现删除 CustomAgent 的风险**（v10.0.6、v12.3.8 都发生过），可在 `.gitattributes` 末尾追加以下规则以自动保留本地版本：
```
src/services/worker/CustomAgent.ts merge=ours
tests/worker/custom-agent-session.test.ts merge=ours
tests/worker/custom-agent-utils.test.ts merge=ours
tests/worker/custom-agent-history-truncation.test.ts merge=ours
tests/worker/gemini-sse-parser.test.ts merge=ours
```
并运行 `git config merge.ours.driver true` 激活 ours 合并驱动。

### 4. 获取上游最新代码

```bash
git fetch upstream
```

### 5. 确定上游分支

检查上游的默认分支（通常是 main 或 master）：
```bash
git remote show upstream | grep 'HEAD branch'
```

### 6. 查看上游变更

```bash
# 比较当前分支与上游分支的差异
git log HEAD..upstream/<branch> --oneline

# 查看详细变更
git diff HEAD..upstream/<branch> --stat
```

### 7. 执行合并

```bash
git merge upstream/<branch>
```

### 8. 处理合并冲突（如有）

如果出现冲突：

1. 使用 `git status` 查看冲突文件列表
2. 逐个处理冲突文件：
   - 读取文件内容，理解冲突
   - 保留必要的本地修改
   - 采用上游的新功能和修复
3. 标记冲突已解决：`git add <file>`
4. 完成合并：`git commit`

**冲突处理原则：**
- 优先保留上游的架构变更
- 保留本地的定制配置和功能（特别是 CustomAgent 相关代码）
- 如果不确定，询问用户

### 9. 验证 Fork 定制代码完整性（合并后）

**合并完成后，必须逐一验证步骤 3 中记录的所有 CustomAgent 代码段是否存活。**

对每个共享文件执行检查：

1. **读取合并后的文件**
2. **对照步骤 3 的快照**，确认每个 CustomAgent 代码段仍然存在
3. **如果某段代码缺失**：
   - 根据快照恢复缺失的代码段
   - 适配上游的新代码结构（如函数签名变化、import 路径调整等）
   - 确保恢复的代码能与上游新代码正确集成
4. **如果上游重构了共享文件的结构**（如拆分文件、重命名函数）：
   - 将 CustomAgent 代码迁移到新的位置/结构
   - 更新 import 路径和引用
   - 询问用户确认迁移方案

**验证清单**（逐项确认，全部通过才算完成）：

- [ ] `worker-service.ts`: CustomAgent import、属性、构造、路由注册、provider 判断
- [ ] `SessionRoutes.ts`: CustomAgent import、构造函数参数、agent registry
- [ ] `worker-types.ts`: `'custom'` 在 currentProvider 类型中
- [ ] `SettingsDefaultsManager.ts`: 所有 `CLAUDE_MEM_CUSTOM_*` 设置项
- [ ] `EnvManager.ts`: `CUSTOM_API_KEY` 相关条目
- [ ] `ResponseProcessor.ts`: JSON 解析选项和分支
- [ ] `parser.ts`: JSON 格式解析函数
- [ ] `prompts.ts`: JSON 格式 prompt 构建函数
- [ ] `CustomAgent.ts`: 文件完整，未被上游删除覆盖
- [ ] 所有 CustomAgent 测试文件完整

### 10. 重建 plugin/ 目录并恢复保护

```bash
# 重新构建项目
npm run build-and-sync

# 恢复 plugin/ 目录的 skip-worktree 保护（批量）
git ls-files plugin/ | xargs git update-index --skip-worktree --

# 验证保护已恢复
git ls-files -v plugin/ | grep '^S' | wc -l
```

### 11. 验证运行中的 Worker 版本

构建和同步完成后，确认当前运行的 worker 实例已加载最新代码：

1. **读取本地配置的 worker 端口**（不要硬编码，端口随 `settings.json` 或 UID 派生而不同）：
```bash
WORKER_PORT=$(jq -r '.CLAUDE_MEM_WORKER_PORT // empty' ~/.claude-mem/settings.json)
# 若 settings.json 未配置，回退到按 UID 派生的默认值 37700+(uid%100)
: "${WORKER_PORT:=$(printf '%d' $((37700 + $(id -u) % 100)))}"
```

2. **查询 worker 运行状态和版本**：
```bash
curl -s "http://localhost:${WORKER_PORT}/api/health" | head -c 500
```

3. **对比版本号**：从 `package.json` 读取当前代码版本，与 `/api/health` 返回的 `version` 字段对比
   - 如果版本一致：worker 已是最新
   - 如果版本不一致：`npm run build-and-sync` 应该已触发重启，等待几秒后重新检查
   - 如果仍然不一致：手动重启 worker

4. **确认 worker 健康**：检查 `/api/health` 返回的 `status` 字段为 `ok`

### 12. 提交信息格式

**默认合并（ort 自动成功、无手动干预）** — 按项目惯例使用 amend 修正 git 默认的 merge message：

```
Merge upstream changes (vX.Y.Z) with local modifications

- [合并摘要：关键 fix/feat、保留的本地定制]
```

参考近期合并：`7da8bb67`、`94bab50b`。

**如有手动恢复 CustomAgent 代码** — 追加一个独立提交：
```
fix: restore CustomAgent integration after upstream merge
```

## 故障排除

### 合并冲突过多

考虑使用 rebase 策略：
```bash
git rebase upstream/<branch>
```

**注意**：rebase 后仍需执行步骤 9 的验证清单。

### 构建失败

1. 检查编译错误
2. 比较依赖版本
3. 更新依赖：`npm install`
4. 检查 CustomAgent 代码是否因上游 API 变更而需要适配

### skip-worktree 状态检查

```bash
# 查看所有 skip-worktree 文件
git ls-files -v | grep '^S'

# 单个文件取消 skip-worktree
git update-index --no-skip-worktree <file>

# 单个文件设置 skip-worktree
git update-index --skip-worktree <file>
```

### CustomAgent 被上游删除

如果上游再次移除 CustomAgent 相关代码（如 v10.0.6、v12.3.8 那样）：
1. 专有文件（`CustomAgent.ts`、`tests/worker/custom-agent-*.test.ts` 等）在三路合并时通常不会被上游的 delete 传播过来（除非 merge base 中这些文件已存在）——合并后用 `ls` 确认仍在；若被删除，从上一次提交 `git checkout HEAD~1 -- <file>` 恢复
2. 为避免下次再踩坑，按步骤 3 提示在 `.gitattributes` 配置 `merge=ours` 规则
3. 共享文件需按步骤 9 的验证清单检查，必要时从步骤 3 的快照手动恢复
4. 确认恢复后运行完整测试套件

## 完成后

**向用户提供合并总结**，包括：
- 合并的提交数量和 commit hash
- 根据合并的代码总结变更内容
- 如有冲突，说明冲突解决方式
- **CustomAgent 代码完整性验证结果**（全部通过 / 哪些需要手动恢复）
- 确认 plugin/ 目录 skip-worktree 保护已恢复
- **Worker 版本验证结果**（版本号是否一致、健康状态）
