# Codex 与 Claude 共用 merge-claude-mem Skill

## 根因

Codex 与 Claude Code 使用不同的仓库级 Skill 发现目录。复制 `SKILL.md` 会形成两个权威源，后续修改必然漂移。

## 设计

- 保留 `.claude/skills/merge-claude-mem/` 为唯一真实目录，`SKILL.md` 为唯一源文件。
- 创建 `.agents/skills/merge-claude-mem` 相对符号链接，目标为 `../../.claude/skills/merge-claude-mem`。
- 保留 Skill 名称 `merge-claude-mem`，仅调整 frontmatter 与正文中依赖客户端身份的措辞，使 Codex 和 Claude Code 都能触发并执行同一流程。
- 不添加副本、包装文件、脚本或额外元数据。

## 行为与失败处理

Claude Code 从 `.claude/skills` 读取真实目录；Codex 从 `.agents/skills` 进入同一目录。若链接失效或目标不是同一文件，验证必须失败，不得创建第二份 `SKILL.md` 兜底。

## 验证

- 校验链接存在、使用相对目标且最终解析到真实 Skill 目录。
- 通过两个入口读取并比较同一个 `SKILL.md`。
- 校验 YAML frontmatter、Skill 名称和描述。
- 检查 Git diff，确认未改动用户已有的 `.gitignore` 修改及其他无关文件。

本改动只涉及文档与目录发现，不新增可测试的运行时行为；不添加单元测试。
