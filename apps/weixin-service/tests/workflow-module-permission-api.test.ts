import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoService, type ChannelSnapshot, type WeixinChannel } from "../src/demo-service.js";
import { createDemoServer } from "../src/http-server.js";

class Port implements WeixinChannel {
  async start(): Promise<void> {}
  getSnapshot(): ChannelSnapshot { return { accounts: [], targets: [] }; }
  onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void): () => void {
    listener(this.getSnapshot());
    return () => {};
  }
  updateLocalLabels(): void {}
  startLogin() { return { submitPairCode() {}, terminate() {} }; }
  async sendText() { return { ok: true as const, messageId: "m-1" }; }
  close(): void {}
}

describe("workflow module permission API", () => {
  const servers: ReturnType<typeof createDemoServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("publishes settings and forwards a confirmed read/write selection", async () => {
    const configure = vi.fn();
    const modulePermissions = {
      getPublicState: () => ({
        executeAllowed: false as const,
        modules: [{
          moduleId: "notes", name: "Obsidian 笔记", description: "读写 Markdown", revision: 0, saved: false,
          scopes: [{ scopeId: "demo-vault", label: "demo Vault", directory: "/tmp/demo", read: true, write: false }],
        }],
      }),
      configure,
    };
    const service = new DemoService(
      new Port(), async () => "data:image/svg+xml,safe",
      undefined, undefined, undefined, undefined, undefined, undefined, modulePermissions,
    );
    const server = createDemoServer(service);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const origin = `http://127.0.0.1:${address.port}`;

    await expect((await fetch(`${origin}/api/state`)).json()).resolves.toMatchObject({
      workflowModulePermissions: { executeAllowed: false, modules: [{ moduleId: "notes", saved: false }] },
    });
    const response = await fetch(`${origin}/api/workflows/module-permissions/configure`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        moduleId: "notes", expectedRevision: 0, confirmed: true,
        scopes: [{ scopeId: "demo-vault", read: true, write: true }],
      }),
    });

    expect(response.status).toBe(200);
    expect(configure).toHaveBeenCalledWith({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "demo-vault", read: true, write: true }],
    });
    await service.close();
  });
});
