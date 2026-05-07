详细规范见 `CLAUDE.md`

<claude-mem-context>
# Memory Context

# [claude-mem] recent context, 2026-05-07 1:36pm GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (6,479t read) | 621,144t work | 99% savings

### May 7, 2026
S364 修复合并上游后 .mcp.json 失效、导致 Claude Code 无法使用的问题 (May 7 at 8:26 AM)
S366 修复 claude-mem 的 MCP 工具不可用问题，并确认插件状态恢复 (May 7 at 8:36 AM)
S367 排查 Claude Code 2.1.131 中插件 claude-mem 的 MCP server 启动失败，确认 `CLAUDE_PLUGIN_ROOT` 的注入与 `.mcp.json` 路径写法并修复配置。 (May 7 at 8:44 AM)
S368 清理一下 worktree (May 7 at 8:54 AM)
S369 清理一下 worktree (May 7 at 8:58 AM)
S375 合并上游 claude-mem v12.7.3 并保留本地修改，同时验证 CustomAgent、MCP 启动与工作区配置是否正常。 (May 7 at 9:00 AM)
8096 10:16a ✅ AGENTS.md 处于未提交修改状态
8098 10:17a ✅ AGENTS.md 本地修改已暂存到 stash
8101 " ✅ 恢复了 plugin/ 目录到 Git 版本
8106 10:18a 🔵 EnvManager.ts 处理 CUSTOM_API_KEY 的路径已确认
8109 10:19a 🔵 上游 .gitattributes 强制 plugin 脚本使用 LF
8110 " 🔵 合并基点的 .gitattributes 与上游一致
8112 10:20a ✅ 合并 upstream/main 时暴露出两个冲突文件
8113 " 🔵 合并状态显示两处未解决冲突
8119 10:21a 🔵 SessionStore.ts 冲突集中在 pending 消息列策略
8123 " 🔵 SessionStore.ts 合并冲突揭示 pending_messages 架构分歧
8127 10:22a 🔵 schema.sql 已转向 tool_use_id 唯一键与遗留列弃用
8135 10:24a 🔵 PendingMessageStore.ts 已在本地扩展到与 HEAD 同等规模
8139 " 🔵 merge-base 引用展开错误暴露了 shell 参数陷阱
8141 10:25a 🔵 merge-base 版 PendingMessageStore.ts 只有 147 行
8142 10:26a 🔵 SessionStore.ts 冲突确认为两套 schema 迁移方案互斥
8143 10:27a 🔵 SessionStore.ts 已集成 tool_use_id 迁移钩子
8144 10:28a 🔵 tool_use_id 迁移先补列再清理重复记录
8145 10:29a 🔵 HEAD 版本保留 dead pending_messages 自愈列
8148 10:30a 🔴 SessionStore 初始化改为保留 dead 列并补充 tool_use_id
8149 " 🔵 resolveDataDir 被导出脚本用于定位 settings.json
8150 10:31a ✅ resolveDataDir 已导出给共享路径模块
8154 10:32a ✅ 已暂存 SessionStore 与路径模块冲突解决结果
8157 10:33a ✅ 合并上游 v12.7.3 并保留本地修改
8158 10:36a ✅ 重新应用 plugin 目录的 skip-worktree 标记
S376 检查 OpenRoute、Gemini 与 Custom 对 PendingMessageStore 的处理差异，判断 Custom 是否需要同步更新。 (May 7 at 10:38 AM)
8159 10:43a 🔵 PendingMessageStore 关联面较广
8160 10:44a 🔵 PendingMessageStore 覆盖整个会话队列链路
8161 10:46a 🔵 CustomAgent 体量显著大于其他 provider
8162 " 🔵 CustomAgent 复用与 OpenRouter/Gemini 相同的基础依赖
8163 10:47a 🔵 三条 provider 都通过同一消息迭代器消费会话
8164 " 🔵 CustomAgent 直接依赖 message._persistentId
8165 10:48a 🔵 CustomAgent 用同一队列迭代器处理 observation 和 summarize
8166 " 🔵 OpenRouter 也复用同一消息处理契约
8167 " 🔵 Gemini 对空响应选择保留队列
8168 10:49a 🔵 PendingMessageStore 在完成与重置路径被统一消费
S377 判断本地 PendingMessageStore 是否可以直接同步上游 schema 变更，并确认 Custom 是否需要跟着更新。 (May 7 at 10:50 AM)
8169 10:52a ✅ 检索到可用观察工具
8170 10:53a 🔵 SessionStore 自愈 pending_messages 死列
8171 10:54a 🔵 PendingMessageStore 依赖死列驱动重试与失败收尾
S378 处理合并上游后 Claude Code 报错的 mcp 冲突问题，并把修复经验写入项目记忆。 (May 7 at 10:55 AM)
8172 10:58a 🔵 mcp-search 启动配置定位脚本
8173 " 🔵 安装插件中未发现 mcp-search 配置
8174 " 🔵 项目根已内置自定位 MCP 启动配置
8175 10:59a 🔵 .mcp.json 被忽略且有独立修复历史
8176 11:00a 🔵 根目录与插件 .mcp.json 完全一致
8177 11:01a 🔵 删除 .mcp.json 未实际生效
8178 " ✅ 项目根 .mcp.json 已删除
8179 11:02a 🔵 项目记忆记录了 plugin 构建产物策略
**8180** " ✅ **新增 MCP 根配置冲突修复说明**
新增的反馈文档把这次合并后的 MCP 冲突固化为可复用的操作说明：由于上游修复使插件版和项目根的 `.mcp.json` 完全同构，Claude Code 会在同时加载两者时去重并报错。文档说明项目根 `.mcp.json` 属于本地开发文件，删除不会影响仓库，同时补充了 zsh `rm -i` 交互陷阱与绕过方式，方便后续合并上游时快速恢复可用的 `mcp-search`。
~135t 🛠️ 13,675

