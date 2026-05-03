<claude-mem-context>
# Memory Context

# [claude-mem] recent context, 2026-05-02 5:19pm GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (6,533t read) | 1,019,558t work | 99% savings

### Apr 26, 2026
S9 完成并总结 v12.4.5 合并，确认本地修改与上游变更正确合并。 (Apr 26 at 8:59 AM)
S10 汇总上游 v12.4.7 合并、插件重建同步、以及 worker 健康状态确认的进展。 (Apr 26 at 10:05 AM)
S19 分析 git push 后的 GitHub 大文件警告并给出修复建议。 (Apr 26 at 1:51 PM)
S29 合并上游主线到本地分支并完成推送，同时确认合并内容与运行状态。 (Apr 26 at 5:25 PM)
### Apr 28, 2026
S61 用户询问在Codex中使用CustomAgent时未生成session summary是否是模型的问题 (Apr 28 at 3:53 PM)
### Apr 30, 2026
S62 在本地管理Web界面的Setting页面添加CustomAgent相关参数配置，包括CLAUDE_MEM_PROVIDER的CustomAgent选项 (Apr 30 at 8:58 AM)
S63 在本地管理Web界面的Setting页面添加CustomAgent相关参数配置，包括CLAUDE_MEM_PROVIDER的CustomAgent选项 (Apr 30 at 8:59 AM)
S67 执行 /merge-claude-mem 命令，将上游 v12.4.9 合并到本地 Claude-Mem 项目 (Apr 30 at 9:01 AM)
S123 将CLAUDE_MEM_LOG_LEVEL选项添加到http://localhost:37701设置界面的Advanced部分 (Apr 30 at 9:41 AM)
### May 1, 2026
4218 2:52p 🔵 SettingsRoutes实际路径定位成功
4219 " 🔵 SettingsRoutes白名单确认LOG_LEVEL已包含
4220 " 🟣 前端Settings接口添加LOG_LEVEL类型定义
4221 2:53p 🟣 settings.ts添加LOG_LEVEL默认值
4222 " 🟣 useSettings钩子添加LOG_LEVEL状态管理
4223 " 🟣 ContextSettingsModal添加Log Level下拉菜单
4225 " ✅ claude-mem插件构建和同步完成
4224 " 🟣 CLAUDE_MEM_LOG_LEVEL选项添加到设置界面
4227 2:54p 🔵 claude-mem项目最近提交历史
4228 " 🟣 CLAUDE_MEM_LOG_LEVEL设置选项代码变更统计
4229 " 🔵 claude-mem工作树状态检查
4230 " 🟣 CLAUDE_MEM_LOG_LEVEL功能已提交到版本控制
4231 2:55p 🟣 CLAUDE_MEM_LOG_LEVEL功能已推送到远程仓库
S124 将CLAUDE_MEM_LOG_LEVEL选项添加到http://localhost:37701设置界面的Advanced部分 (May 1 at 2:55 PM)
### May 2, 2026
5926 5:17p 🔵 Claude-Mem会话隔离机制
5927 " 🔵 Superpowers技能系统架构
5928 " 🔵 Claude-Mem代码库架构分析
5932 " 🔵 Claude-Mem平台隔离机制详解
5934 " 🔵 Claude-Mem核心文件结构
5935 " 🔵 平台源标准化逻辑
5936 " 🔵 会话创建与平台隔离实现
5937 " 🔵 SessionSearch搜索架构
5939 " 🔵 SearchRoutes搜索API架构
5940 " 🔵 SessionSearch搜索实现细节
5941 " 🔵 SearchManager搜索编排架构
5942 " 🔵 SearchOrchestrator策略选择与回退机制
5943 " 🔵 SQLiteSearchStrategy实现细节
5945 " 🔵 SearchManager搜索路径与时间线构建
5947 " 🔵 SearchOrchestrator参数规范化
5948 " 🔵 ChromaSearchStrategy向量搜索实现
5950 " 🔵 ChromaSync向量数据库同步机制
5951 5:18p 🔵 ChromaSync回填与水印机制
5953 " 🔵 platform_source实现Claude/Codex会话隔离
5955 " 🔵 platform_source跨平台会话隔离架构
5957 " 🔵 SessionStore Web UI数据查询方法
5958 " 🔵 getObservationsByIds多维度过滤实现
5959 " 🔵 混合搜索的数据库查询方法
5961 " 🔵 PaginationHelper分页查询与路径清理
5963 " 🔵 TranscriptEventProcessor转录事件处理架构
5965 " 🔵 TranscriptEventProcessor工具配对与安全机制
5967 " 🔵 session-init处理器会话初始化流程
5969 " 🔵 平台源隔离与语义搜索架构
5971 " 🔵 SearchRoutes上下文注入与语义搜索端点
5972 " 🔵 SearchManager最近上下文查询实现
5974 " 🔵 上下文注入与用户消息处理器
5975 " 🔵 数据库平台源分布统计
**5977** 5:19p 🔵 **claude-mem项目平台数据分布**
用户查询了claude-mem项目在不同平台的数据分布。claude-mem项目在claude平台有11个会话、14个摘要、295个观测。在codex平台有2个会话、1个摘要、92个观测。claude平台的观测数量是codex平台的3倍多，摘要数量是14倍。两个平台的数据都通过platform_source字段正确隔离。
~105t 🔍 25,729

**5979** " 🔵 **平台源标准化逻辑**
用户查看了platform-source.ts的实现。DEFAULT_PLATFORM_SOURCE默认值为'claude'。sanitizeRawSource将输入转换为小写并用连字符替换空格。normalizePlatformSource将'transcript'映射为'codex'，将包含'codex'、'cursor'、'claude'的输入分别映射为对应标准值。sortPlatformSources按优先级排序：claude > codex > cursor。
~157t 🔍 27,287

**5980** " 🔵 **会话创建平台源冲突检测**
用户查看了create.ts的实现。createSession函数检查现有会话的platform_source字段。如果现有会话的platform_source为空，则更新为新值。如果现有会话的platform_source与新值不同，则抛出Platform source conflict错误。memory_session_id初始为NULL，由SDKAgent从第一个SDK响应中捕获。memory_session_id不能等于contentSessionId，否则会注入内存消息到用户转录中。
~136t 🔍 6,701

**5981** " 🔵 **ChromaDB搜索策略项目过滤**
用户查看了ChromaSearchStrategy.ts的实现。buildWhereFilter方法构建ChromaDB where过滤器。文档类型过滤器包括observation、session_summary、user_prompt。当指定project时，将project过滤器与docTypeFilter组合为$and条件。向量搜索按项目范围限定，防止大项目主导top-N结果。post-hoc SQLite项目过滤器在向量搜索后生效。
~126t 🔍 8,379

**5982** " 🔵 **ChromaDB查询结果去重机制**
用户查看了ChromaSearchStrategy.ts的实现。ChromaSync.queryChroma()返回去重的ids（唯一的sqlite_ids），但metadatas数组可能包含每个sqlite_id的多个条目。一个observation可以有narrative和多个facts作为单独的Chroma文档。90天窗口过滤器用于按时间过滤结果。
~103t 🔍 9,644


Access 1020k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>