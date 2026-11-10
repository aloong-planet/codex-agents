import { spawnIsolatedAppServer } from "./isolated-model-runtime.js";
import { createIsolatedRuntime, type IsolatedConversationKind, isolatedConversationOptions, ISOLATED_RUNTIME_KINDS } from "./isolated-runtime-kinds.js";
import { loadFinanceConfiguration } from "./finance-config.js";
import { FinanceService } from "./finance-service.js";
import { CodexFinanceInterpreter, parseFinanceCommand, type FinanceInterpreter } from "./finance-interpreter.js";
import { MediaDeliveryRouter } from "./media-delivery-router.js";
import { ConversationChannelRouter } from "./conversation-channel-router.js";
import { PersonalOwnerDirectory } from "./personal-owner-identity.js";
import { WeixinConversationChannel } from "./weixin-conversation-channel.js";
import { WeixinTurnAdapter } from "./weixin-turn-adapter.js";
import { NotificationChannelRouter } from "./notification-channel-router.js";
import { createChannelStatusServer } from "./channel-status-server.js";
import { ConsoleAccess } from "./console-access.js";
import { ConsoleControlServer } from "./console-control.js";
import { FixtureFeishuTransport } from "./fixture-feishu-transport.js";
import { loadChannelStartupConfiguration, type ChannelStartupEntry } from "./channel-startup-config.js";
import { FeishuChannel } from "./feishu-channel.js";
import { FeishuSdkTransport } from "./feishu-sdk-transport.js";
import { FeishuWebhookTransport } from "./feishu-webhook-transport.js";
import { FeishuWebhookReceiver } from "./feishu-webhook-receiver.js";
import { FeishuInboundMedia } from "./feishu-inbound-media.js";
import { FeishuMediaDelivery } from "./feishu-media-delivery.js";
import { ConversationService } from "./conversation-service.js";
import { ChannelTurnAdapter } from "./channel-turn-adapter.js";
import { ConversationWorkflowTriggerAdapter } from "./conversation-workflow-trigger-adapter.js";
import { bindWeixinOwner } from "./owner-bound-weixin-channel.js";
import type { MediaDeliveryPort } from "./media-delivery.js";
import { WeixinNotificationChannel } from "./weixin-notification-channel.js";
import { WeixinMediaDelivery } from "./weixin-media-delivery.js";
import { createScheduledResearch } from "./scheduled-research.js";
import { ScheduledTasks } from "./scheduled-tasks.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiagnosticFiles } from "./diagnostic-files.js";
import { LocalDiagnostics } from "./local-diagnostics.js";
import { settleCleanup } from "./async-cleanup.js";

import QRCode from "qrcode";

import { probeAppServerCapabilities } from "./app-server-capabilities.js";
import { AccountMemoryStore } from "./account-memory-store.js";
import { AccountMemorySearchIndex, LocalTransformersMemoryEmbedder, Qwen3MemoryEmbeddingProfile } from "./account-memory-search-index.js";
import { AccountMemorySystem, type AccountMemoryCurator } from "./account-memory-system.js";
import { AccountMemoryToolHost } from "./account-memory-tool-host.js";
import { CodexConversation } from "./codex-conversation.js";
import {
  CodexAccountMemoryCurator,
  MEMORY_CURATOR_DISABLED_FEATURES,
  MEMORY_CURATOR_RUNTIME_PROFILE,
} from "./codex-account-memory-curator.js";
import { MacCodexDesktopNavigator } from "./codex-desktop.js";
import { AutoBindingFileStore } from "./auto-binding-store.js";
import {
  CodexCliNewsResearcher,
  CodexHackerNewsResearcher,
  CombinedNewsResearcher,
  createCodexCliNewsRun,
} from "./codex-news-researcher.js";
import { CodexServiceStore } from "./codex-service-store.js";
import {
  CaffeinateWakeLock,
  ContextTokenExpiryExperiment,
  FileContextTokenExperimentStore,
} from "./context-token-expiry-experiment.js";
import type { AiNewsResearcher } from "./daily-ai-news-scheduler.js";
import { DailyNewsHandoff } from "./daily-news-handoff.js";
import { ManagedDailyAiNews } from "./managed-daily-ai-news.js";
import { DemoService, type WeixinChannel } from "./demo-service.js";
import { DirectMarkdownVault } from "./direct-markdown-vault.js";
import { DirectIlinkChannel } from "./direct-ilink-channel.js";
import { DurableInboundStore } from "./durable-inbound-store.js";
import { DurableEffectLedger } from "./durable-effect-ledger.js";
import { FixturePort } from "./fixture-port.js";
import { FixtureAppServerTransport, type FixtureModelToolCallQueue } from "./fixture-app-server-transport.js";
import { AgentDispatch } from "./agent-dispatch.js";
import { CodexDispatchClassifier, parseDispatchDecision } from "./agent-dispatch-classifier.js";
import { closeDispatchRuntime, CodexDispatchExecutor, DISPATCH_RUNTIME_IDLE_MS, DISPATCH_RUNTIME_LIMIT, executorEvent, type DispatchRuntime } from "./agent-dispatch-executor.js";
import { compactRuntimeHome } from "./runtime-home-compaction.js";
import { RuntimePool } from "./runtime-pool.js";
import { acceptingTeams, COORDINATOR_ID, TeamRegistry, type TeamDefinitions } from "./team-registry.js";
import { TeamManagement } from "./team-management.js";
import { TeamAnnouncements } from "./team-announcements.js";
import { FeishuHttpOnboardingPlatform, FixtureOnboardingPlatform } from "./team-onboarding.js";
import { DispatchGroupSettings, unfinishedRequestsByGroup } from "./dispatch-group-settings.js";
import { GroupNames } from "./group-names.js";
import type { FeishuDispatchConfiguration } from "./feishu-agent-config.js";
import { CodexTeamLeader, type TeamLeader } from "./agent-dispatch-leader.js";
import { FixtureTeamLeader, fixtureDefaultClosing, fixtureDefaultPlan, fixtureDefaultSupplement } from "./fixture-team-leader.js";
import type { LeaderAssignmentReport, LeaderAssignmentView } from "./agent-dispatch-leader.js";
import { DISPATCH_MEMORY_ACCOUNT_PREFIX, memoryAccountId, ProfileToolHost, resolveAgentProfile, type AgentMemoryScope } from "./agent-profile.js";
import type { DynamicToolHost } from "./dynamic-tool-host.js";
import { createDemoServer } from "./http-server.js";
import { ConsoleAudit } from "./console-audit.js";
import { createConsoleRoutes } from "./console-routes.js";
import { McpCatalog } from "./mcp-catalog.js";
import { NewsArchive } from "./news-archive.js";
import { NativeWriteGuard } from "./native-write-guard.js";
import { PrivateStateStore } from "./private-state-store.js";
import { PlanFollowUpMonitor } from "./plan-follow-up-monitor.js";
import { resolvePrivateStatePath, serviceProtectedRoots } from "./runtime-paths.js";
import {
  resolveCodexExecutable,
  spawnStdioAppServer,
} from "./stdio-app-server-transport.js";
import { WeixinCodexService, type CodexAgent, type InboundWorkflowControl } from "./weixin-codex-service.js";
import { TurnSnapshotStore } from "./turn-snapshot-store.js";
import { IlinkMediaStore } from "./ilink-media.js";
import { LocalFileTools } from "./local-file-tools.js";
import { MacLocalNotifier } from "./local-notifier.js";
import { MediaExportLibrary } from "./media-export-library.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { WorkflowMediaArtifactStore } from "./workflow-media-artifact-store.js";
import { WorkflowMediaProvider } from "./workflow-media-provider.js";
import { WorkflowMediaPermissionBridge } from "./workflow-media-permission-bridge.js";
import { WorkflowMediaRequestStore } from "./workflow-media-request-store.js";
import { WorkflowModulePermissionStore } from "./workflow-module-permission-store.js";
import { WorkflowModulePermissionSettings } from "./workflow-module-permission-settings.js";
import { WorkflowNoteArtifactStore } from "./workflow-note-artifact-store.js";
import { WorkflowFileArtifactStore } from "./workflow-file-artifact-store.js";
import { WorkflowFileSendProvider } from "./workflow-file-send-provider.js";
import { WorkflowFileSendStore } from "./workflow-file-send-store.js";
import {
  WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW,
  WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW,
  WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW,
  WEIXIN_SEND_FILES_WORKFLOW,
} from "./workflow-file-send-intent.js";
import { WorkflowNotesProvider } from "./workflow-notes-provider.js";
import { NOTES_SEND_FILE_WORKFLOW } from "./workflow-notes-send-intent.js";
import { MEDIA_SEND_IMAGE_WORKFLOW } from "./workflow-media-send-intent.js";
import { WorkflowRunTargetStore } from "./workflow-run-target-store.js";
import { WorkflowRetirementNotifier } from "./workflow-retirement-notifier.js";
import { WorkflowPendingPresentationStore } from "./workflow-pending-presentation-store.js";
import {
  CodexPendingResponseRouter,
  FixturePendingResponseRouter,
  PENDING_RESPONSE_DISABLED_FEATURES,
  PENDING_RESPONSE_RUNTIME_PROFILE,
} from "./workflow-pending-response-router.js";
import type { PendingResponseRouter } from "./workflow-pending-response-coordinator.js";
import { pendingRequestTextHash } from "./workflow-pending-response-coordinator.js";
import { renderWorkflowRun } from "./workflow-reply-renderer.js";
import { WEIXIN_NOTE_SEARCH_WORKFLOW, WEIXIN_NOTE_SEND_FILE_WORKFLOW } from "./weixin-workflow-router.js";
import { WeixinWorkflowTriggerAdapter } from "./weixin-workflow-trigger-adapter.js";
import { createProductionWorkflowToolCatalog } from "./workflow-tool-catalog.js";
import { WorkflowToolGateway } from "./workflow-tool-gateway.js";
import { WorkflowToolHost } from "./workflow-tool-host.js";
import {
  createMediaSendToolRegistration,
  createWeixinSendFilesToolRegistration,
  createWorkflowToolReplyProjector,
  MAIN_WEIXIN_DISABLED_FEATURES,
  WorkflowToolProductionControl,
} from "./workflow-tool-production.js";

const host = "127.0.0.1";
const port = Number(process.env.PORT ?? "4317");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT 必须是 1 到 65535 的整数");
}

const fixtureMode = process.env.DEMO_MODE === "fixture";
// Fixture-only seam: real Coordinator and Team Leader runtimes over the fixture App Server. Refused outside fixture mode.
const fixtureCoordinationRuntime = process.env.WORKFLOW_FIXTURE_COORDINATION_RUNTIME === "1";
if (fixtureCoordinationRuntime && !fixtureMode) throw new Error("fixture_switch_outside_fixture_mode");
// Fixture-only seam: Executor home compaction stops after its first removal, so a case can kill the service mid-compaction.
const fixtureCompactionHold = process.env.WORKFLOW_FIXTURE_COMPACTION_HOLD === "1";
if (fixtureCompactionHold && !fixtureMode) throw new Error("fixture_switch_outside_fixture_mode");
// Fixture-only seam: the fake onboarding platform's answers before startup resumes onboarding.
if (process.env.WORKFLOW_FIXTURE_FEISHU_ONBOARDING && !fixtureMode) throw new Error("fixture_switch_outside_fixture_mode");
const fixtureLiveMainModel = fixtureMode && process.env.WORKFLOW_SIMULATOR_MODEL === "live";
const fixtureLiveWorkflowAgents = fixtureLiveMainModel ||
  (fixtureMode && process.env.WORKFLOW_SIMULATOR_PENDING_ROUTER === "live");
