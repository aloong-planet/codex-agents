# 微信 Codex 权限三档与首次向导设计

日期：2026-08-13

## 2026-08-14 实现同步

当前已完成并验证的是第一、二阶段安全底座：v3 状态迁移、真实 App Server schema capability
probe、能力不足时 fail closed、本地网页与 Plugin 共用的三档向导、模型状态与本地路径分层脱敏，
以及每个 `turn/start` 显式携带冻结的 restricted-read policy。每个 turn 还会重新验证候选 root、
`lstat` 与 `realpath`；目录被替换或持久化路径与当前候选不一致时，该 turn 拒绝执行。

当前安装的 `codex-cli 0.147.0-alpha.6.5` 仍缺少 restricted readable roots，因此真实环境下向导
提交保持禁用。`GuardedFileMutation`、增强受控的 pending approval、高级受控的自动安全 mutation
与降权 interrupt 尚未进入实现；在这些能力完整并通过本设计的破坏性/race 测试前，不能把测试
fixture 中的可提交向导描述成真实可用的文件修改权限。

## 目标与已确认决策

为独立微信 Codex 服务增加首次权限向导和可随时调整的三档模式。用户已确认：

- 默认选择“增强受控”；
- 只访问用户选择的目录；
- 授权能力中的网络检索始终可用；
- 删除与高风险本地文件操作始终禁止；
- 首次打开 Codex Plugin 面板时显示向导；
- 第三档定义为“高级受控”，不启用 `dangerFullAccess`。

完成标准：

1. 未完成向导时 fail closed，只能聊天、扫码和查看状态，不能获得新增本地权限。
2. Plugin 面板与 `http://127.0.0.1:4317/` 使用同一份权威权限状态。
3. 每个微信 turn 都显式携带当时冻结的权限策略，不依赖 thread 创建时的旧默认值。
4. 用户可随时降权；降权会取消待审批操作并中断正在执行的相关 turn。
5. 三档均不使用 `dangerFullAccess`、`thread/shellCommand` 或 `process/*`。
6. 删除、重命名、批量移动、符号链接写入、敏感路径写入和冲突覆盖不进入执行层。
7. 旧 `vaultWriteEnabled=true` 不自动迁移成新权限，升级后仍要求完成向导。

## 已确认事实

### 当前实现

- `CodexConversation.startOrResume()` 在 thread 创建时固定传入
  `approvalPolicy: "untrusted"` 和 `sandbox: "read-only"`，但 `turn/start` 只传正文，无法让
  设置变更在下一条微信消息生效（`src/codex-conversation.ts:54-68, 164-167`）。
- `NativeWriteGuard` 当前只有一个布尔开关；成功请求会把两个固定根目录整体授予当前 turn，
  且网络固定关闭（`src/native-write-guard.ts:20-62`）。
- `CodexConversation` 当前拒绝 command、file change、patch、exec 和交互请求；只有统一 permission
  request 可进入 guard（`src/codex-conversation.ts:268-322`）。
- `codex-service.json` v2 只持久化 `vaultWriteEnabled`，没有向导、档位、根目录、策略 revision 或
  待审批状态（`src/codex-service-store.ts:17-30, 120-143`）。
- 本地 HTTP 已有 same-origin POST 门禁，适合承载配置写入；当前没有权限配置路由
  （`src/http-server.ts:86-165`）。
- Plugin 面板当前只提供“允许/关闭本地文件写入”，并通过 app-only MCP tool 代理到 4317；
  没有首次向导或目录配置。

### App Server 协议

- `turn/start` 支持逐 turn 覆盖 `sandboxPolicy`；覆盖值会成为该 thread 后续 turn 的默认值，因此
  客户端仍必须在每个 turn 明确发送策略，避免恢复旧 thread 时继承过期权限。
- `readOnly` sandbox 支持 restricted readable roots 和独立的 `networkAccess`。
- `workspaceWrite` 的 writable roots 允许一般写入，无法只从权限层排除删除；因此本设计不把
  `workspaceWrite` 作为“始终禁止删除”的实现。
