import { spawn } from "node:child_process";

export interface LocalNotifier {
  notify(title: string, body: string): void;
}

function appleScriptString(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/gu, " ").slice(0, 300));
}

export class MacLocalNotifier implements LocalNotifier {
  notify(title: string, body: string): void {
    const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
    try {
      const child = spawn("/usr/bin/osascript", ["-e", script], { stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } catch {
      // Local notification failure must not change delivery state.
    }
  }
}
