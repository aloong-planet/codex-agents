import path from "node:path";

export function resolvePrivateStatePath(
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  const override = env.WEIXIN_DEMO_STATE_DIR?.trim();
  const stateDir =
    override ||
    path.join(
      homeDir,
      "Library",
      "Application Support",
      "weixin-ilink-direct-demo",
    );
  return path.join(stateDir, "state.json");
}