- `thread/shellCommand` 和 `process/*` 在 sandbox 外执行，官方要求只用于用户明确发起的本地操作；
  微信自然语言不能充当该级别的本地确认，本功能禁止调用这两类接口。
- `turn/interrupt` 可用于用户降权时终止活跃 turn。
- 当前安装的 `codex-cli 0.147.0-alpha.6.5` 生成 schema 中，`readOnly` 只有
  `networkAccess`，尚没有官方文档所述的 `access.restricted/readableRoots`。因此当前版本不能
  证明 shell 只读取用户所选目录；`runtimeWorkspaceRoots` 不能当作安全隔离字段。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。实现前还要用当前安装的
`codex app-server generate-json-schema` 锁定实际字段 fixture，文档示例不能代替本机 schema。

### 版本能力门禁

`PermissionCenter` 启动时必须从随服务使用的 Codex binary 生成/读取协议能力，并产生
`restrictedReadSupported`。只有 schema 同时支持以下结构时才允许完成权限向导：

```ts
{
  type: "readOnly",
  access: {
    type: "restricted",
    includePlatformDefaults: true,
    readableRoots: [/* selected roots + internal runtime roots */],
  },
  networkAccess: false,
}
```

当前 binary 的 `restrictedReadSupported=false`，因此设计完成不代表三档现在可以安全启用。实现时
必须 fail closed：向导显示“当前 Codex 版本不支持严格目录隔离”，禁止提交档位，也不能退化成
full-read 的假目录选择。二维码、微信连接、目标同步和现有聊天状态仍可查看。

推荐等待/切换到生成 schema 已包含 restricted read 的 Codex binary。另一条路线是在 App Server
外再做 macOS Seatbelt 与隔离 CODEX_HOME；它会牵涉认证、skills/plugins、session 存储和子进程继承，
不属于本设计的窄范围，不能作为静默 fallback。

## 安全承诺的精确定义

“始终禁止删除与高风险操作”在第一版指本机文件和 Demo/Codex 配置：

- 禁止删除、重命名、移动、chmod/chown、符号链接、硬链接、设备文件和 FIFO；
- 禁止写 `.git`、`.obsidian`、`.codex`、`.openclaw`、`.env*`、凭据、私有状态、插件缓存、
  `node_modules`、构建输出和隐藏路径；
- 禁止越过已授权 canonical roots；
- 禁止在文件已被外部修改时覆盖；
- 禁止修改 OpenClaw/Codex 全局配置或凭据。

本承诺不扩展为“任意联网命令绝无外部副作用”。原始 shell 网络可调用第三方写接口，无法仅靠
本地路径沙箱证明安全。因此三档中的“网络始终可用”实现为：

- Codex 内置 `web_search=live`；
- 受控的只读 HTTP GET 检索工具；
- 不向 App Server 原始 shell 开放网络。

若以后必须开放原始 shell 网络，需要另行设计域名、方法、凭据和外部副作用策略，不能悄悄扩大
本设计的含义。

## 三档模式

| 档位 | 本地读取 | 文件创建/修改 | 执行命令 | 网络 | 本地确认 |
| --- | --- | --- | --- | --- | --- |
| 安全只读 `safe` | 仅授权 roots | 禁止 | 只读 sandbox 命令 | 内置搜索 + 受控 GET | 不需要 |
| 增强受控 `guarded_plus` | 仅授权 roots | 只允许非破坏性变更 | 只读 sandbox 命令 | 内置搜索 + 受控 GET | 每个变更批次需在本地面板确认 |
| 高级受控 `advanced_controlled` | 仅授权 roots | 只允许非破坏性变更 | 只读 sandbox 命令 | 内置搜索 + 受控 GET | 符合规则的变更自动执行 |

共同不变量：

- `sandboxPolicy.type` 始终为 `readOnly`，read access restricted 到本次选择的 canonical roots 和
  macOS platform defaults；`networkAccess=false`。
