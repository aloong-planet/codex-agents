# 微信 Codex 权限三档与首次向导设计审查

日期：2026-08-13

审查对象：`docs/weixin-permission-onboarding-design.md`

## 结论

设计可以进入实现，但必须保持“高级受控仍是受控能力集合”，不能在实现时为了兼容任意 skill
偷换成 `workspaceWrite` 或 `dangerFullAccess`。核心 seam 是 `PermissionCenter` 与
`GuardedFileMutation`：前者统一冻结策略、持久化和降权，后者让文件变更只有 create/update 两种
可验证行为，从结构上消除 delete/move 的入口。

## 审查发现与修正

1. **原始 `workspaceWrite` 与“始终禁止删除”矛盾。** filesystem write 无法只排除删除；三档均改成
   read-only sandbox，变更只走 guarded mutation。
2. **原始 shell 网络与“高风险始终禁止”矛盾。** 即使文件只读，`curl -X DELETE` 一类命令仍能
   产生外部副作用；网络收敛成内置搜索和 GET-only 工具，UI 必须使用“只读网络检索”措辞。
3. **第三档不能命名为“完全访问”。** 最终名为“高级受控”，差异是安全 mutation 是否需要本地
   二次批准，不代表完整磁盘或任意外部操作权限。
4. **只在 thread/start 设置权限会复用旧默认。** 每个 turn 必须显式传 frozen policy；测试要恢复
   一个旧 thread 并证明新设置仍生效。
5. **升级与降级不能同样延迟生效。** 升级下一 turn 生效；降级先保存新 revision、取消 pending、
   interrupt 旧 turn，避免撤销按钮只是视觉状态。
6. **中断不等于回滚。** atomic rename 已完成时必须记录真实完成，不自动恢复或声称未写；快照用于
   审计和显式恢复。
7. **向导默认选中会构成静默授权。** 可以视觉推荐增强受控，但用户必须点击卡片并在最终页提交；
   关闭向导保持 fail closed。
8. **iframe 目录选择器不能可靠返回本机绝对路径。** 第一版只展示后台预登记候选 roots；不使用
   `webkitdirectory` 伪装系统授权。任意目录新增另做设计。
9. **完整路径不能进入模型上下文。** `structuredContent` 只返回 root ID/别名/数量；完整路径仅在
   本地网页或组件私有 `_meta` 显示。
10. **旧写开关不能兼容映射到增强模式。** v2 `vaultWriteEnabled` 无法表达新的网络、审批和 roots
    语义，迁移必须回到未 onboarding 的 safe 状态。
11. **待审批不能只保存在前端。** 权威 pending 位于后台并绑定 permission revision、thread、turn、
    target hash、roots 和 expected file hash；前端刷新后仍可读取同一待审批。
12. **pending 不能跨进程自动恢复。** 重启后原 context token、active turn 和 filesystem 前提可能
    已变；统一 expired，不自动执行或发送。
13. **审批时必须重新校验。** 从 proposal 到点击批准之间，root、文件 hash 或权限 revision 都可能
    改变；批准不能直接复用旧布尔结果。
14. **快照失败必须在任何写之前。** “先写后补快照”会制造不可恢复窗口；批次需全部预检、快照
    成功后才能开始 atomic writes。
15. **多文件批次并非真正跨文件原子。** 多次 rename 中途进程崩溃可能部分完成；implementation
    必须落 write-ahead journal，重启时只报告 partial，不自动补写或回滚。
16. **skills/plugins 继承能力不能等同于继承副作用权限。** Codex 可以加载 skill/MCP，但需要原生
    写沙箱或第三方 mutation 的能力会失败；UI 和微信回复必须诚实说明。
17. **Plugin 安装不能被描述为部署后台。** 首次向导依赖已运行的 4317 服务；不可达时只给启动
    说明，不自启第二实例。
18. **旧 app-only tools 不能继续改状态。** 保留一个兼容周期只返回迁移提示，防止旧面板缓存绕过
    新的 onboarding。
