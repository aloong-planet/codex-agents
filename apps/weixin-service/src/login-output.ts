export type LoginOutputEvent =
  | { kind: "qr"; url: string }
  | { kind: "scanned" }
  | { kind: "pair_code_required" }
  | { kind: "connected" }
  | { kind: "already_connected" };
