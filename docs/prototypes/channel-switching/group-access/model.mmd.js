// 派生文件:由 sync-mmd.mjs 从本目录 *.mmd 生成,勿手改;改图请改 .mmd 后重跑脚本。
window.MERMAID_SOURCES = window.MERMAID_SOURCES || {};
window.MERMAID_SOURCES["channel-switching/group-access"] = [
  {
    "title": "Group request admission and ownership",
    "src": "%% title: Group request admission and ownership\n%%{init: {\n  'theme': 'base',\n  'htmlLabels': false,\n  'state': { 'htmlLabels': false },\n  'flowchart': { 'htmlLabels': false },\n  'themeVariables': {\n    'primaryColor': '#ECECFF',\n    'primaryBorderColor': '#D5D5FF',\n    'primaryTextColor': '#000000',\n    'lineColor': '#757575',\n    'textColor': '#212121',\n    'edgeLabelBackground': 'transparent',\n    'noteBkgColor': '#FFF6B8',\n    'noteBorderColor': '#E4C800',\n    'noteTextColor': '#5C5100',\n    'tertiaryColor': '#f5f5f5',\n    'background': '#FFFFFF'\n  }\n}}%%\nstateDiagram-v2\n  direction LR\n  [*] --> observing\n  observing --> observing: ambient context\n  observing --> processing: authorized mention\n  processing --> waiting: needs a choice\n  processing --> observing: reply or task\n  waiting --> observing: requester chooses\n  waiting --> processing: another authorized request\n  observing --> disabled: remove group\n  processing --> disabled: remove group\n  waiting --> disabled: remove group\n  disabled --> [*]\n  note right of waiting\n    Choices belong to their requester.\n    Group tasks are shared by authorized members.\n    Private memory never enters a group scope.\n  end note"
  }
];