- 三档均不授予原始 filesystem write，不使用 `workspaceWrite` 或 `dangerFullAccess`。
- 文件变更只经过 `GuardedFileMutation` 深模块；caller 无法直接取得文件描述符或 root 绝对路径。
- skills/plugins 可以被 Codex 发现和推理，但其本地副作用仍受上述 sandbox；要求任意原生写权限
  的 skill 会诚实失败，不能静默扩权。
- MCP/connector 的外部写副作用不由本地文件 guard 覆盖；第一版拒绝需要额外 elicitation 或
  外部 mutation approval 的调用。

“仅授权 roots”指用户数据 roots。为启动模型、加载明确安装的 skills/plugins 及运行基础命令，
adapter 还需要一组只读的 internal runtime roots；这些 roots 固定来自 Codex binary、专用 session
目录和已安装包清单，不能由网页输入，也不能获得写权限。向导最终页必须单独披露“应用运行资源
只读”，不能把它们伪装成用户数据目录。任意本地 MCP 进程仍可能拥有自己的进程权限，因此第一版
不自动批准其写操作。

## 架构与 seam

```text
Plugin panel / Local web page
              |
              v
PermissionCenter  <----> PermissionStore (0600, atomic)
    |       |
    |       +----> selected-root validation + public redaction
    |
    +----> AppServerPolicyAdapter ----> turn/start sandboxPolicy
    |
    +----> GuardedFileMutation -------> snapshot + create/update only
    |              |
    |              +----> PendingApprovalQueue (guarded_plus)
    |
    +----> ReadOnlyFetch -------------> GET-only network retrieval
```

### `PermissionCenter` 深模块

外部 interface：

```ts
interface PermissionCenter {
  publicState(): PublicPermissionState;
  configure(input: PermissionSelection): Promise<PermissionRevision>;
  policyForTurn(): FrozenTurnPolicy;
  decide(operation: ProposedOperation): Promise<OperationDecision>;
  resolvePending(id: string, decision: "approve" | "decline"): Promise<void>;
}
```

implementation 隐藏状态迁移、realpath 校验、root 去重、模式映射、策略 revision、待审批生命周期、
敏感路径规则和公开状态脱敏。调用者与测试都只跨这一 seam。

### `GuardedFileMutation` 深模块

只暴露两类 mutation：

```ts
type Mutation =
  | { type: "create"; rootId: string; relativePath: string; content: string }
  | { type: "update"; rootId: string; relativePath: string; expectedSha256: string; content: string };

interface GuardedFileMutation {
  propose(turn: FrozenTurnPolicy, mutations: Mutation[]): Promise<MutationOutcome>;
}
```

implementation 必须：

1. 用 root ID 解析服务器端 canonical root，不接受绝对目标路径；
2. 拒绝 `..`、绝对路径、隐藏段、符号链接和非普通文件；
3. update 要求 expected hash，外部编辑后 fail closed；
4. 写前建立私有快照；快照失败则不写；
5. 同一批次全部预检后再执行，任何一项失败则整个批次不开始；
6. 使用同目录临时文件 + fsync + atomic rename；
7. 返回相对路径、before/after hash 和真实结果，不返回正文或绝对路径给模型状态。

目录创建仅作为 create 的父目录准备工作；只能创建缺失的普通目录，不能删除、重命名或移动。

### App Server adapter

- thread 创建/恢复仍加载同一组允许的 skills/plugins，但不把模式永久固化在 thread metadata。
- 每个 `turn/start` 都传 `FrozenTurnPolicy.sandboxPolicy`、approval policy、cwd 和 runtime roots。
- 新 thread 只注册 `guarded_file_mutation` 与 `readonly_http_get`；resume 时核对持久化 tool profile
  版本，不匹配就创建新 thread，避免依赖当前 binary schema 未公开的 resume 动态工具覆盖。
- `item/permissions/requestApproval`、command/file change/patch/exec approval 一律拒绝原生升级；
  文件修改只能从 guarded tool seam 进入。
