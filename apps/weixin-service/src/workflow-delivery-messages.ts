export const WEIXIN_FILE_WORKFLOW_MESSAGES = Object.freeze({
  sent: "文件已发送，请查收。",
  notFound: "没有找到匹配的文件。",
  permissionDenied: "没有读取这个文件的权限，请在“本地权限”中启用后重试。",
  sendFailed: "文件发送失败，请稍后重试。",
  sendPartial: "部分文件已发送，其余文件发送失败。",
  sendUnknown: "文件发送结果暂时无法确认，请检查微信；系统不会自动重发。",
  searchFailed: "暂时无法完成文件查找，请稍后重试。",
  retired: "之前的文件查找任务已结束。若仍需要这个文件，请重新告诉我。",
  fileChanged: "文件内容已经发生变化，请重新查找后再发送。",
});

export const WEIXIN_IMAGE_WORKFLOW_MESSAGES = Object.freeze({
  sent: "图片已发送，请查收。",
  notFound: "没有找到匹配的图片。",
  permissionDenied: "没有读取这张图片的权限，请在“本地权限”中启用后重试。",
  sendFailed: "图片发送失败，请稍后重试。",
  sendPartial: "部分图片已发送，其余图片发送失败。",
  sendUnknown: "图片发送结果暂时无法确认，请检查微信；系统不会自动重发。",
  searchFailed: "暂时无法完成图片查找，请稍后重试。",
  sourceMissing: "我还不能确定要发送哪张图片。请引用图片、随消息附图、说明“刚才的图片”，或告诉我授权目录和文件名。",
});
