# codex-weixin 迁移任务清单

- [x] 核对旧后端、插件、marketplace 与 4317 启动方式
- [x] 确认新项目名与目标目录
- [x] 编写迁移设计与设计审查
- [x] 创建独立 Git master 基线和 feature 分支
- [x] 复制源码并排除运行状态、依赖和构建产物
- [x] 建立 pnpm workspace
- [x] 统一项目、插件、MCP、skill 与 marketplace 名称
- [x] 安装 workspace 依赖并生成根锁文件
- [x] 完成 lint、typecheck、单测、build 与 fixture E2E
- [x] 验证插件结构并刷新 cachebuster
- [x] 用 Codex CLI 切换 marketplace 并安装新插件
- [x] 切换 launchd job 到新后端目录
- [x] 验证 4317 唯一 listener、状态连续和页面可访问
- [x] 完成代码审查、测试审查与设计同步
- [x] 提交 feature 分支