const privateStatePath = fixtureMode
  ? path.join(process.env.WORKFLOW_FIXTURE_STATE_DIRECTORY
      ? fs.realpathSync(process.env.WORKFLOW_FIXTURE_STATE_DIRECTORY)
      : fs.mkdtempSync(path.join(os.tmpdir(), "weixin-demo-fixture-")), "state.json")
  : resolvePrivateStatePath(process.env, os.homedir());
// Fixture mode is an explicit, non-network test entry. Production requires an explicit selector and owner binding.
const channelConfigurationPath = path.resolve(process.env.CHANNEL_CONFIG_PATH ?? path.join(path.dirname(privateStatePath), "channel.json"));
const channelConfiguration = fixtureMode && !process.env.CHANNEL_CONFIG_PATH ? undefined : loadChannelStartupConfiguration(channelConfigurationPath);
const durableInboundStore = new DurableInboundStore(
  path.join(path.dirname(privateStatePath), "inbound.sqlite"),
);
const diagnosticNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const diagnosticDirectory = process.env.WEIXIN_OTEL_DIRECTORY ?? (fixtureMode
  ? path.join(path.dirname(privateStatePath), "otel")
  : path.join(os.homedir(), "Library", "Logs", "codex-weixin", "otel"));
const diagnostics = process.env.WEIXIN_OTEL_ENABLED === "0" ? undefined : new LocalDiagnostics(new DiagnosticFiles(
  diagnosticDirectory,
  {
    retentionMs: diagnosticNumber("WEIXIN_OTEL_RETENTION_DAYS", 7) * 86_400_000,
    maxFileBytes: diagnosticNumber("WEIXIN_OTEL_MAX_FILE_MIB", 20) * 1024 ** 2,
    maxTotalBytes: diagnosticNumber("WEIXIN_OTEL_MAX_TOTAL_MIB", 200) * 1024 ** 2,
    maxFiles: diagnosticNumber("WEIXIN_OTEL_MAX_FILES", 512),
  },
));
diagnostics?.checkpoint("service.lifecycle", { status: "started" });
const durableEffectLedger = new DurableEffectLedger(
  path.join(path.dirname(privateStatePath), "effects.sqlite"),
);
const weixinConfiguration = channelConfiguration?.entries.find((entry) => entry.channel === "weixin");
const workflowToolCatalog = createProductionWorkflowToolCatalog({
  files: false,
  media: true,
  directFiles: true,
  delivery: true,
  schedules: true,
});
// Every reader of the dispatch roster takes it from the team registry; local `feishu.dispatch` only feeds the registry's import
// until the first console save. Team management keeps the registry open, applies console saves and onboarding while the service
// runs, and every dispatch reader takes the current definitions from it (team-management spec; ticket 11, decision D5).
const consoleStateDirectory = path.dirname(privateStatePath);
const consoleAudit = new ConsoleAudit({ directory: consoleStateDirectory });
// In fixture mode the onboarding platform is the fake; WORKFLOW_FIXTURE_FEISHU_ONBOARDING sets its answers before startup resumes onboarding.
const fixtureOnboarding = fixtureMode ? new FixtureOnboardingPlatform() : undefined;
if (fixtureOnboarding && process.env.WORKFLOW_FIXTURE_FEISHU_ONBOARDING) fixtureOnboarding.configure(JSON.parse(process.env.WORKFLOW_FIXTURE_FEISHU_ONBOARDING));
const onboardingPlatform = fixtureOnboarding ?? new FeishuHttpOnboardingPlatform();
// Group names read with Sam's application, shared by team management and the dispatch-group form, which also shows them without dispatch.
const pairedFeishu = channelConfiguration?.entries.find((candidate) => candidate.channel === "feishu");
const groupNames = pairedFeishu ? new GroupNames(onboardingPlatform, pairedFeishu.connection) : undefined;
let teamManagement: TeamManagement | undefined;
// Set once the dispatch applications exist; a roster change before that has nothing to start.
let applyRoster: (roster: Readonly<FeishuDispatchConfiguration>) => void = () => {};
let countActiveAssignments: () => Readonly<Record<string, number>> = () => ({});
// Penny's application, read from its configuration at startup; no team may use it (ADR-0025, team-management::REQ-002).
let pennyApplicationId: string | undefined;
// With dispatch, the entry carries the registry's roster, so every reader sees the Coordinator and the teams with an application.
type FeishuStartupEntry = Omit<Extract<ChannelStartupEntry, { channel: "feishu" }>, "dispatch"> & { dispatch?: Readonly<FeishuDispatchConfiguration> };
const feishuConfiguration = ((): FeishuStartupEntry | undefined => {
  const entry = channelConfiguration?.entries.find((candidate) => candidate.channel === "feishu");
  if (!entry) return undefined;
  const { dispatch: local, ...rest } = entry;
  if (!local) return rest;
  const registry = new TeamRegistry(path.join(path.dirname(privateStatePath), "team-registry.sqlite"));
  try {
    registry.importLocalConfiguration(local, { executorHostTools: workflowToolCatalog.memberIds(), coordinatorAppId: entry.connection.appId });
    const management = new TeamManagement({ registry, coordinator: entry.connection,
      platform: onboardingPlatform, ...(groupNames ? { groupNames } : {}),
      announcements: new TeamAnnouncements(path.join(path.dirname(privateStatePath), "team-announcements.sqlite")),
      audit: consoleAudit, catalogToolIds: workflowToolCatalog.memberIds(),
      moduleScopes: () => ["notes", "local-media"].flatMap((moduleId) => {
        const state = workflowModulePermissions.get(moduleId);
        return state?.saved ? state.scopes.map(({ read, write }) => ({ read, write })) : [];
      }),
      activeAssignments: () => countActiveAssignments(),
      rosterChanged: (roster) => applyRoster(roster),
      reservedApplications: () => pennyApplicationId ? { [pennyApplicationId]: "该飞书应用已用于 Penny，不能用于团队" } : {},
      report: (code) => process.stderr.write(`${code}\n`) });
    teamManagement = management;
    return Object.freeze({ ...rest, dispatch: management.roster() });
  } catch (error) { registry.close(); throw error; }
})();
const directChannel = fixtureMode || !weixinConfiguration
  ? undefined
  : new DirectIlinkChannel({
        ...(diagnostics ? { diagnostics } : {}),
        store: new PrivateStateStore(privateStatePath),
        ...(durableInboundStore ? { inboundStore: durableInboundStore } : {}),
        effectLedger: durableEffectLedger,
        mediaStore: new IlinkMediaStore(path.dirname(privateStatePath)),
      });
const fixturePort = fixtureMode && (!channelConfiguration || weixinConfiguration !== undefined) ? new FixturePort(durableInboundStore, process.env.WORKFLOW_FIXTURE_WEIXIN_START_FAILURE === "1") : undefined;
const fixtureFeishu = fixtureMode && feishuConfiguration !== undefined ? new FixtureFeishuTransport(process.env.WORKFLOW_FIXTURE_FEISHU_START_FAILURE === "1") : undefined;
const channelPort: WeixinChannel | undefined = directChannel
  ? bindWeixinOwner(directChannel, weixinConfiguration!.owner) : fixturePort;
const feishuTransport = feishuConfiguration ? (() => {
  const outbound = fixtureFeishu ?? new FeishuSdkTransport({ ...feishuConfiguration.connection,
    ...(feishuConfiguration.webhook ? { mode: "outbound" as const } : {}) });
  if (!feishuConfiguration.webhook) return outbound;
  if (feishuConfiguration.webhook.port === port) throw new Error("feishu_webhook_admin_port_conflict");
  return new FeishuWebhookTransport(outbound, new FeishuWebhookReceiver({ ...feishuConfiguration.webhook,
    appId: feishuConfiguration.connection.appId, databasePath: path.join(path.dirname(privateStatePath), "feishu-callbacks.sqlite") },
  (code) => process.stderr.write(`${code}\n`)));
})() : undefined;
const feishuInboundMedia = feishuConfiguration ? new FeishuInboundMedia(
  path.join(path.dirname(privateStatePath), "media", "inbound", "feishu", feishuConfiguration.owner.contextHash()),
  feishuConfiguration.binding.target, feishuTransport!) : undefined;
const feishuChannel = feishuConfiguration
  ? new FeishuChannel(feishuConfiguration, feishuTransport!,
      durableInboundStore, durableEffectLedger, (code) => process.stderr.write(`${code}\n`), Date.now, feishuInboundMedia)
  : undefined;
type DispatchApplication = { agentId: string; appSecret: string; transport: FeishuSdkTransport | FixtureFeishuTransport; ready: boolean };
// One outbound application per Team Leader, keyed by App ID. A team saved while the service runs gets one through applyRoster.
const createDispatchApplication = (agent: Readonly<{ id: string; appId: string; appSecret: string }>): DispatchApplication => ({ agentId: agent.id, appSecret: agent.appSecret,
  transport: fixtureMode ? new FixtureFeishuTransport(false, `ou_fixture${agent.id.replace(/[^A-Za-z0-9]/g, "")}`)
    : new FeishuSdkTransport({ appId: agent.appId, appSecret: agent.appSecret, mode: "outbound" }), ready: false });
const dispatchApplications = new Map((feishuConfiguration?.dispatch?.agents.filter(({ id }) => id !== COORDINATOR_ID) ?? [])
  .map((agent) => [agent.appId, createDispatchApplication(agent)] as const));
// Fixture inputs address Team Leader applications, Sam's own and Penny's by agent ID.
const fixtureExtraApplications: Array<readonly [string, FixtureFeishuTransport]> = [];
const bindFixtureApplications = () => fixtureFeishu?.bindApplications(new Map([
  ...[...dispatchApplications.values()].flatMap(({ agentId, transport }) => transport instanceof FixtureFeishuTransport ? [[agentId, transport] as const] : []),
  ...(fixtureFeishu ? [[COORDINATOR_ID, fixtureFeishu] as const] : []), ...fixtureExtraApplications]));
bindFixtureApplications();
if (fixtureFeishu && fixtureOnboarding) fixtureFeishu.bindOnboarding(fixtureOnboarding);
/** Starts a Team Leader's outbound application and confirms its bot identity; it posts only once ready. */
const startDispatchApplication = async (application: DispatchApplication): Promise<void> => {
  try {
    await application.transport.start({ message: async () => {}, ready: () => { application.ready = true; }, unavailable: () => { application.ready = false; } });
    const botId = await application.transport.botOpenId();
    if (!botId || !/^ou_[A-Za-z0-9]+$/.test(botId)) throw new Error("agent_identity_unavailable");
    application.ready = true;
  } catch { application.ready = false; process.stderr.write("dispatch_application_unavailable\n"); }
};
const activeChannels = [
  ...(channelPort ? [{ name: "weixin" as const, port: channelPort, owner: weixinConfiguration?.owner }] : []),
  ...(feishuChannel ? [{ name: "feishu" as const, port: feishuChannel, owner: feishuConfiguration!.owner }] : []),
];
const startedChannels = new Set<string>();
const notificationRoute = channelConfiguration?.notificationRoute;
let channelReady = false;


// Fixture business files sit beside the state directory, never inside it: file tools refuse the whole state directory.
const fixtureBusinessRoot = fixtureMode && process.env.WORKFLOW_FIXTURE_BUSINESS_DIRECTORY
  ? fs.realpathSync(process.env.WORKFLOW_FIXTURE_BUSINESS_DIRECTORY) : `${path.dirname(privateStatePath)}-business`;
const vaultRoot = fixtureMode
  ? path.join(fixtureBusinessRoot, "demo-vault")
  : "/Users/loong_zhou/Documents/demo/demo";
