import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { principalFromAgentKey, type Principal } from '../services';
import { createSerpentMcpServer } from './server';

function agentKey(req: Request): string | null {
  const header = req.headers['x-agent-api-key'];
  if (header !== undefined) {
    if (typeof header !== 'string' || !header.trim().startsWith('agk_')) return null;
    return header.trim();
  }
  const authorization = req.headers.authorization;
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer\s+(agk_[^\s]+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function unauthorized(res: Response): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="serpent-mcp"');
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: '需要有效的 Agent API Key（Bearer agk_...）' },
    id: null,
  });
}

function methodNotAllowed(res: Response): void {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
}

async function authenticate(req: Request): Promise<Principal | null> {
  const key = agentKey(req);
  if (!key) return null;
  try {
    const principal = await principalFromAgentKey(key);
    return principal.kind === 'agent' ? principal : null;
  } catch {
    return null;
  }
}

export function createMcpRouter(): express.Router {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const principal = await authenticate(req);
    if (!principal) {
      unauthorized(res);
      return;
    }

    const server = createSerpentMcpServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (!closing) closing = server.close().catch(() => undefined);
      return closing;
    };
    res.once('close', () => { void close(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      await close();
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'MCP 请求处理失败' },
          id: null,
        });
      }
    }
  });

  router.get('/', (_req, res) => methodNotAllowed(res));
  router.delete('/', (_req, res) => methodNotAllowed(res));
  return router;
}

export { createSerpentMcpServer } from './server';