**8181** 11:03a ✅ **MEMORY.md 增补 mcp 根配置冲突条目**
项目记忆文件已更新，把这次合并后出现的 MCP 冲突和处理方法纳入长期知识库。新增条目将根 `.mcp.json` 与插件版 `mcp-search` 的重复问题明确关联起来，便于后续每次合并上游后快速定位并恢复插件版服务注册。
~116t 🛠️ 6,419

**8182** 11:07a 🔵 **mcp-search 配置文件位置定位到 plugin 目录**
本次检查确认了 mcp-search 相关配置文件并不是按“仓库根目录固定路径”被直接定位到的，实际可见的配置文件位于 plugin/.mcp.json。与此同时，对仓库根路径的直接访问返回不存在，说明加载位置可能依赖插件目录或安装后的插件结构，而不是单一固定根路径。
~121t 🔍 3,874

**8183** " 🔵 **mcp-search 通过动态探测定位插件根目录**
观察到 mcp-search 的配置并不依赖单一固定安装路径，而是在 .mcp.json 的 command 里用 shell 脚本动态解析插件根目录。该脚本优先考虑环境变量和当前工作目录，同时兼容 Codex/Claude 的缓存目录与 marketplace 安装目录，最终定位到包含 scripts/mcp-server.cjs 的位置后再执行 node 启动 MCP 服务。这种机制让同一插件能在开发目录、市场安装目录和缓存版本目录下复用同一份启动逻辑，降低路径漂移带来的故障风险。
~183t 🔍 6,383

**8184** 11:08a 🔵 **marketplace 配置指向 claude-mem 插件源**
观察到 thedotmack marketplace 的插件清单把 claude-mem 固定到 12.7.3，并通过 source: ./plugin 指向 marketplace 包内部的 plugin 目录。结合此前的 .mcp.json 检查，可以判断 mcp-search 的启动配置实际跟随 marketplace 包中的插件内容分发，而不是通过独立的顶层配置项暴露在 marketplace.json 里。这说明插件安装与 MCP 配置是分层管理的：marketplace.json 负责插件来源与版本，plugin/.mcp.json 负责运行时启动逻辑。
~170t 🔍 7,805

S379 确认 mcp-search 从哪里加载，以及路径是否固定 (May 7 at 11:08 AM)
**Investigated**: 检查了仓库内 plugin/.mcp.json、根目录 .mcp.json、~/.claude/plugins/marketplaces/thedotmack/.claude-plugin/marketplace.json、~/.claude/plugins/marketplaces/thedotmack/.mcp.json、~/.claude/plugins/marketplaces/thedotmack/plugin/.mcp.json，以及 ~/.claude/plugins/cache/thedotmack/claude-mem/12.7.3/.mcp.json

**Learned**: mcp-search 的注册入口位于 marketplace 解析后的 ~/.claude/plugins/marketplaces/thedotmack/plugin/.mcp.json；marketplace.json 只负责声明 claude-mem 版本 12.7.3 和 source=./plugin；.mcp.json 里不是写死路径，而是用 sh -c 按环境变量、当前目录、Codex 缓存目录和 Claude 配置目录动态查找 scripts/mcp-server.cjs；项目根目录的 .mcp.json 不参与当前加载链路

**Completed**: 明确了 mcp-search 的实际加载来源和运行时路径解析机制，并确认当前生效路径来自 marketplace 安装目录而非仓库根目录

**Next Steps**: 继续跟进 CLAUDE_PLUGIN_ROOT 与版本缓存的实际注入效果，必要时验证不同安装形态下会命中哪个 scripts/mcp-server.cjs


Access 621k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>