if (fixtureMode && !fs.existsSync(vaultRoot)) {
  fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "news", "2026-08-12"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultRoot, "news", "2026-08-12", "摘要.md"),
    "# 2026-08-12 摘要\n\nfixture 文件发送工作流验证。\n",
    { mode: 0o600 },
  );
  fs.mkdirSync(path.join(vaultRoot, "notes"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "notes", "Agent Alpha.md"), "# Agent Alpha\n", { mode: 0o600 });
  fs.writeFileSync(path.join(vaultRoot, "notes", "Agent Beta.md"), "# Agent Beta\n", { mode: 0o600 });
}
const markdownVault = new DirectMarkdownVault(vaultRoot);
const mediaReadRoot = path.join(path.dirname(privateStatePath), "media", "inbound");
fs.mkdirSync(mediaReadRoot, { recursive: true, mode: 0o700 });
const newsArchive = fixtureMode
  ? new NewsArchive(markdownVault, async () => ({
      title: "Fixture AI 新闻",
      markdown: "这是 fixture 模式下用于端到端验证的本地完整正文，包含背景、实现、证据、影响和限制，不会访问任何外部网页。",
    }))
  : new NewsArchive(markdownVault);
const runtimeWorkspaceRoots = [process.cwd(), vaultRoot];
const codexExecutable = resolveCodexExecutable(process.env);
const appServerCapabilities = fixtureMode
  ? {
      restrictedReadSupported: true,
      namedPermissionsSupported: true,
      structuredOutputSupported: true,
    }
  : probeAppServerCapabilities(codexExecutable);
const writeGuard = new NativeWriteGuard(
  runtimeWorkspaceRoots,
  new TurnSnapshotStore(path.dirname(privateStatePath), runtimeWorkspaceRoots),
);
const mediaExportHome = fixtureMode
  ? path.join(fixtureBusinessRoot, "fixture-media-home")
  : os.homedir();
if (fixtureMode && !fs.existsSync(mediaExportHome)) {
  for (const directory of ["Downloads", "Pictures", "Documents"]) {
    fs.mkdirSync(path.join(mediaExportHome, directory), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(path.join(mediaExportHome, "Pictures", "holiday.png"), "fixture image", { mode: 0o600 });
  fs.writeFileSync(path.join(mediaExportHome, "Pictures", "album-a.png"), "fixture image a", { mode: 0o600 });
  fs.writeFileSync(path.join(mediaExportHome, "Pictures", "album-b.png"), "fixture image b", { mode: 0o600 });
  for (let index = 0; index < 19; index += 1) {
    const staleImage = path.join(mediaExportHome, "Pictures", `fixture-stale-${String(index).padStart(2, "0")}.png`);
    fs.writeFileSync(staleImage, `fixture stale image ${index}`, { mode: 0o600 });
    fs.utimesSync(staleImage, 1_700_000_000 + index, 1_700_000_000 + index);
  }
  fs.writeFileSync(path.join(mediaExportHome, "Downloads", "globally-newest.png"), "fixture outside pictures", { mode: 0o600 });
  fs.utimesSync(path.join(mediaExportHome, "Pictures", "holiday.png"), 1_700_000_000, 1_700_000_000);
  fs.utimesSync(path.join(mediaExportHome, "Pictures", "album-a.png"), 1_800_000_000, 1_800_000_000);
  fs.utimesSync(path.join(mediaExportHome, "Pictures", "album-b.png"), 1_900_000_000, 1_900_000_000);
  fs.utimesSync(path.join(mediaExportHome, "Downloads", "globally-newest.png"), 2_000_000_000, 2_000_000_000);
}
const mediaExports = new MediaExportLibrary(
  path.join(path.dirname(privateStatePath), "media-export-grants.json"),
  mediaExportHome,
);
if (fixtureMode && !fs.existsSync(path.join(path.dirname(privateStatePath), "media-export-grants.json"))) {
  mediaExports.configure({ rootIds: ["downloads", "pictures", "documents"], confirmed: true });
}
const workflowRunTargets = new WorkflowRunTargetStore(
  path.join(path.dirname(privateStatePath), "workflow-targets.sqlite"),
);
const workflowDatabasePath = path.join(path.dirname(privateStatePath), "workflows.sqlite");
const initializeFixtureWorkflow = fixtureMode && !fs.existsSync(workflowDatabasePath);
const workflowPendingPresentations = new WorkflowPendingPresentationStore(workflowDatabasePath);
const workflowMediaArtifactRoot = path.join(path.dirname(privateStatePath), "workflow-media-artifacts");
const workflowMediaArtifacts = new WorkflowMediaArtifactStore(
  workflowMediaArtifactRoot,
  mediaExports,
  Date.now,
  24 * 60 * 60 * 1_000,
  mediaReadRoot,
);
const workflowMediaRequests = new WorkflowMediaRequestStore(
  path.join(path.dirname(privateStatePath), "workflow-media-requests"),
  workflowMediaArtifacts,
);
const workflowModulePermissions = new WorkflowModulePermissionStore(
  path.join(path.dirname(privateStatePath), "workflow-module-permissions.sqlite"),
);
const workflowFileArtifactRoot = path.join(path.dirname(privateStatePath), "workflow-file-artifacts");
const weixinMediaDelivery = directChannel ? ((): MediaDeliveryPort => {
  const delivery = new WeixinMediaDelivery(directChannel);
  return {
    sendImage: (input) => startedChannels.has("weixin") && weixinConfiguration!.owner.ownsAddress(input.accountId, input.target)
      ? delivery.sendImage(input) : Promise.resolve({ ok: false, reason: "unavailable", acceptedSegments: 0 }),
    sendFile: (input) => startedChannels.has("weixin") && weixinConfiguration!.owner.ownsAddress(input.accountId, input.target)
      ? delivery.sendFile(input) : Promise.resolve({ ok: false, reason: "unavailable", acceptedSegments: 0 }),
    reconcile: (operationId) => delivery.reconcile(operationId),
  };
})() : undefined;
// A Team Leader's media goes through whichever application currently has its App ID: one replaced for a new secret, or created
// again when a team returns to an App ID it used before. An App ID no team uses has none, so its media fails (agent-dispatch::REQ-008/AC-04).
const teamMediaTransport = (appId: string): import("./feishu-media-delivery.js").FeishuMediaTransport => {
  const current = () => {
    const application = dispatchApplications.get(appId);
    if (!application) throw new Error("dispatch_application_unavailable");
    return application.transport;
  };
  return { upload: (input) => current().upload(input), sendResource: (input) => current().sendResource(input) };
};
// One media route per conversation and sending identity, kept for the service's life; a Team Leader saved while the service
// runs adds its own routes once per App ID.
const mediaRoutedApplications = new Set<string>();
const feishuMediaRoute = (destination: import("./media-delivery.js").MediaDeliveryDestination) => ({
  destination,
  delivery: new FeishuMediaDelivery(feishuConfiguration!, destination.senderAccountId && destination.senderAccountId !== feishuConfiguration!.connection.appId
    ? teamMediaTransport(destination.senderAccountId) : feishuTransport!, durableEffectLedger,
  [path.join(workflowMediaArtifactRoot, "snapshots"), path.join(workflowFileArtifactRoot, "snapshots"),
    feishuInboundMedia!.readableRoot(feishuConfiguration!.owner.deliveryTarget(destination.accountId, destination.target)!)],
  () => startedChannels.has("feishu") && feishuChannel!.state({ ...destination, channel: "feishu" }).enabled, destination),
});
const dispatchConversations = () => feishuConfiguration?.owner.conversationAddresses().filter(({ target }) => feishuChannel!.usesAgentDispatch(target)) ?? [];
const feishuMediaRoutes = feishuTransport && feishuConfiguration ? feishuConfiguration.owner.conversationAddresses().flatMap((address) => [address,
  ...(feishuChannel!.usesAgentDispatch(address.target) ? feishuConfiguration.dispatch!.agents.map(({ appId }) => ({ ...address, senderAccountId: appId })) : [])]
  .map(feishuMediaRoute)) : [];
for (const { appId } of feishuConfiguration?.dispatch?.agents ?? []) mediaRoutedApplications.add(appId);
const localFileTools = new LocalFileTools(workflowModulePermissions, {
  protectedRoots: serviceProtectedRoots(process.env, os.homedir(), path.dirname(privateStatePath), diagnosticDirectory),
  ...(fixtureMode && process.env.WORKFLOW_FIXTURE_FILE_SCAN_LIMIT
    ? { budget: { maxScannedFiles: Number(process.env.WORKFLOW_FIXTURE_FILE_SCAN_LIMIT) } } : {}),
  diagnostics,
  moduleIds: ["notes", "local-media"],
  spoolDirectory: path.join(workflowFileArtifactRoot, "snapshots"),
  operationDatabasePath: path.join(path.dirname(privateStatePath), "local-file-operations.sqlite"),
});
const workflowMediaPermissions = new WorkflowMediaPermissionBridge(mediaExports, workflowModulePermissions);
const workflowNoteArtifacts = new WorkflowNoteArtifactStore(
  path.join(path.dirname(privateStatePath), "workflow-note-artifacts"),
);
const workflowFileArtifacts = new WorkflowFileArtifactStore(
  workflowFileArtifactRoot,
  workflowModulePermissions,
);
const workflowFileSendManifests = new WorkflowFileSendStore(
  path.join(path.dirname(privateStatePath), "workflow-file-send-manifests"),
);
const workflowFileSendProvider = new WorkflowFileSendProvider(
  workflowFileSendManifests,
  workflowFileArtifacts,
  localFileTools,
  workflowRunTargets,
);
let pendingResponseAgent: CodexConversation | undefined;
let pendingResponseRouter: PendingResponseRouter | undefined;
if (!appServerCapabilities.namedPermissionsSupported || !appServerCapabilities.structuredOutputSupported) {
  process.stderr.write("当前 Codex App Server 权限协议不兼容；自然语言候选选择已停用。\n");
} else if (fixtureMode && !fixtureLiveWorkflowAgents) {
  pendingResponseRouter = new FixturePendingResponseRouter();
} else {
  try {
    const pendingResponseCwd = path.join(path.dirname(privateStatePath), "pending-response-runtime");
    fs.mkdirSync(pendingResponseCwd, { recursive: true, mode: 0o700 });
    pendingResponseAgent = new CodexConversation(
      () => spawnStdioAppServer(codexExecutable, PENDING_RESPONSE_DISABLED_FEATURES),
      600_000,
      undefined,
      undefined,
      300_000,
      {
        serviceName: "weixin_pending_response_router",
        webSearch: "disabled",
        runtimeProfile: PENDING_RESPONSE_RUNTIME_PROFILE,
      },
    );
    pendingResponseRouter = new CodexPendingResponseRouter(pendingResponseAgent, pendingResponseCwd);
  } catch {
    try { await pendingResponseAgent?.close(); } catch { /* router cleanup is best effort */ }
    pendingResponseAgent = undefined;
    process.stderr.write("自然语言候选选择暂不可用；明确序号选择保持可用。\n");
  }
}
const workflowNotesProvider = new WorkflowNotesProvider(
  markdownVault,
  vaultRoot,
  workflowNoteArtifacts,
  workflowModulePermissions,
  workflowFileArtifacts,
);
const fixtureWeixinDelivery = fixturePort ? new WeixinMediaDelivery({
        sendImage: async (input) => {
          const candidate = fs.realpathSync(input.filePath);
          const roots = [mediaExportHome, mediaReadRoot, path.join(workflowMediaArtifactRoot, "snapshots")]
            .filter((root) => fs.existsSync(root))
            .map((root) => fs.realpathSync(root));
          if (!roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))) {
            return { ok: false, reason: "rejected" };
          }
          fixturePort.recordFixtureImage({ fileName: path.basename(input.filePath), displayPath: path.basename(input.filePath) });
          return { ok: true, messageId: "fixture-workflow-image" };
        },
        sendFile: async (input) => {
          const roots = [vaultRoot, path.join(workflowFileArtifactRoot, "snapshots")]
            .filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
          const authorized = roots.some((root) => {
            const relative = path.relative(root, fs.realpathSync(input.filePath));
            return Boolean(relative) && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`);
          });
          if (!authorized) {
            return { ok: false, reason: "rejected" };
          }
          const fileName = input.fileName ?? path.basename(input.filePath);
          fixturePort.recordFixtureFile({ fileName, displayPath: fileName });
          return { ok: true, messageId: "fixture-workflow-file" };
        },
        reconcileMediaOperation: async () => ({ status: "accepted" }),
      }) : undefined;
const selectedMediaDelivery: MediaDeliveryPort = channelConfiguration ? new MediaDeliveryRouter([
  ...(weixinConfiguration && (weixinMediaDelivery ?? fixtureWeixinDelivery) ? [{ destination: weixinConfiguration.owner.conversationAddress(), delivery: (weixinMediaDelivery ?? fixtureWeixinDelivery)! }] : []),
  ...feishuMediaRoutes,
]) : fixtureWeixinDelivery!;
const workflowEngine = new WorkflowEngine(
  workflowDatabasePath,
  fixtureMode
    ? {
        ...(diagnostics ? { diagnostics } : {}),
        templates: [{
          id: "fixture.status-check",
          version: 1,
          maxSteps: 2,
          maxDepth: 2,
          maxParallelism: 1,
          effectBudget: { read: 2 },
          steps: [
            { id: "inspect", capability: "fixture.inspect", capabilityVersion: 1, timeoutMs: 1_000 },
            { id: "summarize", capability: "fixture.summarize", capabilityVersion: 1, dependsOn: ["inspect"], timeoutMs: 1_000 },
          ],
        }, NOTES_SEND_FILE_WORKFLOW, WEIXIN_SEND_FILES_WORKFLOW, WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW,
        WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW, WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW,
        MEDIA_SEND_IMAGE_WORKFLOW],
        providers: [{
          catalog: () => [
            { id: "fixture.inspect", version: 1, effect: "read" as const, retryClass: "pure" as const, inputSchema: { type: "object" as const }, outputSchema: { type: "string" as const } },
            { id: "fixture.summarize", version: 1, effect: "read" as const, retryClass: "pure" as const, inputSchema: { type: "object" as const }, outputSchema: { type: "string" as const } },
          ],
          invoke: async (request) => ({ status: "succeeded" as const, output: request.capabilityId === "fixture.inspect" ? "ready" : "complete" }),
        }, workflowFileSendProvider, new WorkflowMediaProvider(mediaExports, workflowMediaArtifacts, workflowRunTargets, selectedMediaDelivery, workflowFileArtifacts, workflowMediaRequests, localFileTools)],
        modulePermissions: workflowModulePermissions,
        onRunAccepted: ({ runId, trigger }) => {
          if (trigger.accountRef === undefined && trigger.targetRef === undefined) return;
          if (!trigger.accountRef || !trigger.targetRef) throw new Error("workflow_run_target_incomplete");
          workflowRunTargets.bind(runId, trigger.accountRef, trigger.targetRef, trigger.senderAccountId);
        },
      }
    : {
        ...(diagnostics ? { diagnostics } : {}),
        templates: [
          WEIXIN_NOTE_SEARCH_WORKFLOW,
          WEIXIN_NOTE_SEND_FILE_WORKFLOW,
          NOTES_SEND_FILE_WORKFLOW,
          MEDIA_SEND_IMAGE_WORKFLOW,
          WEIXIN_SEND_FILES_WORKFLOW,
          WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW,
          WEIXIN_SEND_LOCAL_IMAGES_WORKFLOW,
          WEIXIN_SEND_LOCAL_IMAGES_SINGLE_CHOICE_WORKFLOW,
        ],
        providers: [
          new WorkflowMediaProvider(
            mediaExports,
            workflowMediaArtifacts,
            workflowRunTargets,
            selectedMediaDelivery,
            workflowFileArtifacts,
            workflowMediaRequests,
            localFileTools,
          ),
          workflowFileSendProvider,
          workflowNotesProvider,
        ],
        modulePermissions: workflowModulePermissions,
        onRunAccepted: ({ runId, trigger }) => {
          if (trigger.accountRef === undefined && trigger.targetRef === undefined) return;
          if (!trigger.accountRef || !trigger.targetRef) throw new Error("workflow_run_target_incomplete");
          workflowRunTargets.bind(runId, trigger.accountRef, trigger.targetRef, trigger.senderAccountId);
        },
      },
);
const workflowRetirementNotifier = channelPort ? new WorkflowRetirementNotifier(workflowEngine, workflowRunTargets, channelPort) : undefined;
const inboundWorkflows: InboundWorkflowControl = new WeixinWorkflowTriggerAdapter({
  engine: workflowEngine,
  ...(pendingResponseRouter ? { pendingResponseRouter } : {}),
  pendingPresentations: workflowPendingPresentations,
});
const codexServiceStore = new CodexServiceStore(path.join(path.dirname(privateStatePath), "codex-service.json"));
const newsResearcher: AiNewsResearcher = fixtureMode
  ? {
      generate: async (window) => {
        const digest = {
          date: window.date,
          generatedAt: Date.now(),
          hackerNewsTopCapturedAt: Date.now(),
          hackerNewsTop: Array.from({ length: 5 }, (_, index) => ({
            rank: index + 1,
            title: `Fixture HN Story ${index + 1}`,
            source: "example.com",
            url: `https://example.com/fixture-hn-${index + 1}`,
            submittedAt: new Date(window.windowEnd).toISOString(),
            score: 100 - index,
            comments: 20 - index,
            status: "summarized" as const,
          })),
          items: Array.from({ length: 5 }, (_, index) => ({
            section: "hackernews" as const,
            title: `Fixture AI 新闻 ${index + 1}`,
            summary: `这是第 ${index + 1} 条端到端测试用本地新闻，不会访问网络。`,
            brief: `这是第 ${index + 1} 条端到端测试用本地新闻，不会访问网络。`,
            source: "Fixture",
            url: `https://example.com/fixture-hn-${index + 1}`,
            publishedAt: window.date,
          })),
        };
        for (const item of digest.items) {
          await window.articles?.process(item.url, false, async () => ({
            title: item.title,
            markdown: "这是 fixture 模式下用于端到端验证的本地完整正文，包含背景、实现、证据、影响和限制，不会访问任何外部网页。",
          }), async () => item);
        }
        return digest;
      },
    }
  : (() => {
      const run = createCodexCliNewsRun({
        ...(diagnostics ? { diagnostics } : {}),
        executable: () => resolveCodexExecutable(process.env),
      });
      return new CombinedNewsResearcher(
        new CodexCliNewsResearcher(run),
        new CodexHackerNewsResearcher(run),
        Date.now, 360_000, run,
      );
    })();
