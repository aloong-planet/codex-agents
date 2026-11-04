import { test as base } from "@playwright/test";
import { startFixtureServer } from "./fixture-server.js";

type Fixtures = {
  fileScanLimit: number | undefined;
  modelMode: string;
  routerMode: string;
  fixtureServer: Awaited<ReturnType<typeof startFixtureServer>>;
};

export const test = base.extend<Fixtures>({
  fileScanLimit: [undefined, { option: true }],
  modelMode: [process.env.WORKFLOW_SIMULATOR_MODEL ?? "fixture", { option: true }],
  routerMode: [process.env.WORKFLOW_SIMULATOR_PENDING_ROUTER ?? "fixture", { option: true }],
  fixtureServer: [async ({ modelMode, routerMode, fileScanLimit }, use, info) => {
    const server = await startFixtureServer(modelMode, routerMode, fileScanLimit);
    const settings = {
      WORKFLOW_SIMULATOR_MODEL: modelMode, WORKFLOW_SIMULATOR_PENDING_ROUTER: routerMode,
      WORKFLOW_FIXTURE_TRACE_FILE: server.traceFile, WEIXIN_OTEL_DIRECTORY: server.otelDirectory,
      WORKFLOW_FIXTURE_STATE_DIRECTORY: server.directory,
    };
    const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    Object.assign(process.env, settings);
    try {
      await info.attach("fixture-environment", { body: JSON.stringify({ ...server, close: undefined, modelMode, routerMode }), contentType: "application/json" });
      await use(server);
    } finally {
      try {
        // Independent of the browser/POST: retain evidence even when an interaction times out.
        const response = await fetch(`${server.url}/api/state`, { signal: AbortSignal.timeout(2_000) });
        await info.attach("fixture-final-state", { body: await response.text(), contentType: "application/json" });
      } catch (error) {
        await info.attach("fixture-snapshot-error", { body: String(error), contentType: "text/plain" });
      } finally {
        try {
          await server.close();
          await info.attach("fixture-service-log", { path: server.traceFile, contentType: "text/plain" });
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
        }
      }
    }
  }, { timeout: 30_000 }],
  baseURL: async ({ fixtureServer }, use) => { await use(fixtureServer.url); },
});
