// 派生文件:由 sync-mmd.mjs 从本目录 *.mmd 生成,勿手改;改图请改 .mmd 后重跑脚本。
window.MERMAID_SOURCES = window.MERMAID_SOURCES || {};
window.MERMAID_SOURCES["channel-switching/single-active"] = [
  {
    "title": "Stop, configure, start",
    "src": "%% title: Stop, configure, start\n%%{init: {'theme':'base','htmlLabels':false,'state':{'htmlLabels':false},'flowchart':{'htmlLabels':false},'themeVariables':{'primaryColor':'#ECECFF','primaryBorderColor':'#D5D5FF','primaryTextColor':'#000000','lineColor':'#757575','textColor':'#212121','edgeLabelBackground':'transparent','noteBkgColor':'#FFF6B8','noteBorderColor':'#E4C800','noteTextColor':'#5C5100','tertiaryColor':'#f5f5f5','background':'#FFFFFF'}}}%%\nstateDiagram-v2\n  direction LR\n  [*] --> running: initial service\n  running --> stopped: stop\n  stopped --> stopped: edit configuration\n  stopped --> starting: start valid configuration\n  stopped --> failed: start invalid configuration\n  starting --> running: ready\n  starting --> failed: fail\n  failed --> stopped: edit configuration\n  failed --> starting: retry valid configuration\n  failed --> failed: retry invalid configuration\n  note right of stopped\n    Select Weixin or Feishu\n    Keep personal data\n  end note\n  note right of failed\n    No automatic fallback\n  end note"
  }
];
