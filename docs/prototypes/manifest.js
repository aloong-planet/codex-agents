window.PROTOTYPE_APP = { name: 'Codex Weixin', icon: null };
window.PROTOTYPES = [
  {
    module: 'daily-ai-news', type: 'ui', id: 'resilience-messages',
    name: '日报来源与归档状态', path: 'daily-ai-news/prototype-resilience-messages.html',
    question: '来源缺失、归档失败和推送结果能否清楚区分？'
  },
  {
    module: 'scheduled-tasks', type: 'logic', id: 'lifecycle',
    name: '定时任务管理与缓存续发',
    path: 'scheduled-tasks/lifecycle/index.html',
    question: '启停、修改、执行与缓存续发的边界是否清楚？'
  },
  {
    module: "workflow-runs",
    type: "ui",
    id: "diagnostics",
    name: "独立诊断页与临时详细采集",
    path: "workflow-runs/prototype-diagnostics.html",
    question: "回合级安全摘要与短时原始查询的分层是否清楚？"
  },
  {
    module: "workflow-runs",
    type: "ui",
    id: "split-view",
    name: "工作流运行双栏视图",
    path: "workflow-runs/prototype-split-view.html",
    question: "运行列表与 DAG 详情的双栏结构是否清楚？"
  },
  {
    module: "workflow-permissions",
    type: "ui",
    id: "module-cards",
    name: "模块权限卡片",
    path: "workflow-permissions/prototype-module-cards.html",
    question: "安装时按模块配置独立读写权限是否清楚？"
  },
  {
    module: "workflow-user-messages",
    type: "ui",
    id: "file-delivery-copy",
    name: "文件发送用户文案",
    path: "workflow-user-messages/prototype-file-delivery-copy.html",
    question: "文件查找与发送结果是否只暴露用户可理解的信息？"
  }
];

window.PROTOTYPES.push({module:"channel-switching",type:"logic",id:"single-active",name:"停服务后修改渠道配置",path:"channel-switching/single-active/index.html"});

window.PROTOTYPES.push({module:"channel-switching",type:"ui",id:"feishu-pairing",name:"飞书命令行首次配对",path:"channel-switching/prototype-feishu-pairing.html"});

window.PROTOTYPES.push({module:"channel-switching",type:"logic",id:"dual-active",name:"双渠道同时在线与通知归属（待确认）",path:"channel-switching/dual-active/index.html"});

window.PROTOTYPES.push({module:"channel-switching",type:"logic",id:"group-access",name:"Feishu group admission and ownership",path:"channel-switching/group-access/index.html"});

window.PROTOTYPES.push({module:"agent-dispatch",type:"logic",id:"dispatch",name:"Agent dispatch and group reports",path:"agent-dispatch/dispatch/index.html"});