19. **模式变更不能泄漏到正在排队的微信消息。** 每条入站 job 在真正开始 turn 时捕获 revision；
    已排队但未开始的消息使用最新策略，active turn 使用冻结策略直到完成或被降权中断。
20. **高风险本地配置要在 root 选择阶段阻止。** 用户不能选择 `/`、home、`.codex`、`.openclaw`
    根、私有状态和插件缓存；只允许预登记的 `codex-weixin` 项目目录，不能向父级扩张。
21. **官方文档能力不等于当前 binary 已支持。** 当前 `0.147.0-alpha.6.5` schema 缺少 restricted
    read 字段；实现必须先 capability probe。缺字段时禁用向导提交，不能用 `runtimeWorkspaceRoots`
    冒充读取隔离。
22. **skills/plugins 的运行资源也是读取面。** 用户数据 roots 与 internal runtime roots 必须分开；
    后者只读、固定、在 UI 披露，任意 MCP 外部副作用仍不自动批准。

## 测试审查要求

- migration 测试必须以真实 v2 JSON 输入，证明 `vaultWriteEnabled=true` 不扩大权限，同时 thread 与
  transcript 不丢失。
- mode matrix 测试断言三档都发送 restricted `readOnly`、shell network false，且 safe 无 mutation、
  guarded 产生 pending、advanced 自动执行。
- capability 测试用两份真实 schema fixture：当前缺字段版本必须阻止 onboarding，支持字段版本才能
  生成 restricted policy；不能只 mock 一个布尔值而跳过 schema 解析。
- resume 测试必须让旧 thread 带不同默认 sandbox，并断言每个新 turn 仍显式覆盖。
- destructive 测试覆盖 delete、rename、move、hidden path、symlink、hardlink、chmod、绝对路径、`..`、
  root replacement 和外部编辑冲突。
- 多文件测试注入第二次 rename 崩溃，断言 journal 为 partial，既不假通过也不自动重放。
- approval race 测试使用 barrier 覆盖 approve vs downgrade、approve vs external edit、timeout vs approve；
  只能有一个终态。
- downgrade 测试断言 pending 被取消、`turn/interrupt` 发出，且新 turn 使用新 revision。
- redaction 测试搜索 HTTP state、MCP content/structuredContent、transcript、日志，不得出现绝对 root、
  文件正文、token、二维码源 URL 或私有状态路径。
- Plugin UI E2E 覆盖首次向导、关闭不授权、提交反馈、设置页降权、pending approve/decline；组件仍不得
  直接 fetch 4317。
- fixture E2E 只使用临时 roots，不读取真实 Vault、不连接腾讯、不发送真实微信。
- 真实微信/Vault 验证留给用户在场步骤，`ret=0` 只记渠道接受。

## 开工前门禁

1. 当前分支 `codex/weixin-voice-input` 含尚未进入 master 的依赖成果；实现前先确定安全基线，再创建
   `codex/weixin-permission-onboarding`，不得 reset/stash 用户工作树。
2. 从本机 App Server schema 固定本功能使用的 `turn/start` 与 `turn/interrupt` 字段 fixture；当前
   restricted read 缺失是已知门禁，不得在实现报告中隐去。
3. 先实现 v3 store 与 fixture candidate roots，不先触碰真实目录。
4. 当前 4317 服务不手动重启；watch 若自动 reload，先确认没有中断真实 iLink 监听。
5. 实现完成后按 plugin-creator 流程运行 validator、cachebuster helper、从实际 local marketplace
   重装，并在新 task 打开面板。
6. 未完成用户在场的真实删除拒绝与创建验证前，不声称手机链路完整验收。

## 审查后的实施顺序

1. v3 状态迁移、schema capability probe 与 fail-closed onboarding。
2. `PermissionCenter` + 每 turn frozen restricted-read policy（仅在能力存在时启用）。
3. `GuardedFileMutation` + snapshot/hash/journal。
4. guarded pending approval 与降权 interrupt。
5. 本地网页和 Plugin 首次向导/设置页。
6. 代码 review、测试 review、design 回同步。
7. plugin cachebuster/reinstall/new-task 验证，再由用户完成真实微信验证。
