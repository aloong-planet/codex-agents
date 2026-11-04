# 微信本地图片外发目录 MVP

## 目标

允许用户在插件页面独立授权 `Downloads`、`Pictures`、`Documents`，随后从微信明确要求查找并发送其中的图片。该授权不扩大 Codex 普通文件读写范围，也不把本地绝对路径暴露给模型或页面。

## 已确认现状

- 当前 `weixin_send_media` 只接受绝对路径，并把 Codex 已授权工作区同时当作媒体外发目录。
- 当前页只有 Codex 本地权限，没有独立媒体目录授权。
- iLink 现有出站链路已经支持 jpg/jpeg/png/gif/webp/bmp，单文件上限 100 MiB。
- 纯网页不能提供可持久恢复的 macOS 原生目录选择授权；MVP 只支持三个固定用户目录，并以实际读目录结果呈现可用、缺失或被系统阻止。

## 用户流程

1. 用户进入“本地权限”页，在“微信图片外发目录”勾选固定目录并明确保存。
2. 宿主验证目录存在、不是符号链接且当前服务进程可读取；授权默认关闭并可撤销。
3. 用户从微信明确说“把 Downloads 里的 xxx 图片发给我”等指令。
4. 模型只通过 `weixin_find_images` 得到不透明 `mediaId`、文件名、目录名、修改时间和大小，不得到绝对路径。
5. 模型使用 `weixin_send_image(mediaId, caption?)`；宿主重新验证当前授权、真实路径、普通文件、图片类型与大小后，调用既有 iLink 媒体发送链路。
6. 当前微信消息没有明确发送图片意图时，查找和发送工具都拒绝执行。

## 深模块与接口

`MediaExportLibrary` 隐藏固定目录、持久化、macOS 可读性探测、递归扫描和路径完整性：

```ts
getPublicState(): MediaExportPublicState
configure({ rootIds, confirmed }): MediaExportPublicState
search({ query, rootId, limit }): Promise<MediaExportMatch[]>
resolve(match): string
```

动态工具仍由 `WeixinMediaToolHost` 统一暴露：

- `weixin_find_images(query?, rootId?, limit?)`
- `weixin_send_image(mediaId, caption?)`
- 保留 `weixin_send_media(path, caption?)` 兼容当前/引用/近期图片和原有受控工作区路径。

`mediaId` 只存在于当前 turn 的 binding，turn 结束立即失效。模型不能提交 account、target、真实路径或任意 ID。

## 持久化与安全边界

- 独立文件：私有状态目录下 `media-export-grants.json`，权限 0600；只保存 schema version、revision 和已授权固定目录的 canonical snapshot。
- 默认没有授权；保存必须 `confirmed=true`。
- 搜索只遍历已授权根目录，不跟随符号链接，跳过隐藏目录和 `.photoslibrary` 照片图库；其他目录包按普通目录递归。最多扫描 10,000 个目录项，最多返回 20 条。
- 支持扩展名：jpg/jpeg/png/gif/webp/bmp；结果按修改时间倒序并稳定排序。
- 每次搜索和发送都重新确认授权根的 realpath 未变化。授权根缺失、被系统阻止或被替换时 fail closed。
- 发送前还会拒绝 `.photoslibrary` 内的旧路径；普通 `Pictures` 文件和其他目录包不需要因此开放完整 Photos Library 权限。
- 不请求 Full Disk Access，不绕过 macOS 隐私控制。`EPERM`/`EACCES` 在页面显示“被 macOS 阻止”。
- 不自动发送；外部发送仍只由用户当前微信指令触发，未知发送结果不盲目重试。

## 状态与失败模式

- `available`：存在且可读取，可勾选/已授权。
- `missing`：目录不存在，不能保存为授权。
- `blocked`：系统拒绝读取；页面提示用户在 macOS 隐私与安全设置中允许运行服务的宿主进程访问相关目录。
- `changed`：已授权路径的 canonical path 后续变化；搜索和发送拒绝，要求重新保存授权。
- 搜索无结果：返回空列表，不推测路径。
- 模型误选普通 shell/文件工具：每个明确图片外发回合都会注入已授权目录名，并要求只使用 `weixin_find_images` 与 `weixin_send_image`；普通 Codex 目录权限仍不会因此扩大。
- 扫描达到上限：返回已排序结果并标记 `truncated=true`。
- `mediaId` 过期/跨 turn 使用：拒绝，不回退为路径搜索。

## 设计审查

- 不把三个目录加入 `permissions.roots`，因此不会扩大 Codex shell/文件工具权限。
- 不把绝对路径写入 prompt、HTTP public state 或工具返回；只有宿主持有路径映射。
- 固定目录避免网页伪造任意路径；自定义目录和原生 security-scoped bookmark 留到后续原生 helper。
- 搜索时扫描适合 MVP 和三个个人目录，但大量文件时延迟不稳定；达到真实规模后再考虑持久索引。
- 目录读取权限与媒体外发授权是两道门：服务进程能读不等于已授权，已授权但系统阻止也不能读取。

## 验证标准

- 默认关闭，配置可持久恢复，可撤销。
- 未授权目录、符号链接、目录路径变化、非图片和超限文件均拒绝。
- 搜索返回不透明 ID，页面和工具结果不含绝对路径。
- 明确发送意图下可把搜索结果交给现有媒体出站链路；无明确意图时拒绝。
- HTTP/UI 能展示目录状态并反馈保存结果。
- lint、typecheck、服务单测、插件单测和 fixture E2E 全绿；真实微信发送只由用户后续触发。

## 实施任务与结果

- [x] 独立持久化三个固定目录的授权，默认关闭并支持撤销。
- [x] 递归、限量、不跟随符号链接地查找图片。
- [x] 在三个授权根目录统一跳过 `.photoslibrary`，并在发送前拒绝照片图库内旧路径；其他目录包继续递归。
- [x] 用当前 turn 有效的不透明 `mediaId` 连接搜索与发送。
- [x] 在真正发送前重新验证目录授权；搜索后撤销授权会使旧句柄失效。
- [x] 在每个明确外发回合注入媒体工具路由，防止模型误用普通 shell 后声称没有目录权限。
- [x] 接入 HTTP 状态、页面配置、可用性提示和操作反馈。
- [x] 完成 lint、typecheck、单元/集成测试、构建和 fixture 页面端到端验证。
- [ ] 用户重启服务后，在页面亲自授权目录并从微信发起一次真实图片发送测试。