const localNotifier = fixtureMode ? undefined : new MacLocalNotifier();
let dailyNewsActive = false;
const weixinNotifications = channelPort ? new WeixinNotificationChannel(channelPort,
  ({ accountId, target }) => startedChannels.has("weixin") &&
    (!weixinConfiguration || weixinConfiguration.owner.ownsAddress(accountId, target)) &&
    codexServiceStore.load().enabledTargets.some((item) => item.accountId === accountId && item.target === target),
  () => process.stderr.write("定时推送未被确认接受，请检查本地任务状态；不会自动改发其他渠道。\n")) : undefined;
const notificationChannel = channelConfiguration ? new NotificationChannelRouter([
  ...(weixinConfiguration && weixinNotifications ? [{ destination: { channel: "weixin" as const, ...weixinConfiguration.owner.conversationAddress() }, channel: weixinNotifications }] : []),
  ...(feishuConfiguration && feishuChannel ? feishuConfiguration.owner.conversationAddresses().map((address) => ({ destination: { channel: "feishu" as const, ...address }, channel: feishuChannel })) : []),
]) : weixinNotifications!;
const stateDirectory = path.dirname(privateStatePath);
const groupRuntimeRoot = path.join(stateDirectory, "group-model-runtimes");
const scheduledTasks = new ScheduledTasks({
  historyRetention: {
    ...(process.env.SCHEDULED_HISTORY_DETAIL_DAYS !== undefined ? { maxAgeMs: Number(process.env.SCHEDULED_HISTORY_DETAIL_DAYS) * 86_400_000 } : {}),
    ...(process.env.SCHEDULED_HISTORY_DETAIL_BYTES !== undefined ? { maxBytes: Number(process.env.SCHEDULED_HISTORY_DETAIL_BYTES) } : {}),
  },
  dailyNews: { researcher: newsResearcher, archive: newsArchive, ...(localNotifier ? { notifyLocal: (title: string, body: string) => localNotifier.notify(title, body) } : {}) },
  dailyNewsActive: () => dailyNewsActive,
  ...(diagnostics ? { diagnostics } : {}),
  research: createScheduledResearch({ executable: () => resolveCodexExecutable(process.env), ...(diagnostics ? { diagnostics } : {}),
    groupRuntime: (destination) => {
      if (!appServerCapabilities.namedPermissionsSupported || !feishuConfiguration?.owner.ownsAddress(destination.accountId, destination.target)) {
        throw new Error("research_runtime_unavailable");
      }
      return createIsolatedRuntime("research", { stateDirectory, instance: destination.target,
        ...(fixtureMode ? { authHome: path.join(groupRuntimeRoot, "fixture-no-auth") } : {}) });
    },
  }),
  databasePath: path.join(path.dirname(privateStatePath), "scheduled-tasks.sqlite"),
  readOriginalText: (ref) => workflowFileArtifacts.resolveQuery(ref) ?? undefined,
  ...(notificationRoute ? { notificationRoute } : {}),
  channel: notificationChannel,
  onError: () => process.stderr.write("定时任务状态暂不可用；已停止本轮推进，请检查本地存储。\n"),
});
const workflowToolGateway = new WorkflowToolGateway(
  workflowToolCatalog,
  [
    createWeixinSendFilesToolRegistration(localFileTools, workflowFileArtifacts, workflowFileSendManifests),
    createMediaSendToolRegistration(
      workflowMediaRequests,
      {
        localFiles: localFileTools,
        files: workflowFileArtifacts,
        manifests: workflowFileSendManifests,
      },
    ),
  ],
  workflowEngine,
  createWorkflowToolReplyProjector(
    workflowEngine,
    workflowPendingPresentations,
    Date.now,
    workflowFileArtifacts,
  ),
);
const workflowToolHost = new WorkflowToolHost(
  workflowToolCatalog,
  workflowToolGateway,
  { execute: (request, trusted) => request.toolId.startsWith("schedules.")
    ? scheduledTasks.execute(request, trusted) : localFileTools.execute(request, trusted) },
  {
    ...(diagnostics ? { diagnostics } : {}),
    trace: (event) => {
      process.stdout.write(`${JSON.stringify({ kind: "workflow_tool_trace", recordedAt: Date.now(), ...event })}\n`);
    },
  },
);
const workflowToolControl = new WorkflowToolProductionControl(
  workflowToolHost,
  workflowFileArtifacts,
  workflowMediaRequests,
  localFileTools,
);
const fixtureModelRequests: Array<{ threadId: string; input: unknown }> = [];
// Coordinator and Team Leader turns run over the fixture App Server only under the coordination seam; they are kept apart from Executor turns.
const fixtureCoordinationRequests: Array<{ threadId: string; input: unknown }> = [];
const fixtureThreadStarts: Array<{ threadId: string; serviceName: unknown; dynamicTools: string[] | null }> = [];
const observeThreadStart = (start: (typeof fixtureThreadStarts)[number]) => { fixtureThreadStarts.push(start); if (fixtureThreadStarts.length > 40) fixtureThreadStarts.shift(); };
const fixtureThreadQueues = new Map<string, FixtureModelToolCallQueue>();
const codexAgent: CodexAgent = new CodexConversation(
  () => fixtureMode && !fixtureLiveMainModel
    ? new FixtureAppServerTransport({ takeFixtureModelToolCall: (threadId) => (channelConfiguration ? fixtureThreadQueues.get(threadId!) : fixturePort)?.takeFixtureModelToolCall() }, undefined, (request) => {
      fixtureModelRequests.push(request);
      if (fixtureModelRequests.length > 20) fixtureModelRequests.shift();
    })
    : spawnStdioAppServer(codexExecutable, MAIN_WEIXIN_DISABLED_FEATURES),
  600_000,
  workflowToolHost,
  writeGuard,
  300_000,
  {
    structuredOutputSupported: appServerCapabilities.structuredOutputSupported,
    automaticRecovery: true,
    onRecovery: (event) => diagnostics?.checkpoint("app_server.recovery", event),
    onConnectionFailure: (error) => diagnostics?.checkpoint("app_server.connection", { status: "closed", errorCode: error.message }),
  },
);
const isolatedConversation = (kind: IsolatedConversationKind, placement: { instance?: string; mediaRoot?: string; agentId?: string } = {},
  tools: DynamicToolHost | undefined = ISOLATED_RUNTIME_KINDS[kind].hostTools ? workflowToolHost : undefined) => {
  if (!appServerCapabilities.namedPermissionsSupported) throw new Error("group_runtime_permissions_unavailable");
  const { hostTools } = ISOLATED_RUNTIME_KINDS[kind];
  // Kinds with host tools always use the fixture App Server in fixture mode; Coordinator and Team Leader kinds only under the seam.
  const fixtureRuntime = fixtureMode && !fixtureLiveMainModel &&
    (hostTools || (fixtureCoordinationRuntime && (kind === "dispatchCoordinator" || kind === "dispatchLeader")));
  const requests = hostTools ? fixtureModelRequests : fixtureCoordinationRequests;
  const runtime = createIsolatedRuntime(kind, { stateDirectory,
    ...(placement.instance !== undefined ? { instance: placement.instance } : {}),
    ...(placement.mediaRoot !== undefined ? { mediaRoot: placement.mediaRoot } : {}),
    ...(fixtureMode && !fixtureLiveMainModel && !fixtureLiveWorkflowAgents ? { authHome: path.join(groupRuntimeRoot, "fixture-no-auth") } : {}) });
  // Every process the conversation starts, so a closed runtime can wait for them to exit before its home is compacted.
  const exits: Array<Promise<void>> = [];
  const agent = new CodexConversation(
    () => {
      if (fixtureRuntime) {
        return new FixtureAppServerTransport({ takeFixtureModelToolCall: (threadId) => fixtureThreadQueues.get(threadId!)?.takeFixtureModelToolCall(),
          takeFixtureModelCompletion: (threadId) => fixtureThreadQueues.get(threadId!)?.takeFixtureModelCompletion?.() }, undefined, (request) => {
          requests.push(request); if (requests.length > 20) requests.shift();
        }, undefined, observeThreadStart, kind === "dispatchAgent" ? runtime.env.CODEX_HOME : undefined);
      }
      const transport = spawnIsolatedAppServer(codexExecutable, runtime);
      exits.push(transport.exited);
      return transport;
    },
    600_000, tools, undefined, 300_000,
    isolatedConversationOptions(kind, runtime, { structuredOutputSupported: appServerCapabilities.structuredOutputSupported,
      ...(placement.agentId !== undefined ? { agentId: placement.agentId } : {}) }));
  return { agent, cwd: runtime.cwd, runtimeWorkspaceRoots: [], exited: async () => { await Promise.all(exits); } };
};
const createGroupRuntime = (accountId: string, target: string) => {
  const chatId = feishuConfiguration?.owner.deliveryTarget(accountId, target);
  if (!chatId || !target.startsWith("feishu.group.")) throw new Error("group_runtime_identity_unbound");
  const mediaRoot = feishuInboundMedia!.readableRoot(chatId);
  fs.mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
  return isolatedConversation("feishuGroup", { instance: target, mediaRoot });
};
let groupPendingResponseAgent: CodexConversation | undefined;
let groupPendingResponseRouter: PendingResponseRouter | undefined;
if (feishuConfiguration?.owner.hasGroups) {
  if (fixtureMode && !fixtureLiveWorkflowAgents) groupPendingResponseRouter = new FixturePendingResponseRouter();
  else {
    try {
      const runtime = isolatedConversation("pendingRouter");
      groupPendingResponseAgent = runtime.agent;
      groupPendingResponseRouter = new CodexPendingResponseRouter(runtime.agent, runtime.cwd);
    } catch { process.stderr.write("group_pending_runtime_unavailable\n"); }
  }
}
const accountMemoryRoot = path.join(path.dirname(privateStatePath), "memory");
const accountMemoryStore = new AccountMemoryStore(accountMemoryRoot);
const accountMemorySearch = fixtureMode
  ? undefined
  : new AccountMemorySearchIndex(accountMemoryRoot, new LocalTransformersMemoryEmbedder(), {
      candidate: new Qwen3MemoryEmbeddingProfile(),
    });
