import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { FeishuTransport } from "./feishu-channel.js";
import type { PersonalChannel, PersonalOwnerConfiguration } from "./personal-owner-identity.js";
import { parseChannelStartupConfiguration } from "./channel-startup-config.js";
import { PrivateStateStore } from "./private-state-store.js";
import { AutoBindingFileStore } from "./auto-binding-store.js";

export type PairingTransport = Pick<FeishuTransport, "start" | "close">;
export interface PairingIO {
  ask(prompt: string, options: { secret?: boolean; signal: AbortSignal }): Promise<string>;
  write(text: string): void;
}
type Credentials = { appId: string; appSecret: string };
type Document = { channel?: PersonalChannel; enabledChannels?: PersonalChannel[]; owner: PersonalOwnerConfiguration;
  taskScope: { accountId: string; target: string }; feishu?: Credentials & Record<string, unknown>; [key: string]: unknown };
export type PairingResult = "saved" | "cancelled" | "failed";
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Configuration is private host input; the wizard never opens business stores. */
class PairingFile {
  readonly document: Document;
  private readonly original: string | undefined;
  private readonly lock: string;
  private locked = false;
  constructor(private readonly file: string, statePath: string) {
    const dir = path.dirname(file);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Error("pairing_private_directory_required");
    this.lock = `${file}.pairing-lock`;
    let fd: number;
    try { fd = fs.openSync(this.lock, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error("pairing_busy"); throw error; }
    fs.closeSync(fd); this.locked = true;
    try {
      this.original = this.read();
      if (this.original !== undefined) {
        const input: unknown = JSON.parse(this.original);
        parseChannelStartupConfiguration(input);
        this.document = input as Document;
      } else {
        const state = new PrivateStateStore(statePath).load();
        if (!state) throw Error("pairing_legacy_identity_required");
        const binding = new AutoBindingFileStore(path.join(path.dirname(statePath), "auto-binding.json")).load();
        const target = (binding.status === "accepted" || binding.status === "failed") && binding.accountId === state.accountId && state.contextTokens[binding.target]
          ? binding.target
          : binding.status === "idle" && state.userId && Object.keys(state.contextTokens).length === 1 && state.contextTokens[state.userId] ? state.userId : undefined;
        if (!target) throw Error("pairing_legacy_identity_required");
        this.document = { channel: "weixin", owner: { memoryAccountId: state.accountId,
          bindings: [{ channel: "weixin", accountId: state.accountId, target, senderId: target }] }, taskScope: { accountId: state.accountId, target } };
        parseChannelStartupConfiguration(this.document);
      }
    } catch (error) { this.close(); throw error; }
  }
  private read(): string | undefined {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) throw Error("pairing_unsafe_configuration");
    return fs.readFileSync(this.file, "utf8");
  }
  /**
   * Steps the kept Feishu configuration still needs before the next start, one preview line each, in the order they are done
   * (channel-switching::US-003/AC-08). A kept webhook holds the previous application's verification token and encrypt key, and
   * a kept callback receive mode listens only for callbacks while pairing left the platform on long connection.
   */
  keptConfigurationSteps(appId: string): string[] {
    const previous = this.document.feishu;
    return [
      ...(previous?.webhook !== undefined && previous.appId !== appId ? ["本次换了应用：webhook 里的 Verification Token 和 Encrypt Key 仍是原应用的，请换成新应用的再启动。"] : []),
      ...(previous?.receiveMode === "webhook" ? ["接收方式：回调（webhook）保留。保存后先启动服务，再在飞书后台把事件订阅改回请求地址并完成地址验证。"] : []),
    ];
  }
  enabledChannels(): PersonalChannel[] {
    const previous = parseChannelStartupConfiguration(this.document).enabledChannels;
    return ["feishu", ...previous.filter((channel) => channel !== "feishu")];
  }
  save(credentials: Credentials, candidate: { senderId: string; target: string }): void {
    // Re-pairing replaces only the application's credentials; every other Feishu key is kept (channel-switching::US-003/AC-08).
    const document: Document = { ...this.document, enabledChannels: this.enabledChannels(), feishu: { ...this.document.feishu, ...credentials },
      owner: { ...this.document.owner, bindings: [...this.document.owner.bindings.filter(b => b.channel !== "feishu"),
        { channel: "feishu", accountId: credentials.appId, ...candidate }] } };
    delete document.channel;
    parseChannelStartupConfiguration(document);
    if (this.read() !== this.original) throw Error("pairing_configuration_changed");
    const temporary = path.join(path.dirname(this.file), `.channel-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(document, null, 2) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (this.read() !== this.original) throw Error("pairing_configuration_changed");
      fs.renameSync(temporary, this.file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  close(): void { if (this.locked) { this.locked = false; fs.unlinkSync(this.lock); } }
}

/** Standalone provisioning: only authenticated event transport and a local confirmation can bind identity. */
export async function runFeishuPairing(options: {
  configPath: string; statePath: string; io: PairingIO; transport(credentials: Credentials): PairingTransport;
  signal?: AbortSignal; timeoutMs?: number;
}): Promise<PairingResult> {
  const { io } = options;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("pairing_cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let file: PairingFile | undefined, transport: PairingTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intentionalClose = false;
  async function closeTransport() { if (transport) { const current = transport; transport = undefined; intentionalClose = true; await current.close(); } }
  function guarded<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      operation.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
      if (controller.signal.aborted) abort();
    });
  }
  async function ask(prompt: string, secret = false): Promise<string> {
    controller.signal.throwIfAborted();
    const answer = await guarded(io.ask(prompt, { secret, signal: controller.signal }));
    if (answer === "/cancel") { cancel(); controller.signal.throwIfAborted(); }
    return answer.trim();
  }
  try {
    controller.signal.throwIfAborted();
    io.write("飞书配对\n保存前不会修改配置。请先停止正式服务。");
    file = new PairingFile(options.configPath, options.statePath);
    io.write(`保留原记忆与任务身份：${file.document.owner.memoryAccountId}`);
    if (file.document.owner.bindings.some(b => b.channel === "feishu") && (await ask("已有飞书绑定，是否重新配对并在最后确认替换？[y/N] ")).toLowerCase() !== "y") return "cancelled";
    let appId = await ask("App ID：");
    while (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) { io.write("App ID 格式无效，请重新输入。"); appId = await ask("App ID："); }
    let appSecret = await ask("App Secret（隐藏输入）：", true);
    while (!appSecret || appSecret.length > 512 || (/\s/u.test(appSecret) || Array.from(appSecret).some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)))) {
      io.write("应用密钥格式无效，请重新输入。"); appSecret = await ask("App Secret（隐藏输入）：", true);
    }
    const credentials = { appId, appSecret };
    const code = `PAIR ${randomBytes(16).toString("hex")}`;
    let capture: ((candidate: { senderId: string; target: string }) => void) | undefined;
    const candidatePromise = new Promise<{ senderId: string; target: string }>(resolve => { capture = resolve; });
    let accepting = false;
    timer = setTimeout(() => controller.abort(Error("pairing_expired")), options.timeoutMs ?? 5 * 60_000);
    transport = options.transport(credentials);
    await guarded(transport.start({ ready() {}, unavailable() { if (!intentionalClose) controller.abort(Error("pairing_connection_failed")); },
      async message(value) {
        if (!accepting || !capture || controller.signal.aborted) return;
        const event = object(value), sender = object(event?.sender), message = object(event?.message);
        const senderId = object(sender?.sender_id)?.open_id, target = message?.chat_id;
        if (!event || (event.app_id !== undefined && event.app_id !== appId) || sender?.sender_type !== "user" || message?.chat_type !== "p2p" ||
            message.message_type !== "text" || typeof senderId !== "string" || !/^ou_[A-Za-z0-9]{1,197}$/.test(senderId) ||
            typeof target !== "string" || !/^oc_[A-Za-z0-9]{1,197}$/.test(target) || typeof message.content !== "string" || message.content.length > 512) return;
        let content: unknown; try { content = JSON.parse(message.content); } catch { return; }
        if (object(content)?.text !== code) return;
        const resolve = capture; capture = undefined; accepting = false; resolve({ senderId, target });
      },
    }));
    accepting = true;
    io.write("配对连接已就绪。请在飞书后台选择长连接、订阅接收消息 v2.0 并发布应用。\n私聊机器人发送以下一次性口令（5 分钟内有效）：");
    io.write(code);
    const candidate = await guarded(candidatePromise);
    io.write(`收到匹配口令的私聊：\n本人标识：${candidate.senderId}\n私聊标识：${candidate.target}`);
    if ((await ask("这是你刚才发送的私聊吗？[y/N] ")).toLowerCase() !== "y") return "cancelled";
    io.write(`保存预览：\n下次启动渠道：${file.enabledChannels().map((channel) => channel === "weixin" ? "微信" : "飞书").join("、")}\n本人：${candidate.senderId}\n私聊：${candidate.target}\n原微信绑定、记忆、权限和任务身份：保留\n配置位置：${options.configPath}\n文件仅限本机当前用户读写。${file.keptConfigurationSteps(appId).map((step) => `\n${step}`).join("")}`);
    if ((await ask("保存此配置？[y/N] ")).toLowerCase() !== "y") return "cancelled";
    controller.signal.throwIfAborted();
    await closeTransport();
    controller.signal.throwIfAborted();
    file.save(credentials, candidate);
    io.write("配置已保存。配对连接已关闭。\n正式服务尚未启动。使用同一私有状态目录启动服务，再在飞书发送消息验证回复。\n调整启用渠道：停服务，修改 enabledChannels，再启动。");
    return "saved";
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    const code = reason instanceof Error ? reason.message : "";
    if (code === "pairing_cancelled") return "cancelled";
    const messages: Record<string, string> = {
      pairing_busy: "已有配对命令或遗留配对锁；确认旧命令退出后再重试。",
      pairing_expired: "本次配对已超时，口令已失效。",
      pairing_configuration_changed: "保存已停止：配对期间原配置发生变化，请核对后重新运行。",
      pairing_legacy_identity_required: "未找到唯一可复用的原身份，请指定原服务状态目录并确认原微信绑定。",
      pairing_private_directory_required: "配置目录必须是仅限本人访问的现有私有目录。",
      pairing_unsafe_configuration: "配置文件类型、权限或大小不安全。",
    };
    io.write(messages[code] ?? "配对未完成，请检查应用凭据、网络、原配置和私有目录权限后重试。");
    io.write("原配置未被本次配对修改。");
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    await closeTransport().catch(() => { io.write("配对连接关闭失败，请退出该命令后再启动服务。"); });
    try { file?.close(); } catch { io.write("配对锁清理失败；恢复私有目录权限并确认没有配对命令运行后，移除配置旁的 .pairing-lock 文件。"); }
  }
}
