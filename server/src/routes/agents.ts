import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth';
import { DEFAULT_AGENT_PROMPT } from '../config';
import {
  createAgent,
  deleteAgent,
  getAgentById,
  getAgentByPlatformKey,
  listAgentsByUser,
  toPublicAgent,
  updateAgent,
  type Protocol,
} from '../db';
import { manager } from '../game/manager';
import { pingLlm } from '../agent/llm-client';
import { sendError } from '../http';

const router = Router();

const protocolSchema = z.enum(['chat', 'message', 'jev', 'laya']);
const upsertSchema = z.object({
  name: z.string().trim().min(1).max(24),
  protocol: protocolSchema,
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().min(4).max(256).optional(),
  systemPrompt: z.string().max(4000).optional(),
  enabled: z.boolean().optional(),
});

router.get('/prompt-default', (_req, res) => {
  res.json({ prompt: DEFAULT_AGENT_PROMPT });
});

router.get('/me', (req, res) => {
  const key = String(req.headers['x-agent-api-key'] ?? '');
  const bound = getAgentByPlatformKey(key);
  if (bound) {
    res.json({ id: `a_${bound.id}`, name: bound.name, model: bound.model, protocol: bound.protocol });
    return;
  }
  const ephemeral = manager.agentByKey(key);
  if (!ephemeral) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '缺少或无效的 X-Agent-Api-Key' } });
    return;
  }
  res.json(ephemeral);
});

router.post('/guest', (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(16) }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: '需要 name' } });
    return;
  }
  res.status(201).json(manager.registerAgent(parsed.data.name));
});

router.get('/', requireAuth, (req: AuthedRequest, res) => {
  const rows = listAgentsByUser(req.auth!.userId).map(toPublicAgent);
  res.json({ data: rows });
});

router.post('/', requireAuth, (req: AuthedRequest, res) => {
  const parsed = upsertSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Agent 配置不合法' } });
    return;
  }
  if (!parsed.data.apiKey) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: '需要上游 API Key' } });
    return;
  }
  const row = createAgent({
    userId: req.auth!.userId,
    name: parsed.data.name,
    protocol: parsed.data.protocol as Protocol,
    baseUrl: parsed.data.baseUrl,
    model: parsed.data.model,
    apiKey: parsed.data.apiKey,
    systemPrompt: parsed.data.systemPrompt,
  });
  res.status(201).json(toPublicAgent(row));
});

router.patch('/:id', requireAuth, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const row = getAgentById(id);
  if (!row || row.user_id !== req.auth!.userId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent 不存在' } });
    return;
  }
  const parsed = upsertSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: '更新内容不合法' } });
    return;
  }
  const next = updateAgent(id, parsed.data);
  res.json(toPublicAgent(next!));
});

router.delete('/:id', requireAuth, (req: AuthedRequest, res) => {
  const ok = deleteAgent(Number(req.params.id), req.auth!.userId);
  if (!ok) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent 不存在' } });
    return;
  }
  res.json({ ok: true });
});

router.post('/:id/test', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const row = getAgentById(Number(req.params.id));
    if (!row || row.user_id !== req.auth!.userId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Agent 不存在' } });
      return;
    }
    const result = await pingLlm({
      protocol: row.protocol,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: row.api_key,
    });
    res.json(result);
  } catch (err) {
    sendError(res, Object.assign(new Error(err instanceof Error ? err.message : '探测失败'), { code: 'UPSTREAM' }));
  }
});

export default router;