const accountMemoryTools = new AccountMemoryToolHost(accountMemoryStore, accountMemorySearch, scheduledTasks, notificationRoute);
const accountMemoryCuratorCwd = path.join(path.dirname(privateStatePath), "memory-curator-runtime");
fs.mkdirSync(accountMemoryCuratorCwd, { recursive: true, mode: 0o700 });
const personalMemoryCurator: AccountMemoryCurator = fixtureMode
  ? { curate: async () => ({ status: "noop" }), close: () => {} }
  : new CodexAccountMemoryCurator(
      new CodexConversation(
        () => spawnStdioAppServer(codexExecutable, MEMORY_CURATOR_DISABLED_FEATURES),
        600_000,
        undefined,
        undefined,
        300_000,
        {
          serviceName: "weixin_memory_curator",
          webSearch: "disabled",
          runtimeProfile: MEMORY_CURATOR_RUNTIME_PROFILE,
        },
      ),
      accountMemoryTools,
      accountMemoryCuratorCwd,
    );
let groupMemoryCurator: AccountMemoryCurator | undefined;
// Team Leader and Executor memories share the isolated group curator's runtime, which only the group curator closes. Their tool
// host has no notification route and no reminder ownership, so a planned event there gets neither a delivery destination nor a
// reminder intent; group reminders stay with the group memory (agent-dispatch::REQ-012).
let dispatchMemoryCurator: AccountMemoryCurator | undefined;
// Fixture mode only: what each fixture curator was asked to curate, so whole-app cases can see which memory a turn reached.
const fixtureMemoryCurations: Array<{ curator: "group" | "dispatch"; accountId: string; turns: Array<{ user: string; assistant?: string }> }> = [];
const fixtureCurator = (curator: "group" | "dispatch"): AccountMemoryCurator => ({ close: () => {}, curate: async (input) => {
  fixtureMemoryCurations.push({ curator, accountId: input.accountId, turns: input.turns.map(({ userEntry, assistantEntry }) => ({ user: userEntry.text,
    ...(assistantEntry ? { assistant: assistantEntry.text } : {}) })) });
  if (fixtureMemoryCurations.length > 40) fixtureMemoryCurations.shift();
  return { status: "noop" };
} });
if (feishuConfiguration?.owner.hasGroups) {
  if (fixtureMode) {
    groupMemoryCurator = fixtureCurator("group");
    if (feishuConfiguration.dispatch) dispatchMemoryCurator = fixtureCurator("dispatch");
  } else {
    try {
      const runtime = isolatedConversation("groupMemoryCurator");
      groupMemoryCurator = new CodexAccountMemoryCurator(runtime.agent, accountMemoryTools, runtime.cwd);
      if (feishuConfiguration.dispatch) {
        const curator = new CodexAccountMemoryCurator(runtime.agent, new AccountMemoryToolHost(accountMemoryStore, accountMemorySearch), runtime.cwd);
        dispatchMemoryCurator = { curate: (input) => curator.curate(input), cancelAccount: (accountId) => curator.cancelAccount(accountId), close: () => {} };
      }
    } catch { process.stderr.write("group_memory_runtime_unavailable\n"); }
  }
}
const accountMemoryCurator: AccountMemoryCurator = {
  curate: (input) => {
    if (input.accountId.startsWith(DISPATCH_MEMORY_ACCOUNT_PREFIX)) {
      if (!dispatchMemoryCurator) throw new Error("group_memory_unbound");
      return dispatchMemoryCurator.curate(input);
    }
    if (!input.accountId.startsWith("feishu.group.")) return personalMemoryCurator.curate(input);
    if (!groupMemoryCurator || !notificationRoute?.ownsMemoryScope(input.accountId)) throw new Error("group_memory_unbound");
    return groupMemoryCurator.curate(input);
  },
  cancelAccount: (accountId) => accountId.startsWith(DISPATCH_MEMORY_ACCOUNT_PREFIX) ? dispatchMemoryCurator?.cancelAccount?.(accountId)
    : accountId.startsWith("feishu.group.") ? groupMemoryCurator?.cancelAccount?.(accountId) : personalMemoryCurator.cancelAccount?.(accountId),
  close: () => settleCleanup([() => personalMemoryCurator.close(), () => groupMemoryCurator?.close(), () => dispatchMemoryCurator?.close()]),
};
const planMonitor = new PlanFollowUpMonitor({
    store: accountMemoryStore,
    ...(notificationRoute ? { notificationRoute } : {}),
    sender: (input) => notificationChannel.send({ ...input, beforeSubmit: () => true }),
    onError: () => process.stderr.write("计划提醒扫描失败，请检查本地服务状态。\n"),
});
let startPlanMonitor: (() => void) | undefined;
const accountMemory = new AccountMemorySystem({
  managedTasks: (accountId, targets) => scheduledTasks.memoryContext(accountId, targets),
  store: accountMemoryStore,
  curator: accountMemoryCurator,
  statePath: path.join(path.dirname(privateStatePath), "memory-jobs.json"),
  reminderMonitor: {
    runNow: (accounts) => channelReady ? planMonitor.runNow(accounts) : Promise.resolve(),
    start: (accounts) => { startPlanMonitor = () => planMonitor.start(accounts); if (channelReady) startPlanMonitor(); },
    close: () => { startPlanMonitor = undefined; return planMonitor.close(); },
  },
  ...(accountMemorySearch ? { search: accountMemorySearch } : {}),
});
const weixinConversation = channelPort ? new WeixinConversationChannel(channelPort) : undefined;
const conversationRouter = channelConfiguration ? new ConversationChannelRouter([
  ...(weixinConfiguration && weixinConversation ? [{ owner: weixinConfiguration.owner, channel: weixinConversation,
    turns: { prepare: (threadId, message, options) => {
      if (fixturePort) fixtureThreadQueues.set(threadId, fixturePort);
      return new WeixinTurnAdapter(threadId, weixinConversation.legacy(message), { ...options, workflowTools: workflowToolControl });
    } } } satisfies ConstructorParameters<typeof ConversationChannelRouter>[0][number]] : []),
  ...(feishuConfiguration && feishuChannel ? [{ owner: feishuConfiguration.owner, channel: feishuChannel,
    turns: { prepare: (threadId, message, options) => {
      if (fixtureFeishu) fixtureThreadQueues.set(threadId, fixtureFeishu);
      return new ChannelTurnAdapter(threadId, message, { ...options, channelLabel: "飞书", outboundDelivery: true, workflowTools: workflowToolControl });
    } } } satisfies ConstructorParameters<typeof ConversationChannelRouter>[0][number]] : []),
]) : undefined;
const privateWorkflowAdapter = new ConversationWorkflowTriggerAdapter({ engine: workflowEngine, pendingPresentations: workflowPendingPresentations,
  ...(pendingResponseRouter ? { pendingResponseRouter } : {}) });
