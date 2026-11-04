# 个人微信直连 iLink 本地 Demo 设计

## 决策与目标

本 Demo 完全脱离 OpenClaw runtime：不调用 `openclaw` CLI，不连接 OpenClaw
gateway，不读取或写入 `~/.openclaw` 的配置、账户、日志或 context token。
它使用腾讯 `@tencent-weixin/openclaw-weixin@2.4.6` 已公开的协议事实，直接连接
腾讯 iLink。用户已明确接受使用同一微信重新绑定可能使旧 OpenClaw 微信连接失效。

登录后凭据持久化到 Demo 自己的本机私有状态目录。默认目录为 macOS
`~/Library/Application Support/weixin-ilink-direct-demo/`，可在启动时用
`WEIXIN_DEMO_STATE_DIR` 覆盖。目录权限为 `0700`，状态文件权限为 `0600`，且不位于
项目 Git 工作树内。

完成标准：

1. 页面请求腾讯 iLink 的真实二维码并显示真实登录状态。
2. 扫码、验证、条件数字码、确认、过期和失败均来自 iLink 的实际响应；网页不伪造授权。
3. `confirmed` 后私密保存单个直连账户的 bot token、账户 ID、base URL、同步游标和按目标保存的 context token。
4. 服务运行期间直接长轮询入站消息；只向网页暴露账户/目标的路由 ID、本地别名、时间与状态，不暴露消息正文或任何 token。
5. 只有目标向新 bot 发过入站文本并产生 context token 后，Demo 才会自动绑定该账户与目标、尝试一次固定问候，并允许发送真实测试文本。
6. 发送直接调用 iLink `sendmessage`，成功只表示 iLink 接受请求，最终送达仍由用户在微信端确认。
7. 已连接账户启动时自动发布已持久化目标；收到带 context token 的入站消息并成功持久化后自动发布最新目标，无需用户手动刷新才能看见。
8. 账户和目标支持仅存于 Demo 私有状态的用户自定义别名；机器 ID 始终是不可变路由键，别名不得宣称来自微信昵称或微信号。
9. 目标公开状态包含最近入站、上下文更新和渠道接受发送的时间；这些时间只表达可观察事实，不推导腾讯未公开的 TTL。
10. bot 凭据 `-14` 与普通发送失败分开建模：前者禁用账户发送并提示凭据失效/暂停，后者提示刷新入站上下文后由用户主动重试。

## 已确认协议事实

- 插件 latest 与本机版本均为 2.4.6；`iLink-App-Id` 为 `bot`，客户端版本编码为
  `major << 16 | minor << 8 | patch`（插件 `package.json:2-4,66`，
  `src/api/api.ts:89-107,227-253`）。
- 二维码来自 `POST ilink/bot/get_bot_qrcode?bot_type=3`；请求可携带本地 token
  列表。直连 Demo 只携带自己的既有 token，不读取主 OpenClaw token
  （`src/auth/login-qr.ts:64-89,177-221`）。
- 登录状态由 `GET ilink/bot/get_qrcode_status` 返回，可能为 `wait`、`scaned`、
  `need_verifycode`、`verify_code_blocked`、`expired`、`scaned_but_redirect`、
  `binded_redirect` 或 `confirmed`（`src/auth/login-qr.ts:297-435`）。
- 手机确认和数字码是否出现由微信/iLink 决定。Demo 只在收到
  `need_verifycode` 时收集一次性数字并随下一次轮询提交。
- 入站通过 `POST ilink/bot/getupdates` 长轮询，游标为 `get_updates_buf`；每条入站
  消息包含 `from_user_id` 和可选 `context_token`
  （`src/api/api.ts:424-470`，`src/api/types.ts:179-218`）。
- 文本发送通过 `POST ilink/bot/sendmessage`，消息类型为 BOT、状态为 FINISH，并回传
  与目标对应的 context token（`src/messaging/send.ts:22-45,69-97`）。

## 深模块与 seam

`DirectIlinkChannel` 是唯一对业务层公开的深模块。原有 `listAccountIds`、
`discoverTargets` 与 `onTargetsChanged` 无法一致表达账户健康、别名和时间；本次直接替换为
统一快照 seam，不在旧 interface 上继续叠加平行读取方法。新 interface 只暴露：

- `start()`：已有私有凭据时启动或恢复入站长轮询；
- `getSnapshot()`：返回账户、凭据健康和安全目标元数据的不可变快照；
- `onSnapshotChanged(listener)`：订阅快照变化并返回取消函数；订阅时立即发布当前快照；
- `updateLocalLabels(input)`：原子保存账户/目标的本地别名后发布新快照；
- `startLogin(onEvent, onExit)`：开始一个真实登录并返回可提交数字码/终止的 handle；
- `sendText(accountId, target, message)`：使用匹配的私密 context token 发送；
- `close()`：取消登录和入站长轮询，并尽力发送 stop 通知。