- 用户降权时先递增 revision、取消所有 pending approval，再对旧 revision 的 active turn 调用
  `turn/interrupt`。升级只对下一 turn 生效，不改变正在执行的 turn。

## 状态与持久化

`codex-service.json` 升级到 v3：

```ts
type PermissionState = {
  onboardingCompleted: boolean;
  mode: "safe" | "guarded_plus" | "advanced_controlled";
  roots: Array<{
    id: string;
    canonicalPath: string;
    displayName: string;
  }>;
  networkPolicy: "readonly_retrieval";
  destructivePolicy: "block";
  revision: number;
};
```

- 文件继续使用既有 0700 目录、0600 文件、临时文件 + fsync + rename。
- `canonicalPath` 不进入微信 prompt、模型可见 MCP `structuredContent`、日志或 transcript。
- Plugin 私有 `_meta` 和本地网页可显示用户主动选择的路径；模型状态只显示别名、root count、
  mode、是否完成向导和 pending approval count。
- v2 迁移：保留 thread、target、processed key、transcript；忽略 `vaultWriteEnabled`，创建
  `onboardingCompleted=false, mode=safe, roots=[]`，禁止隐式扩权。
- pending approval 不跨进程恢复；重启时全部记为 expired。已经完成的 mutation outcome 与快照
  元数据可持久化，便于审计和恢复。

## 首次向导与设置页

### 入口

- Plugin 面板调用 `get_weixin_state` 后，若 `onboardingCompleted=false`，优先显示权限向导；二维码、
  连接和 relay 状态仍可在折叠区查看。
- 本地网页同样显示向导，避免 Plugin 未安装或未刷新时没有设置入口。
- 插件安装本身不启动、部署或重启 4317 后台；后台不可达时面板只显示明确启动说明。

### 步骤

1. **选择档位**：三张卡片，默认聚焦“增强受控”，但提交前必须由用户点击选择。
2. **选择目录**：显示服务器发现的候选目录（当前 workspace、demo Vault）及其完整本地路径；
   用户逐项勾选。第一版不在 iframe 中伪造系统目录选择器。
3. **确认能力**：明确展示“网络仅只读检索”“删除始终阻止”“增强受控的修改会等待本地确认”。
4. **应用**：POST same-origin；后台 realpath、权限与敏感根目录校验全通过后原子保存。

设置页允许以后切换模式和 roots。移除 root 是降权；切到 `safe` 也是降权。任何降权在 UI 中显示
“正在中断旧权限任务”，成功后才显示新模式已生效。

候选 root 规则：

- 必须存在且为普通目录；root 本身不能是符号链接；
- canonical path 不能是 `/`、用户主目录、`~/.codex`、`~/.openclaw` 根、Demo 私有状态目录或插件
  缓存；第一候选固定为当前 `codex-weixin` 后端项目目录，不能借此选择其父目录；
- 子 root 被父 root 覆盖时只保留父 root；
- 第一版只允许后台预登记候选，任意目录浏览/新增作为后续独立设计，避免 iframe 伪路径和泄露。

## 用户真实操作序列与失败模式

### 首次打开

1. Plugin 已安装但后台未运行：显示 4317 不可达，不写默认配置、不启动第二实例。
2. 后台运行且未 onboarding：显示向导；关闭面板不改变权限。
3. 用户选档位但未选 root：禁止提交，解释至少选一个目录。
4. root 在页面打开后被移动/替换：提交时 realpath 失败，保持旧状态。
5. 保存失败：不改变内存策略；页面显示失败，微信 relay 继续使用原安全状态。

### 增强受控修改

1. 微信用户要求创建或修改文件。
2. Codex 通过 guarded tool 提交 mutation；后台完成完整预检和快照，但尚不写。
3. Plugin/本地页面显示待审批批次：目标别名、相对路径、创建/修改类型、摘要，不显示正文。
4. 用户批准：重新检查 revision、root、expected hash 和快照前提，随后一次执行。
5. 用户拒绝、超时、关闭权限或移除 root：promise 失败，Codex 诚实回复未执行。
6. turn 最长 24 小时，但待审批默认 30 分钟；超时不自动批准或重试。