const groupWorkflowAdapter = new ConversationWorkflowTriggerAdapter({ engine: workflowEngine, pendingPresentations: workflowPendingPresentations,
  ...(groupPendingResponseRouter ? { pendingResponseRouter: groupPendingResponseRouter } : {}) });
const codexService = conversationRouter ? new ConversationService(
  conversationRouter, codexAgent, codexServiceStore, process.cwd(), Date.now, writeGuard, runtimeWorkspaceRoots,
  appServerCapabilities.restrictedReadSupported, mediaReadRoot, conversationRouter,
  fixtureMode ? undefined : new MacCodexDesktopNavigator(), accountMemory,
  { tryHandle: (event) => (event.conversationType === "group" ? groupWorkflowAdapter : privateWorkflowAdapter).tryHandle(event),
    tryHandlePending: (event) => (event.conversationType === "group" ? groupWorkflowAdapter : privateWorkflowAdapter).tryHandlePending(event) },
  undefined, workflowToolControl, diagnostics, new PersonalOwnerDirectory(channelConfiguration!.entries.map((entry) => entry.owner)), createGroupRuntime,
) : new WeixinCodexService(
  channelPort!,
  codexAgent,
  codexServiceStore,
  process.cwd(),
  Date.now,
  writeGuard,
  runtimeWorkspaceRoots,
  appServerCapabilities.restrictedReadSupported,
  mediaReadRoot,
  undefined,
  fixtureMode ? undefined : new MacCodexDesktopNavigator(),
  accountMemory,
  inboundWorkflows,
  undefined,
  workflowToolControl,
  diagnostics,
  weixinConfiguration?.owner,
);
let fixtureLeaderRequests: FixtureTeamLeader["requests"] | undefined;
const agentDispatch = feishuConfiguration?.dispatch && feishuChannel ? (() => {
  const configuration = feishuConfiguration, channel = feishuChannel;
  const teams = teamManagement!;
  // The Coordinator and the Team Leaders with a sending application under the current definitions, read on every use.
  const agents = () => teams.roster().agents.map(({ id, name, responsibility, appId }) => ({ id, name, responsibility, senderAccountId: appId }));
  const authorized = (event: import("./channel-contract.js").InboundContent) => channel.usesAgentDispatch(event.target) &&
    configuration.owner.accepts(event) && codexService.getPublicState().enabledTargets.some(({ accountId, target }) => accountId === event.accountId && target === event.target);
  const model = () => {
    const selected = codexService.getPublicState().models?.accounts.find(({ accountId }) => accountId === configuration.owner.conversationAddress().accountId)?.resolved;
    if (!selected?.available) throw new Error("dispatch_model_unavailable");
    return { model: selected.model, effort: selected.effort };
  };
  const catalogToolIds = workflowToolCatalog.memberIds();
  // A request keeps the definitions version it was first planned under; versions are immutable, so each is read once.
  const versions = new Map<number, TeamDefinitions>();
  const definitionsFor = (version: number | undefined): TeamDefinitions => {
    if (version === undefined) return teams.current().definitions;
    let found = versions.get(version);
    if (!found) {
      found = teams.version(version)?.definitions;
      if (!found) throw new Error("dispatch_definitions_unavailable");
      versions.set(version, found);
    }
    return found;
  };
  // Each agent recalls and captures only its own scope's account: the group's for the Coordinator, derived ones for Team Leaders
  // and Executors (agent-dispatch::REQ-012). Every account is registered before use, so recall never depends on other paths.
  const memoryAccount = (scope: AgentMemoryScope, event: import("./channel-contract.js").InboundContent) => {
    const account = memoryAccountId(configuration.owner.memoryScope(event.accountId, event.target), scope);
    accountMemory.registerAccount(account);
    return account;
  };
  const coordinatorProfile = resolveAgentProfile(teams.current().definitions, { role: "coordinator" }, catalogToolIds);
  // Sam's instructions can change from the console; each Coordinator turn takes the current ones (team-management::REQ-001/AC-01).
  const coordinatorInstructions = () => resolveAgentProfile(teams.current().definitions, { role: "coordinator" }, catalogToolIds).instructions;
  const memory = {
    recall: (scope: AgentMemoryScope, event: import("./channel-contract.js").InboundContent, query: string) => accountMemory.recall(memoryAccount(scope, event), query),
    capture: async (scope: AgentMemoryScope, turn: import("./agent-dispatch.js").DispatchMemoryTurn) => {
      await accountMemory.captureTurn({ accountId: memoryAccount(scope, turn.event), target: turn.event.target,
        userEntry: { source: { eventKey: turn.event.key, target: turn.event.target, senderAccountId: turn.senderAccountId }, id: turn.userId, text: turn.userText,
          createdAt: turn.event.receivedAt, status: "completed" },
        assistantEntry: { id: turn.assistantId, text: turn.assistantText, createdAt: Date.now(), status: "completed" } });
    },
  };
  // Building a profile's tool view compiles its tool schemas (about 50 ms), so one view is kept per tool set and profile.
  // Each call is also checked against the profile's current allowlist, so a removed tool is refused at once in running
  // requests, and the refusal is audited (agent-dispatch::REQ-017/AC-02).
  const toolViews = new Map<string, ProfileToolHost>();
  const executorProfile = (job: import("./agent-dispatch-types.js").DispatchJob, assignment: import("./agent-dispatch-types.js").DispatchAssignment) => {
    const agent = { role: "executor", teamId: assignment.teamId, profileId: assignment.profileId } as const;
    const resolved = resolveAgentProfile(definitionsFor(job.definitionsVersion), agent, catalogToolIds);
    const key = JSON.stringify([resolved.hostTools, assignment.teamId, assignment.profileId]);
    let tools = toolViews.get(key);
    if (!tools) {
      tools = new ProfileToolHost(workflowToolHost, workflowToolCatalog, resolved.hostTools, {
        current: () => { try { return resolveAgentProfile(teams.current().definitions, agent, catalogToolIds).hostTools; } catch { return undefined; } },
        refused: (tool) => consoleAudit.tryAppend({ by: "service", event: "host_tool_refused", team: assignment.teamId, profile: assignment.profileId, tool }),
      });
      toolViews.set(key, tools);
    }
    return { instructions: resolved.instructions, memoryScope: resolved.memoryScope, tools };
  };
  // One pool bounds the coordinator's and the specialists' runtimes together (agent-dispatch::QR-001).
  const runtimes = new RuntimePool<DispatchRuntime>({ limit: DISPATCH_RUNTIME_LIMIT, idleMs: DISPATCH_RUNTIME_IDLE_MS, close: closeDispatchRuntime });
  const contextRevision = () => { const state = codexServiceStore.load(); return JSON.stringify([state.accessContextEpoch ?? 0, state.permissions.revision]); };
  // Under the coordination seam the fixture App Server answers Coordinator and Team Leader turns with the injected outputs.
  const answer = (threadId: string, text: string) => fixtureThreadQueues.set(threadId, { takeFixtureModelToolCall: () => undefined, takeFixtureModelCompletion: () => Promise.resolve(text) });
  const classifier = fixtureMode && !fixtureLiveMainModel && !fixtureCoordinationRuntime
    ? { classify: async (input: import("./agent-dispatch-types.js").DispatchClassificationInput) => parseDispatchDecision(fixtureFeishu!.dispatchDecision(input.event.messageId), input) }
    : (() => {
      if (!appServerCapabilities.namedPermissionsSupported) throw new Error("group_runtime_permissions_unavailable");
      // The runtime's tools come from the resolved profile, which never gives the Coordinator business tools (agent-dispatch::CON-003).
      const coordinatorTools = coordinatorProfile.hostTools.length ? new ProfileToolHost(workflowToolHost, workflowToolCatalog, coordinatorProfile.hostTools) : undefined;
      const create = () => isolatedConversation("dispatchCoordinator", {}, coordinatorTools);
      return new CodexDispatchClassifier((work) => runtimes.use("dispatch-coordinator", create, ({ agent, cwd }) => work(agent, cwd)), model, coordinatorInstructions,
        fixtureCoordinationRuntime ? (input, threadId) => answer(threadId, JSON.stringify(fixtureFeishu!.dispatchDecision(input.event.messageId))) : undefined);
    })();
  // Team Leader turns are tool-free; each turn holds its pool slot only for itself (agent-dispatch::QR-001/AC-02).
  const fixtureLeader = fixtureMode && !fixtureLiveMainModel && !fixtureCoordinationRuntime ? new FixtureTeamLeader(fixtureFeishu!) : undefined;
  const leader: TeamLeader = fixtureLeader ?? (() => {
    if (!appServerCapabilities.namedPermissionsSupported) throw new Error("group_runtime_permissions_unavailable");
    const create = (scope: string) => isolatedConversation("dispatchLeader", { instance: scope });
    return new CodexTeamLeader(path.join(path.dirname(privateStatePath), "agent-sessions.sqlite"), {
      runtime: (scope, work) => runtimes.use(scope, () => create(scope), ({ agent, cwd }) => work(agent, cwd)), model,
      ...(fixtureCoordinationRuntime ? { prepareThread: (input, phase, threadId, assignments) => answer(threadId, JSON.stringify(phase === "plan"
        ? fixtureFeishu!.leaderPlan(input.fixtureMessageId) ?? fixtureDefaultPlan(input)
        : phase === "supplement" ? fixtureFeishu!.leaderSupplement(input.fixtureMessageId) ?? fixtureDefaultSupplement(assignments as readonly LeaderAssignmentView[])
          : fixtureFeishu!.leaderClosing(input.fixtureMessageId) ?? fixtureDefaultClosing(assignments as readonly LeaderAssignmentReport[]))) } : {}),
    });
  })();
  const teamView = (teamId: string, version: number) => {
    const versionDefinitions = definitionsFor(version), team = versionDefinitions.teams.find(({ id }) => id === teamId);
    if (!team) return undefined;
    const { instructions, memoryScope } = resolveAgentProfile(versionDefinitions, { role: "leader", teamId }, catalogToolIds);
    return { leader: { id: team.id, name: team.leader.name, teamName: team.teamName, responsibility: team.responsibility, instructions },
      profiles: team.executorProfiles.map(({ id, name, noun }) => ({ id, name, ...(noun ? { noun } : {}) })), memoryScope };
  };
  const executor = new CodexDispatchExecutor(path.join(path.dirname(privateStatePath), "agent-sessions.sqlite"), {
    agents, runtimes, tools: workflowToolControl, authorized: (job) => authorized(job.event), model,
    contextRevision,
    profile: executorProfile,
    memory: (job, scope, query) => memory.recall(scope, job.event, query),
    existingResult: (job, assignment) => {
      const event = executorEvent(job, assignment);
      const run = workflowEngine.getTriggeredRun("weixin", event.key, event.accountId, event.target, event.senderId);
      if (!run) return undefined;
      const destination = workflowRunTargets.resolveRunTarget(run.runId);
      if (destination?.senderAccountId !== job.senderAccountId) throw new Error("dispatch_authorization_changed");
      const rendered = renderWorkflowRun(run, workflowEngine.listPendingSignals(event.accountId, event.target, event.senderId));
      if (!rendered.handled) throw new Error("dispatch_workflow_result_unavailable");
      return { status: rendered.outcome === "succeeded" ? "completed" : rendered.outcome === "needs_input" ? "waiting" : "failed",
        message: rendered.reply, runRef: run.runId };
    },
    createRuntime: (job, scope, tools) => {
      const chatId = configuration.owner.deliveryTarget(job.event.accountId, job.event.target);
      if (!chatId) throw new Error("dispatch_group_unbound");
      const mediaRoot = feishuInboundMedia!.readableRoot(chatId);
      fs.mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
      return isolatedConversation("dispatchAgent", { instance: scope, mediaRoot, agentId: job.agentId }, tools);
    },
    prepareThread: (job, assignment, threadId) => { if (fixtureFeishu) fixtureThreadQueues.set(threadId, fixtureFeishu.dispatchToolQueue(job.fixtureMessageId ?? executorEvent(job, assignment).messageId, assignment.title)); },
    capture: (job, assignment, scope, { brief, reply }) => memory.capture(scope, { event: job.executionEvent ?? job.event, senderAccountId: job.senderAccountId,
      userId: `${assignment.id}:user:${assignment.attempt}`, userText: brief, assistantId: `${assignment.id}:assistant:${assignment.attempt}`, assistantText: reply }),
    homes: { root: path.join(stateDirectory, ISOLATED_RUNTIME_KINDS.dispatchAgent.directory),
      compact: (home, recordedThread) => compactRuntimeHome(home, recordedThread, fixtureCompactionHold ? { afterRemoval: () => {
        fs.writeFileSync(path.join(stateDirectory, "fixture-compaction-held"), "");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      } } : {}) },
    report: (code) => process.stderr.write(`${code}\n`),
  });
  // Before any dispatch work can start an Executor runtime (agent-dispatch::QR-002/AC-02).
  executor.compactHomes();
  const dispatch = new AgentDispatch(path.join(path.dirname(privateStatePath), "agent-dispatch.sqlite"), { agents, classifier, executor, authorized, leader,
    definitionsVersion: () => teams.current().version, team: teamView, revision: contextRevision,
    // The current definitions decide which teams take work in a group, whatever version a request was planned under.
    roster: (event) => {
      const chatId = configuration.owner.deliveryTarget(event.accountId, event.target);
      return chatId ? acceptingTeams(teams.current().definitions, chatId) : [];
    },
    bindingHash: (event) => configuration.owner.contextHash(event.accountId, event.target), memory, memoryScope: coordinatorProfile.memoryScope,
    completedWork: (job, assignments) => {
      const files = localFileTools.dispatchEvidence(job.id);
      const schedules = scheduledTasks.dispatchEvidence(job.id);
      // Workflow effects are keyed by each Assignment's Executor event; a request stored before Assignments keys them by its message.
      const events = assignments.length ? assignments.map((assignment) => executorEvent(job, assignment)) : [job.executionEvent ?? job.event];
      const effects = [...new Map(events.map((event) => [event.key, event])).values()]
        .flatMap((event) => workflowEngine.getTriggeredRun("weixin", event.key, event.accountId, event.target, event.senderId)?.effects ?? []);
      const accepted = effects.filter((effect) => effect.state === "accepted").length;
      const unknown = effects.filter((effect) => effect.state === "unknown" || effect.state === "prepared").length;
      return `${files.completed ? `已确认完成 ${files.completed} 次本地文件修改。` : ""}${files.unknown ? `另有 ${files.unknown} 次文件操作结果尚未确认，不会自动重复。` : ""}` +
        `${accepted ? `已确认提交 ${accepted} 个文件或媒体附件。` : ""}${unknown ? `有 ${unknown} 个附件的发送结果无法确认，不会重复提交。` : ""}` +
        `${schedules ? `已确认完成 ${schedules} 次定时任务操作。` : ""}`;
    },
    presentation: (event, runRef) => {
      const request = workflowEngine.listPendingSignals(event.accountId, event.target, event.senderId).find((item) => item.runId === runRef && item.expiresAt > Date.now());
      return request ? { accountRef: event.accountId, targetRef: event.target, ...(event.senderId ? { requesterRef: event.senderId } : {}), runId: runRef,
        signalRef: request.signalRef, revision: request.revision, expiresAt: request.expiresAt, requestTextHash: pendingRequestTextHash(event.text) } : undefined;
    },
    presented: (presentation) => {
      const current = workflowEngine.listPendingSignals(presentation.accountRef, presentation.targetRef, presentation.requesterRef)
        .some((item) => item.signalRef === presentation.signalRef && item.revision === presentation.revision && item.expiresAt > Date.now());
      if (current) workflowPendingPresentations.put(presentation);
    },
    pending: async (event) => {
      const requests = workflowEngine.listPendingSignals(event.accountId, event.target, event.senderId).filter((request) => request.expiresAt > Date.now());
      if (requests.length === 0) return { handled: false };
      if (requests.length > 1) return { handled: true, result: { status: "waiting", message: "有多个工作流等待选择，请带上提示中的引用。" } };
      const request = requests[0]!, destination = workflowRunTargets.resolveRunTarget(request.runId);
      if (!destination || !channel.state({ ...destination, channel: "feishu" }).enabled) return { handled: true,
        result: { status: "failed", message: "原接单机器人当前不可用，尚未继续操作。请恢复后再试。" } };
      const result = await groupWorkflowAdapter.tryHandlePending(event);
      const cancelled = workflowEngine.get(request.runId)?.status === "cancelled";
      if (!result.handled) return { handled: false, ...(cancelled ? { cancelledRunRef: request.runId } : {}) };
      return { handled: true, ...destination, runRef: request.runId,
        result: { status: cancelled ? "cancelled" : result.outcome === "succeeded" ? "completed" : result.outcome === "needs_input" ? "waiting" : "failed", message: result.reply } };
    },
    delivery: (input) => channel.send({ ...input, channel: "feishu" }), report: (code) => process.stderr.write(`${code}\n`) });
  channel.bindAgentDispatcher((event) => dispatch.admit(event), new Map([...dispatchApplications].map(([id, application]) => [id, { transport: application.transport, ready: () => application.ready }])),
    () => teams.roster().agents);
  countActiveAssignments = () => {
    const counts: Record<string, number> = {};
    for (const { teamId, status } of dispatch.getState().jobs.flatMap(({ assignments }) => assignments)) {
      if (["queued", "running", "waiting"].includes(status)) counts[teamId] = (counts[teamId] ?? 0) + 1;
    }
    return counts;
  };
  // A roster change from a console save or onboarding: a new or re-secreted application gets its own outbound transport, media
  // routes and channel sender at once, started when the Feishu channel already runs (ticket 11, decision D5).
  const mediaRouter = selectedMediaDelivery instanceof MediaDeliveryRouter ? selectedMediaDelivery : undefined;
  applyRoster = (roster) => {
    for (const agent of roster.agents) {
      if (agent.id === COORDINATOR_ID) continue;
      const known = dispatchApplications.get(agent.appId);
      if (known && known.appSecret === agent.appSecret) continue;
      if (known) void Promise.resolve(known.transport.close()).catch(() => {});
      const application = createDispatchApplication(agent);
      dispatchApplications.set(agent.appId, application);
      channel.setAgentSender(agent.appId, { transport: application.transport, ready: () => application.ready });
      if (!mediaRoutedApplications.has(agent.appId)) {
        mediaRoutedApplications.add(agent.appId);
        for (const address of dispatchConversations()) mediaRouter?.add(feishuMediaRoute({ ...address, senderAccountId: agent.appId }));
      }
      if (startedChannels.has("feishu")) void startDispatchApplication(application);
    }
    // An application no team uses any more is closed: work queued under it fails delivery with no other identity (agent-dispatch::REQ-008/AC-04).
    for (const [appId, application] of dispatchApplications) {
      if (roster.agents.some((agent) => agent.appId === appId)) continue;
      application.ready = false;
      dispatchApplications.delete(appId);
      void Promise.resolve(application.transport.close()).catch(() => {});
    }
    bindFixtureApplications();
  };
  fixtureLeaderRequests = fixtureLeader?.requests;
  return dispatch;
})() : undefined;
const workflowModulePermissionSettings = new WorkflowModulePermissionSettings(
  workflowModulePermissions,
  [{
    moduleId: "notes",
    name: "Obsidian 笔记",
    description: "搜索、读取、新建和修改已授权目录中的 Markdown 文件",
    scopes: [{
      scopeId: "vault",
      label: path.basename(vaultRoot) || "Vault",
      directory: vaultRoot,
    }],
  }],
  () => codexService.narrowFileAccessContext(),
);
const dailyNews = new ManagedDailyAiNews(scheduledTasks);
const contextTokenExperiment = channelPort ? new ContextTokenExpiryExperiment({
  channel: channelPort,
  store: new FileContextTokenExperimentStore(
    path.join(path.dirname(privateStatePath), "context-token-expiry-experiment.json"),
  ),
  wakeLock: fixtureMode ? { start: () => true, stop: () => {} } : new CaffeinateWakeLock(),
  ...(localNotifier
    ? { onTerminal: (state: import("./context-token-expiry-experiment.js").PublicContextTokenExperimentState) => {
        const elapsed = state.expiredAfterMs === null
          ? ""
          : `，约 ${(state.expiredAfterMs / 3_600_000).toFixed(1)} 小时`;
        localNotifier.notify(
          "Context token 时效实验已结束",
          state.status === "expired"
            ? `微信发送上下文首次被拒绝${elapsed}。`
            : `实验状态：${state.status}${elapsed}。`,
        );
      } }
    : {}),
}) : undefined;