二维码请求、状态轮询、IDC 跳转、超时、私密持久化、同步游标、context token、
notify start/stop 和请求头全部隐藏在实现内。业务层与测试都只跨这个 seam。

`DemoService` 在构造时订阅一次快照变化，并在关闭时取消订阅。直连模块只在私有状态
成功落盘后发布别名/上下文元数据；listener 的异常被模块隔离，不能终止 iLink 长轮询。网页继续每
1.5 秒读取公开状态，因此无需新增 WebSocket/SSE，也无需持续调用写接口即可显示最新目标。
手动“查找最近入站目标”保留为明确的恢复/确认动作，但不再是看见新目标的必要前置。

内部 seam 有三个真实可变点：

1. 注入 `fetch`，测试使用确定性响应序列，生产使用 Node 原生 fetch；
2. 注入凭据状态文件路径，测试使用临时目录，生产使用私有应用状态目录；
3. 注入无秘密的自动绑定账本，fixture 使用内存/临时文件，生产使用私有应用状态目录。

fixture E2E adapter 继续实现相同业务 interface，但只有显式
`DEMO_MODE=fixture` 时启用。

## 状态与授权流程

```text
disconnected/configured
  -> login_starting -> awaiting_scan
       -> scanned -> confirmed -> connected -> awaiting_inbound
       -> pair_code_required -> scanned
       -> expired -> refreshed QR -> awaiting_scan
       -> login_error
connected/awaiting_inbound
  -> first matching USER text -> binding persisted as sending -> ready
                                -> greeting accepted/failed (no retry)
ready -> sending -> sent
              \-> send_error -> ready
```

`binded_redirect` 只有本地已经存在直连凭据时才算“已连接”；若状态文件为空，则作为
不可恢复错误呈现，不能把主 OpenClaw 的绑定假装成 Demo 的连接。自动绑定只在最新一次登录
完成后布防，并且只消费同账户第一条真实 USER 文本；它不替代 iLink 的 `confirmed`。

## 持久化与安全

凭据状态文件是单账户 JSON，由 `PrivateStateStore` 原子写入，包含：账户 ID、bot token、
base URL、扫码用户 ID、同步游标、账户本地别名、`target -> context token` 映射和每个
目标的本地别名/时间元数据。它从不由 HTTP
接口返回，也不写入应用日志。公开状态只返回路由 ID、本地别名、可观察时间和凭据健康。
独立的 `auto-binding.json` 只保存待绑定账户、目标、入站事件哈希、发送状态和时间，不含
token 或消息正文；发送前先原子消费 pending，进程在发送中崩溃时恢复为结果未知且不重试。

- 状态目录创建为 `0700`，文件创建并复核为 `0600`；写入使用同目录临时文件后 rename。
- 解析时严格校验 JSON shape、字符串长度、HTTPS base URL 与微信 ID 格式；损坏文件不自动覆盖，页面显示安全错误。
- 新字段保持 `version: 1` 的向后兼容可选扩展；旧状态缺少别名/时间时按空元数据读取，首次写入再规范化保存，不要求重新扫码。
- 别名 trim 后最长 80 个 Unicode 字符，禁止控制字符；空字符串表示删除本地别名。别名不是凭据，但仍只保存在私有状态中。
- iLink host 只允许 `ilinkai.weixin.qq.com` 或登录状态明确返回的 HTTPS redirect/base URL；二维码只允许微信 HTTPS host。
- HTTP 服务只监听 `127.0.0.1`，保留同源写请求检查和 16 KiB body 限制。
- 不记录二维码 URL、数字码、bot token、context token、消息正文或完整 iLink 响应。
- 退出只停止 Demo 自己的请求；不停止或修改 OpenClaw。

## 用户真实操作序列与失败模式

