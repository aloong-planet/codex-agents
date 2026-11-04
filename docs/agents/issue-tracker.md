# Issue tracker：本地文件

本仓库沿用本地文件票，不向远程 tracker 发布。用户已确认本增量使用该方式。

## 约定

- 一个工作项集合一个目录：`docs/.workings/<slug>/`。
- 一票一文件：`docs/.workings/<slug>/issues/<NN>-<ticket-slug>.md`；从 01 开始按依赖顺序编号。
- 在票的开头声明 `Blocked by`；全部前置完成后才解除阻塞。
- 可开始实施的票使用 `Status: ready-for-agent`，不意味着代码或验收已经完成。
- 每条验收标准有稳定 AC 编号，并声明 Gate、Test 或 Evidence。
- 多票增量设置明确的最后收口票，依赖其他全部票；单票增量由本票完成第 8 步，不另建收口票。
- 补充与用户确认保存在票的 `Comments`，不改写历史测试失败记录。
- 新增票不自动关闭或修改其他工作项。

## 规格与过程

持久规格在 `docs/specs/`，不放在票目录。过程目录保存票、清单、测试报告和审查记录；它们是工作索引，不是实现现状真源。
当前能力以 spec、features、ADR、CONTEXT 和实现交叉核对为准。

## 如何读写票

发布时在相应 issues 目录创建一张独立 Markdown；取票时读取指定文件及其引用规格和相关 ADR。
本轮已确认的工作项见 [最终答复结构化结果任务索引](../.workings/structured-business-results/README.md)。

## 配置范围

这里只记录已确认的 tracker，不迁移或覆盖已有 AGENTS.md，不创建自引用导入，不改变项目文档布局。