const service = channelPort ? new DemoService(channelPort, (url) =>
  QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 360 }),
  codexService,
  dailyNews,
  new AutoBindingFileStore(path.join(path.dirname(privateStatePath), "auto-binding.json")),
  contextTokenExperiment,
  workflowMediaPermissions,
  workflowEngine,
  workflowModulePermissionSettings,
) : undefined;
let penny: FinanceService | undefined;
let pennyFixture: FixtureFeishuTransport | undefined;
let pennyError: string | undefined;
const pennyConfigured = Boolean(process.env.PENNY_CONFIG_PATH);
if (pennyConfigured) {
  let interpreter: FinanceInterpreter | undefined;
  let transport: FeishuWebhookTransport | undefined;
  try {
    const configuration = loadFinanceConfiguration(process.env.PENNY_CONFIG_PATH!, {
      apps: [...(feishuConfiguration ? [feishuConfiguration.connection.appId] : []), ...dispatchApplications.keys()],
      ports: [port, ...(feishuConfiguration?.webhook ? [feishuConfiguration.webhook.port] : [])],
    });
    pennyApplicationId = configuration.appId;
    const root = path.join(path.dirname(privateStatePath), "penny");
    const mediaRoot = path.join(root, "media"); fs.mkdirSync(mediaRoot, { recursive: true, mode: 0o700 });
    if (fixtureMode && !fixtureLiveMainModel) {
      const commands = JSON.parse(process.env.WORKFLOW_FIXTURE_FINANCE_COMMANDS ?? "{}");
      interpreter = { interpret: async (input) => parseFinanceCommand({ command: commands[input.text] }, input), close: async () => {} };
    } else {
      if (!appServerCapabilities.namedPermissionsSupported || !appServerCapabilities.structuredOutputSupported) throw new Error("penny_runtime_unavailable");
      const { agent: conversation, cwd } = isolatedConversation("penny", { mediaRoot });
      interpreter = new CodexFinanceInterpreter(conversation, cwd, () => {
        const accountId = channelConfiguration?.entries[0]?.owner.conversationAddress().accountId;
        const selected = codexService.getPublicState().models?.accounts.find((account) => account.accountId === accountId)?.resolved;
        if (!selected?.available) throw new Error("penny_model_unavailable");
        return { model: selected.model, effort: selected.effort };
      });
    }
    pennyFixture = fixtureMode ? new FixtureFeishuTransport(false, "ou_fixturepenny") : undefined;
    const outbound = pennyFixture ?? new FeishuSdkTransport({ appId: configuration.appId, appSecret: configuration.appSecret, mode: "outbound" });
    transport = new FeishuWebhookTransport(outbound, new FeishuWebhookReceiver({ ...configuration.webhook, appId: configuration.appId,
      tenantKey: configuration.tenantKey, databasePath: path.join(root, "callbacks.sqlite") }, () => { pennyError = "penny_callback_unavailable"; }));
    penny = new FinanceService({ root, config: configuration, transport, interpreter });
    if (pennyFixture) { fixtureExtraApplications.push(["penny", pennyFixture]); bindFixtureApplications(); }
  } catch {
    pennyError = "penny_configuration_unavailable";
    await settleCleanup([() => transport?.close(), () => interpreter?.close()]).catch(() => {});
  }
}
const dispatchState = () => agentDispatch ? { agentDispatch: agentDispatch.getState(), ...(fixtureMode ? {
  fixtureLeaderRequests: structuredClone(fixtureLeaderRequests ?? []), fixtureCoordinationRequests: structuredClone(fixtureCoordinationRequests),
  fixtureThreadStarts: structuredClone(fixtureThreadStarts), fixtureMemoryCurations: structuredClone(fixtureMemoryCurations),
  ...(fixtureOnboarding ? { fixtureOnboardingCalls: structuredClone(fixtureOnboarding.calls) } : {}),
  agentFixtureOutboxes: Object.fromEntries([...dispatchApplications.values()].map(({ agentId, transport }) =>
    [agentId, transport instanceof FixtureFeishuTransport ? { text: transport.getTextOutbox(), media: transport.getMediaOutbox() } : undefined])),
} : {}) } : {};
const channelState = () => ({ ...dispatchState(), penny: { configured: pennyConfigured, ...(penny?.state() ?? { ready: false }), ...(pennyError ? { error: pennyError } : {}) },
  ...(fixtureMode && pennyFixture ? { pennyFixtureTextOutbox: pennyFixture.getTextOutbox() } : {}),
  ...(fixtureMode ? { fixtureModelRequests: structuredClone(fixtureModelRequests) } : {}), ...(fixturePort ? { weixinFixtureReplies: fixturePort.getFixtureReplies() } : {}), channels: {
  weixin: { enabled: Boolean(channelPort), ready: startedChannels.has("weixin") && channelPort!.getSnapshot().accounts.some((account) => account.credentialStatus === "usable") },
  feishu: { enabled: Boolean(feishuChannel), ready: Boolean(feishuChannel && startedChannels.has("feishu") && feishuChannel.state({ channel: "feishu", ...feishuConfiguration!.owner.conversationAddress() }).enabled) },
}, ...(fixtureFeishu ? { feishuFixtureTextOutbox: fixtureFeishu.getTextOutbox(), feishuFixtureMediaOutbox: fixtureFeishu.getMediaOutbox() } : {}) });
// Every page and API of the local service requires an owner-authorized browser (agent-console::CON-001).
const consoleAccess = new ConsoleAccess({ directory: consoleStateDirectory, audit: consoleAudit });
// The MCP Catalog: the service holds every registered server's connection and credentials (mcp-catalog::REQ-003/AC-01).
const mcpCatalog = new McpCatalog({ stateDirectory: consoleStateDirectory, audit: consoleAudit });
// The dispatch-group form writes the channel configuration file this service loaded; a save applies at the next start (agent-console::US-009).
const dispatchGroupSettings = new DispatchGroupSettings({ file: channelConfigurationPath, running: feishuConfiguration?.dispatch?.groupChatIds ?? [],
  unfinished: () => unfinishedRequestsByGroup(agentDispatch?.getState().jobs ?? [], (accountId, target) => feishuConfiguration!.owner.deliveryTarget(accountId, target)),
  names: (chatIds) => groupNames?.of(chatIds) ?? Promise.resolve({}), audit: consoleAudit });