1. **首次打开**：无私有状态时显示未连接；状态文件损坏/权限过宽时页面仍可打开，但生成二维码会返回安全错误并拒绝覆盖文件，不降级读取 OpenClaw。
2. **生成二维码**：DNS、TLS、HTTP、JSON shape 或不允许的二维码 host 均安全失败；活动登录期间拒绝重复启动。
3. **扫码**：`wait` 继续等待；`scaned` 显示验证中；`need_verifycode` 只接受数字；错误过多或二维码多次过期后停止。
4. **确认**：只有同时得到 token 与 account ID 才原子保存并启动入站长轮询；保存失败不得显示连接成功。
5. **已绑定**：仅当私有状态中已有同一 Demo 凭据时恢复；空状态收到 `binded_redirect` 必须报错并说明不能取得新凭据。
6. **服务重启**：校验权限和文件内容后恢复私有凭据、同步游标与目标 token；start 通知为尽力调用，即使失败仍恢复权威的 getupdates 长轮询。
7. **入站**：长轮询超时正常重试；游标和 context token 同次原子保存；无目标/token 的消息不启用发送。连续网络失败退避但不宣称断开。
8. **凭据过期**：iLink 返回 `-14` 时停止发送/轮询并要求重新绑定，不自动清除旧文件。
9. **发送**：必须匹配当前 account、目标与 context token；并发点击、空文本、超长或控制字符均拒绝；超时不自动重试，避免重复投递。
10. **关闭**：取消在途 QR/getupdates 请求，尽力通知 stop；通知失败不延迟退出，也不删除凭据。
11. **本地二维码渲染失败**：终止当前登录，清除活动 handle 并进入可重试错误态，不能让下一次点击卡在“已有登录流程”。
12. **自动同步**：服务恢复连接时立即发布已持久化目标；新入站只有在游标/context token 原子保存成功后才发布。重复目标允许再次发布以反映“已收到消息”，但不得清除用户已填写的确认输入。listener 抛错不得影响长轮询。
13. **本地命名**：用户可分别给账户和已发现目标命名；保存失败保持旧快照，未知账户/目标、超长或控制字符标签均拒绝。修改别名不改变路由 ID、token 或发送门禁。
14. **时间元数据**：有效入站使用服务端 `create_time_ms`（合理正整数）作为 `lastInboundAt`，本机落盘时间作为 `contextUpdatedAt`；渠道 `ret=0` 后记录 `lastSendAcceptedAt`。发送已被腾讯接受但时间落盘失败时仍报告发送已接受，不能制造假失败。
15. **普通发送失败**：非零通用 `ret`、网络失败或超时均不自动重试；页面提示重新发入站消息刷新上下文后再由用户点击，不能武断宣称 context token 过期。
16. **bot 凭据 `-14`**：monitor、notify-start 或 send 任一路径观察到 `-14`，统一发布 `credentialStatus=stale`，停止/禁用发送并提示等待恢复或重新连接；它不是 context token 过期。成功重新绑定后恢复 `usable`。
17. **目标选择**：公开快照恰好只有一个目标时，页面自动选择并填入只读发送目标；存在多个目标时仍由用户从已发现目标下拉框选择。只读发送目标与最近入站目标使用同一显示规则：优先本地别名，无别名时显示缩短 ID；完整机器 ID 仅作为内部路由值并在高级信息展示。目标必须存在于已同步快照，保留入站复选框和独立发送点击，但不再要求重复输入同一个机器 ID，也不允许手工构造无上下文目标。
18. **发送与入站并发**：发送等待响应期间可能落盘更新的入站游标/context token；记录发送接受时间必须合并到当时最新内存状态，不能用请求开始时的旧快照覆盖新上下文。
19. **连接/发送完成与 stale 并发**：monitor 启动或发送完成不能覆盖同期发布的 stale 状态；已接受的单次发送仍诚实报告接受，同时保持后续发送禁用。
20. **操作反馈**：确认按钮和发送按钮旁分别有持久 `aria-live` 反馈，由公开状态派生而非短暂点击回调。确认成功明确显示可发送；发送中、渠道接受、失败/未知和凭据失效均就地显示。`sent` 只能表述渠道接受，不能宣称微信端已送达。

## TDD 与验证

最高测试 seam 是 `DemoService + DirectIlinkChannel interface`；直连实现通过注入 fetch
运行确定性协议测试。

- 状态存储：权限、原子写、损坏/非法状态、恢复游标和 token。
- 登录：真实请求 shape、QR host、扫码、数字码、confirmed、binded_redirect、过期刷新、终止和失败。
- 入站：getupdates 游标、target/context token 持久化、超时、错误码与关闭。
- 自动同步：订阅时的已有目标、首次新目标、重复目标刷新、持久化失败不发布、取消订阅及 listener 隔离。
- 本地别名：旧状态兼容、规范化/删除、未知目标、持久化失败和公开快照不含凭据。
- 时间：入站/上下文/发送接受时间、异常时间回退、发送成功后的元数据落盘失败。
- 凭据健康：monitor/notify/send 的 `-14`、普通错误不误判、stale 后禁用和重新绑定恢复。
- 发送：显式账户/目标、必须有 token、请求 shape、成功/失败/超时不重试、秘密不出现在公开状态。
- HTTP/业务：原有同源、状态机、已同步目标校验、入站确认和并发门禁回归。
- 浏览器 E2E：fixture 完整流程；不会连接腾讯、扫码或发送。
- 最终真实验证：服务启动后由用户亲自生成二维码、扫码/数字确认、发送入站消息和点击测试发送。

## 非目标

- 不实现自动回复、AI agent、媒体、群聊、后台常驻、多账户或远程访问。
- 不删除/注销主 OpenClaw 凭据，不修改其配置；腾讯侧重新绑定造成的旧连接失效由用户明确接受。
- 不把闭源手机 UI 固定成某种授权页面，也不伪造手机确认。
