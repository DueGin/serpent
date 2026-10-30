import { Router } from 'express';
import { manager } from '../game/manager';
import { agentCard } from '../a2a/card';
import { applyIntent, cancelTask, getTask, parseIntent, taskResult, upsertTask } from '../a2a/protocol';

const router = Router();

function speaker(req: { headers: Record<string, unknown> }) {
  const key = String(req.headers['x-agent-api-key'] ?? req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const existing = manager.agentByKey(key);
  if (existing) return existing;
  return manager.registerAgent('a2a-agent');
}

function partsOf(message: { parts?: Array<{ kind?: string; text?: string; data?: Record<string, unknown> }> }) {
  const parts = message.parts ?? [];
  const text = parts.filter((p) => p.kind === 'text' && p.text).map((p) => p.text).join('\n');
  const data = parts.find((p) => p.kind === 'data' && p.data)?.data;
  return { text, data };
}

router.get('/.well-known/agent-card.json', (_req, res) => {
  res.json(agentCard());
});

router.get('/.well-known/agent.json', (_req, res) => {
  res.json(agentCard());
});

router.post('/a2a', (req, res) => {
  const body = req.body ?? {};
  const id = body.id ?? null;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }

  try {
    if (body.method === 'tasks/get') {
      const taskId = body.params?.id;
      const task = getTask(taskId);
      if (!task) {
        res.json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } });
        return;
      }
      const room = task.roomCode ? manager.getRoom(task.roomCode) : null;
      const observation = room ? room.observe(task.playerId) : undefined;
      res.json({ jsonrpc: '2.0', id, result: taskResult(task, observation ? 'ok' : 'no room', observation).result });
      return;
    }

    if (body.method === 'tasks/cancel') {
      const task = cancelTask(body.params?.id);
      if (!task) {
        res.json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } });
        return;
      }
      res.json({ jsonrpc: '2.0', id, result: { id: task.id, contextId: task.contextId, status: { state: task.state } } });
      return;
    }

    if (body.method !== 'message/send' && body.method !== 'message/stream') {
      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${body.method}` } });
      return;
    }

    const agent = speaker(req);
    const message = body.params?.message ?? {};
    const { text, data } = partsOf(message);
    const intent = parseIntent(text || '', data);
    const task = upsertTask({
      taskId: body.params?.message?.taskId ?? body.params?.taskId,
      contextId: message.contextId ?? body.params?.contextId,
      agentId: agent.id,
      playerId: agent.id,
    });
    const out = applyIntent(manager, task, intent, agent.name);
    const payload = { jsonrpc: '2.0' as const, id, result: taskResult(out.task, out.text, out.observation, out.extra).result };

    if (body.method === 'message/stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (!out.task.roomCode) {
        res.end();
        return;
      }
      const room = manager.getRoom(out.task.roomCode);
      const off = room.onUpdate((r) => {
        const observation = r.observe(task.playerId);
        if (observation.gameOver) task.state = 'completed';
        const tickPayload = { jsonrpc: '2.0', id, result: taskResult(task, observation.grid, observation).result };
        res.write(`data: ${JSON.stringify(tickPayload)}\n\n`);
        if (observation.gameOver) {
          off();
          res.end();
        }
      });
      req.on('close', () => off());
      return;
    }

    res.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    res.json({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }
});

export default router;