const consoleRoutes = createConsoleRoutes({ catalog: mcpCatalog, ...(teamManagement ? { teams: teamManagement } : {}), dispatchGroups: dispatchGroupSettings });
const server = service ? createDemoServer(service, { fixtureMode, channelState, access: consoleAccess, consoleRoutes, ...(fixtureFeishu ? { feishuFixture: fixtureFeishu } : {}) }) : createChannelStatusServer(
  () => ({ channel: "feishu", ready: channelReady && feishuChannel!.state({ ...feishuConfiguration!.owner.conversationAddress(), channel: "feishu" }).enabled, ...feishuChannel!.getSnapshot(), ...channelState(), codex: codexService.getPublicState(),
    ...(fixtureFeishu ? { fixtureTextOutbox: fixtureFeishu.getTextOutbox(), fixtureMediaOutbox: fixtureFeishu.getMediaOutbox(), workflows: workflowEngine.getPublicState() } : {}) }),
  fixtureFeishu,
  consoleAccess,
  consoleRoutes,
);

// Binding the exclusive listener precedes any news handoff or activation.
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
});
process.stdout.write(`${feishuChannel ? "飞书服务状态" : "个人微信直连 iLink Demo"}: http://${host}:${port}${feishuChannel ? "/api/state" : ""}\n`);
if (fixtureMode) process.stdout.write("当前为 fixture 测试模式，不会连接真实渠道或发送真实消息。\n");
mcpCatalog.start();
// The login command reaches the running service through this owner-only channel; without it the service still runs.
const consoleControl = await ConsoleControlServer.start({ stateDirectory: consoleStateDirectory, access: consoleAccess, port }).catch((error: unknown) => {
  process.stderr.write(`console_control_unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  return undefined;
});
let stopping = false;
const pennyStartup = penny?.start().catch(() => { pennyError = "penny_startup_unavailable"; });
const startup = (async () => {
  let workflowReady = false;
  try {
    if (initializeFixtureWorkflow) {
      await workflowEngine.submit({
        triggerId: "fixture-status-check",
        source: "fixture",
        occurredAt: Date.now(),
        requestedWorkflowId: "fixture.status-check",
      });
    }
    const retiredResolverRuns = workflowRetirementNotifier?.migrate() ?? [];
    if (retiredResolverRuns.length > 0) {
      process.stderr.write(`${retiredResolverRuns.length} 个旧文件查询任务已安全终止，请重新发起。\n`);
    }
    await workflowEngine.start();
    workflowReady = true;
  } catch {
    process.stderr.write("工作流运行记录暂不可用；页面会保留只读错误边界。\n");
  }
  let codexReady = false;
  if (stopping) return;
  try {
    await codexService.start();
    codexReady = true;
  } catch {
    process.stderr.write("独立 Codex 微信服务暂未启动；页面会显示错误状态。\n");
  }
  if (stopping) return;
  try {
    const handoff = new DailyNewsHandoff(path.join(path.dirname(privateStatePath), "daily-ai-news.json"));
    const existing = scheduledTasks.newsSnapshot();
    if (existing.owner) {
      if (!existing.sourceHash || !handoff.verifyCommitted(existing.sourceHash)) throw new Error("daily_news_fence_missing");
    } else {
      const legacyPid = process.env.CODEX_WEIXIN_LEGACY_NEWS_PID;
      scheduledTasks.reconcileDailyNews(handoff.prepare(legacyPid === undefined ? undefined : Number(legacyPid)));
    }
    dailyNewsActive = true;
  } catch {
    process.stderr.write("每日 AI 新闻调度暂未启动；页面会显示错误状态。\n");
  }
  if (stopping) return;
  if (!codexReady || !workflowReady) {
    process.stderr.write("core_startup_incomplete\n");
    return;
  }
  if (!stopping) workflowRetirementNotifier?.start();
  if (!stopping) contextTokenExperiment?.start();
  if (!stopping) await scheduledTasks.start().catch(() => process.stderr.write("定时任务启动未完成，请检查本地状态。\n"));
  let planMonitorStarted = false;
  await Promise.all(activeChannels.map(async ({ name, port: channel, owner }) => {
    try {
      await channel.start();
      if (owner && !stopping) {
        for (const address of owner.conversationAddresses()) {
          try { await codexService.enable(address.accountId, address.target); }
          catch (error) {
            if (!address.target.startsWith("feishu.group.")) throw error;
            process.stderr.write("group_runtime_start_failed\n");
          }
        }
      }
      if (!stopping && name === "feishu" && agentDispatch) {
        await Promise.all([...dispatchApplications.values()].map(startDispatchApplication));
        await agentDispatch.start();
        // Pending announcements go out through Sam's group channel, and onboarding resumes where it stopped.
        teamManagement?.deliverAnnouncementsWith(async ({ id, chatId, text }) => {
          const address = feishuConfiguration!.owner.conversationAddresses().find(({ accountId, target }) => feishuConfiguration!.owner.deliveryTarget(accountId, target) === chatId);
          if (!address) return "rejected";
          const sent = await feishuChannel!.send({ channel: "feishu", accountId: address.accountId, target: address.target, message: text,
            operationId: `team-announcement:${id}`, beforeSubmit: () => true });
          return sent.ok ? "accepted" : sent.reason === "unknown" ? "unknown" : "rejected";
        });
        void teamManagement?.resume().catch(() => process.stderr.write("team_onboarding_resume_failed\n"));
      }
      if (!stopping) {
        startedChannels.add(name);
        channelReady = true;
        if (!planMonitorStarted) { planMonitorStarted = true; startPlanMonitor?.(); }
        channel.activateInboundDispatch?.();
      }
    } catch {
      channel.pauseInboundDispatch?.();
      process.stderr.write(`${name}_startup_failed\n`);
    }
  }));

})();


let shuttingDown: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (shuttingDown) return shuttingDown;
  stopping = true;
  channelReady = false;
  for (const { port: channel } of activeChannels) channel.pauseInboundDispatch?.();
  startedChannels.clear();
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  shuttingDown = (async () => {
  try { await settleCleanup([
    () => pennyStartup,
    () => penny?.close(),
    () => agentDispatch?.close(),
    ...[...dispatchApplications.values()].map((application) => () => { application.ready = false; return application.transport.close(); }),
    () => workflowRetirementNotifier?.close(),
    () => pendingResponseAgent?.close(),
    () => groupPendingResponseAgent?.close(),
    () => service ? service.close() : codexService.close(),
    () => feishuChannel?.close(),
    () => startup,
    () => scheduledTasks.close(),
    () => httpClosed,
    () => consoleControl?.close(),
    () => consoleAccess.close(),
    () => mcpCatalog.close(),
    () => workflowEngine.close(),
    () => localFileTools.close(),
    () => workflowModulePermissions.close(),
    () => workflowRunTargets.close(),
    () => workflowPendingPresentations.close(),
    () => durableInboundStore?.close(),
    () => durableEffectLedger.close(),
  ]); } finally { if (diagnostics) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([diagnostics.close(), new Promise<void>((resolve) => { deadline = setTimeout(resolve, 5_000); })]);
    clearTimeout(deadline);
  } }
  })().then(() => { process.exitCode = 0; }, (error) => {
    process.stderr.write(`service_shutdown_failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
  return shuttingDown;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
