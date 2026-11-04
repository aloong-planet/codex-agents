export type DynamicToolFunctionDefinition = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type DynamicToolNamespaceDefinition = {
  type: "namespace";
  name: string;
  description: string;
  tools: DynamicToolFunctionDefinition[];
};

export type DynamicToolDefinition = DynamicToolFunctionDefinition | DynamicToolNamespaceDefinition;

export type DynamicToolResult = {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
};

export type DynamicToolContext = {
  threadId: string;
  turnId: string;
  namespace: string | null;
};

export interface DynamicToolHost {
  definitions(): DynamicToolDefinition[];
  execute(
    tool: string,
    argumentsValue: unknown,
    context?: DynamicToolContext,
  ): Promise<DynamicToolResult>;
  turnOwner?(context: DynamicToolContext): "model" | "workflow";
}