### 高级受控修改

1. 微信用户明确要求创建或修改。
2. 同一 guarded seam 预检、快照并执行，无本地二次确认。
3. 任何删除/移动/敏感路径/冲突请求仍拒绝；高级档不是完整磁盘权限。

### 降权与并发

- 降权发生在 turn 尚未提交 mutation：interrupt，未写。
- 降权发生在 pending approval：取消并拒绝后续批准。
- 降权发生在 atomic rename 之前：中止，临时文件安全清理。
- atomic rename 已完成：记录真实完成，不自动回滚；新权限立即用于下一操作，快照保留。
- 两个 target 同时修改同一文件：第一个 expected hash 成功，第二个因 hash 变化拒绝，不后写覆盖。
- App Server crash：pending 全部取消，不重放 mutation；已完成结果从审计记录读取。

### 网络与插件

- 实时搜索失败：不升级为原始 shell 网络；回复说明检索不可用。
- skill 请求 workspace write：原生升级被拒绝；若可表达成 guarded create/update，Codex 可改走工具，
  否则诚实报告不支持。
- MCP 请求外部写或 elicitation：第一版拒绝，不用“高级受控”自动批准第三方副作用。

## HTTP 与 Plugin 接口

新增本地接口：

- `GET /api/state`：在 `codex.permissions` 返回模型安全摘要。
- `POST /api/codex/permissions/configure`：提交 mode、候选 root IDs 和确认字段。
- `POST /api/codex/permissions/pending/:id/approve`：仅本地 same-origin，批准 pending batch。
- `POST /api/codex/permissions/pending/:id/decline`：仅本地 same-origin，拒绝 pending batch。

Plugin 新增 app-only tools：

- `configure_weixin_codex_permissions`
- `approve_weixin_codex_mutation`
- `decline_weixin_codex_mutation`

工具结果的 `structuredContent` 只含脱敏摘要；完整候选路径与待审批相对路径放组件私有 `_meta`。
原 `enable_weixin_local_write` / `disable_weixin_local_write` 在一个兼容周期内返回明确迁移提示，
不能继续改变权限；面板移除旧按钮。

## 实施纵切与验证

实现阶段另建 `codex/weixin-permission-onboarding` feature branch；不重启现有 4317 watch 服务。

1. **状态与向导纵切**：v3 store migration、三档选择、候选 roots、same-origin 配置；fixture E2E
   证明未 onboarding fail closed。
2. **能力探针与逐 turn 策略纵切**：当前 binary 缺少 restricted read 时禁止提交；支持时每个
   `turn/start` 携带 frozen restricted read policy；resume 不继承旧权限；downgrade interrupt。
3. **guarded mutation 纵切**：create/update、hash、snapshot、敏感路径、无删除/移动。
4. **增强审批纵切**：pending queue、批准/拒绝/超时/降权竞态。
5. **Plugin 纵切**：首次向导、设置页、待审批卡片、cachebuster/reinstall/new task 验证。

每个纵切 test-first；整体运行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Plugin 还需运行 validator、MCP/UI 测试、cachebuster helper，并从实际 local marketplace 重装；更新后的
技能与面板只能在新 Codex task 验证。

真实验证必须由用户在场完成：

1. 首次向导选择增强受控和两个候选 roots；
2. 微信发只读 Vault 查询，确认无需本地批准；
3. 微信要求创建约定测试文件，面板出现 pending，批准后确认文件与微信结果；
4. 微信请求删除该文件，确认被拒绝；
5. 切换高级受控，再创建第二个测试文件，确认无需二次批准但仍有快照；
6. 执行中切回安全只读，确认 active turn 被中断且后续写入拒绝。

渠道接受不等于手机必达；最终仍分别报告本地执行、iLink accepted 和用户确认收到。
