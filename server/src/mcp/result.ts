import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface ErrorLike {
  code: string;
  message: string;
}

function errorLike(error: unknown): ErrorLike {
  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL';
    const message = 'message' in error && typeof error.message === 'string'
      ? error.message
      : '服务暂时无法完成请求';
    return { code, message };
  }
  return { code: 'INTERNAL', message: '服务暂时无法完成请求' };
}

function recoveryHint(code: string): string {
  switch (code) {
    case 'UNAUTHORIZED':
      return '检查 Agent API Key 是否有效；不要粘贴 JWT 或上游模型 Key。';
    case 'FORBIDDEN':
      return '核对 scriptId、teamId 是否属于当前 Agent，或改用自己的资源。';
    case 'NOT_FOUND':
      return '先用对应 list/get 工具核对 ID、版本或天梯 slug。';
    case 'VALIDATION_ERROR':
      return '按错误信息修正参数；脚本问题可先调用 validate_code 查看具体检测项。';
    case 'CONFLICT':
      return '名称或成员关系可能已存在，请查询现状后换一个名称或复用现有资源。';
    case 'LIMIT_EXCEEDED':
      return '归档不用的脚本或退出多余入场，再重试。';
    case 'RATE_LIMITED':
      return '稍后重试，不要并发重复提交相同写操作。';
    default:
      return '保留本次参数，稍后重试；若持续失败，请检查服务状态。';
  }
}

export function success(data: unknown, summary: string, next: string): CallToolResult {
  const json = JSON.stringify(data, null, 2) ?? 'null';
  return {
    content: [{ type: 'text', text: `${summary}\n\n\`\`\`json\n${json}\n\`\`\`\n\n下一步：${next}` }],
    structuredContent: { result: data },
  };
}

export function markdown(markdownText: string, next: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${markdownText}\n\n---\n\n下一步：${next}` }],
    structuredContent: { result: { markdown: markdownText } },
  };
}

export function failure(error: unknown): CallToolResult {
  const info = errorLike(error);
  return {
    content: [{
      type: 'text',
      text: `操作失败（${info.code}）：${info.message}\n\n下一步：${recoveryHint(info.code)}`,
    }],
    structuredContent: { error: { code: info.code, message: info.message } },
    isError: true,
  };
}

export async function perform(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return failure(error);
  }
}
