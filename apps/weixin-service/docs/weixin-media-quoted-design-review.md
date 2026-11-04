# 微信媒体闭环与引用消息设计审查

## 发现并修正

1. **不能只把路径写进 prompt**：受限 sandbox 未必包含私有媒体根。修正为启动 thread 时加入媒体根，并在冻结 turn policy 的 readable roots 中始终加入只读媒体根；它不因此成为出站授权根。
2. **dynamic tool 原接口丢失 thread/turn 身份**：App Server 请求实际包含二者。修正 `DynamicToolHost.execute` 增加调用上下文，媒体 host 以 `(threadId, turnId)` 绑定，杜绝跨目标串线。
3. **“同轮明确指令”不能只靠 prompt**：模型判断不能作为唯一门禁。修正为宿主先用保守中文/英文动作词与媒体词组合判定；不匹配则不绑定发送能力。误拒绝可让用户改为明确指令，误放行仍需模型主动调用且路径门禁通过。
4. **保存 cursor 后媒体失败会导致无法重取**：这是现有 monitor 的 at-most-once窗口。修正为 envelope 解析在 cursor 状态落盘前完成，但媒体文件和索引先原子落盘；随后一次保存 cursor/context，再发布事件。若状态保存失败则不发布，重启可重取，媒体保存按 message key 幂等复用。
5. **下载整包后才检查会放大内存**：修正为读取 `Content-Length` 预检并使用 reader 累计限制；密文仍需最多约 100 MiB内存完成 ECB 解密，设计明确接受这一上限。
6. **7 天清理可能删正在处理文件**：修正为 active lease；清理跳过活跃 turn 引用路径，turn 结束释放。
7. **引用媒体 CDN 可能过期**：失败不得阻塞引用标题/正文；向用户明确“引用附件无法读取”，不假称看过。
8. **出站原文件可能在校验后被替换**：打开只读 fd 后 `fstat` 校验普通文件、大小和 inode，再从该 fd 读取上传，避免 TOCTOU。
9. **caption 与媒体不是事务**：设计明确可部分成功，记录每一步接受状态，不自动整组重试。

## 审查结论

设计可实现。外部 seam 小而完整；上游协议复杂度集中在媒体 transport，Codex turn 权限集中在 media host。不存在读取 OpenClaw 凭据、修改插件源码、自动真实测试发送或扩大远程 URL 抓取范围。
