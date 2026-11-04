// 派生文件:由 sync-mmd.mjs 从本目录 *.mmd 生成,勿手改;改图请改 .mmd 后重跑脚本。
window.MERMAID_SOURCES = window.MERMAID_SOURCES || {};
window.MERMAID_SOURCES["channel-switching/dual-active"] = [
  {
    "title": "Proposed shared core with two live channels",
    "src": "%% title: Proposed shared core with two live channels\nflowchart TB\n W[Weixin] <--> R[Trusted channel router]\n F[Feishu] <--> R\n R <--> C[One conversation state authority]\n C <--> H[Separate channel histories and queues]\n C <--> M[Shared memory and permissions]\n C <--> E[Shared workflow engine]\n E --> D[Bound media and notification delivery]\n S[One scheduler] --> D\n D --> W\n D --> F"
  },
  {
    "title": "Notification destination and delivery state",
    "src": "%% title: Notification destination and delivery state\n%%{init: {'theme':'base','htmlLabels':false,'state':{'htmlLabels':false},'flowchart':{'htmlLabels':false},'themeVariables':{'primaryColor':'#ECECFF','primaryBorderColor':'#D5D5FF','primaryTextColor':'#000000','lineColor':'#757575','textColor':'#212121','edgeLabelBackground':'transparent','noteBkgColor':'#FFF6B8','noteBorderColor':'#E4C800','noteTextColor':'#5C5100','tertiaryColor':'#f5f5f5','background':'#FFFFFF'}}}%%\nstateDiagram-v2\n direction LR\n [*] --> ready: new or migrated task\n ready --> ready: chat / connection change / restart\n ready --> sending: submit to online destination\n sending --> sending: chat / connection change\n sending --> accepted: accept\n sending --> unknown: uncertain / restart\n accepted --> [*]\n unknown --> [*]\n note right of ready\n New task: creation channel\n Legacy task: Feishu\n Destination never follows the last chat\n end note\n note right of unknown\n No automatic resend\n No fallback to other channel\n end note"
  }
];
