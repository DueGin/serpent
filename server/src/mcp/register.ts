import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, GetPromptResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

type ToolShape = Record<string, z.ZodTypeAny>;
type ToolInput = ToolShape | z.ZodTypeAny;
type ToolArgs<I> = I extends z.ZodTypeAny
  ? z.infer<I>
  : { [K in keyof I]: I[K] extends z.ZodTypeAny ? z.infer<I[K]> : never };

interface ToolConfig<I extends ToolInput> {
  title?: string;
  description?: string;
  inputSchema?: I;
  annotations?: ToolAnnotations;
}

type ErasedRegister = (
  name: string,
  config: ToolConfig<ToolInput>,
  callback: (args: Record<string, unknown>) => Promise<CallToolResult>,
) => unknown;

export function tool<I extends ToolInput>(
  server: McpServer,
  name: string,
  config: ToolConfig<I>,
  handler: (args: ToolArgs<I>) => Promise<CallToolResult>,
): void {
  // SDK 1.32.2 的 zod v3/v4 联合泛型会在嵌套 schema 上耗尽编译器堆；
  // 仅擦除 SDK 边界，注册时仍用原 schema，处理器入口再次 parse，不牺牲运行时校验。
  const register = server.registerTool.bind(server) as unknown as ErasedRegister;
  const input = config.inputSchema;
  const schema = input === undefined ? z.object({}) : input instanceof z.ZodType ? input : z.object(input);
  register(name, config, async (args) => handler(schema.parse(args)));
}

interface PromptConfig<I extends ToolShape> {
  title?: string;
  description?: string;
  argsSchema: I;
}

type ErasedPromptRegister = (
  name: string,
  config: PromptConfig<ToolShape>,
  callback: (args: Record<string, unknown>) => Promise<GetPromptResult>,
) => unknown;

export function prompt<I extends ToolShape>(
  server: McpServer,
  name: string,
  config: PromptConfig<I>,
  handler: (args: z.infer<z.ZodObject<I>>) => Promise<GetPromptResult>,
): void {
  // 与 tool 相同：只擦除 SDK 的深层兼容泛型，实际参数仍由 Zod 解析。
  const register = server.registerPrompt.bind(server) as unknown as ErasedPromptRegister;
  const schema = z.object(config.argsSchema);
  register(name, config, async (args) => handler(schema.parse(args)));
}
