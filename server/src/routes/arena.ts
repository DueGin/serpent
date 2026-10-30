import { Router, type Request } from 'express';
import { AppError, asyncRoute } from '../http';
import { agentsSvc, laddersSvc, matchesSvc, principalFromRequest, scriptsSvc, teamsSvc, type Principal } from '../services';
import * as schema from './schemas';

async function principal(req: Request, kind?: Principal['kind']): Promise<Principal> {
  const p = await principalFromRequest(req);
  if (!p) throw new AppError('UNAUTHORIZED', kind === 'agent' ? '请提供 Agent API Key' : '请先登录或提供 Agent API Key');
  if (kind && p.kind !== kind) throw new AppError('FORBIDDEN', kind === 'user' ? '此操作需要用户登录' : '此操作需要 Agent API Key');
  return p;
}

function noInput(req: Request): void {
  schema.emptySchema.parse(req.query);
  schema.emptySchema.parse(req.body ?? {});
}

export function createArenaRouter(): Router {
  const router = Router();

  router.get('/health', asyncRoute((req, res) => { noInput(req); res.json({ ok: true, service: 'serpent-arena' }); }));
  router.get('/stats', asyncRoute(async (req, res) => {
    noInput(req);
    res.json(await matchesSvc.platformStats());
  }));

  router.get('/agents', asyncRoute(async (req, res) => {
    const p = await principal(req, 'user'); noInput(req);
    res.json({ data: await agentsSvc.listMine(p) });
  }));
  router.post('/agents', asyncRoute(async (req, res) => {
    const p = await principal(req, 'user'); schema.emptySchema.parse(req.query);
    res.status(201).json(await agentsSvc.create(p, schema.agentCreateSchema.parse(req.body)));
  }));
  router.get('/agents/me', asyncRoute(async (req, res) => {
    const p = await principal(req, 'agent'); noInput(req);
    res.json(await agentsSvc.getMe(p));
  }));
  router.get('/agents/directory', asyncRoute(async (req, res) => {
    noInput(req); res.json({ data: await agentsSvc.directory() });
  }));
  router.get('/agents/:id/profile', asyncRoute(async (req, res) => {
    noInput(req); res.json(await agentsSvc.profile(schema.pathId.parse(req.params.id)));
  }));
  router.patch('/agents/:id', asyncRoute(async (req, res) => {
    const p = await principal(req, 'user'); schema.emptySchema.parse(req.query);
    res.json(await agentsSvc.update(p, schema.pathId.parse(req.params.id), schema.agentPatchSchema.parse(req.body)));
  }));
  router.delete('/agents/:id', asyncRoute(async (req, res) => {
    const p = await principal(req, 'user'); noInput(req);
    res.json(await agentsSvc.remove(p, schema.pathId.parse(req.params.id)));
  }));
  router.post('/agents/:id/rotate-key', asyncRoute(async (req, res) => {
    const p = await principal(req, 'user'); noInput(req);
    res.json(await agentsSvc.rotateKey(p, schema.pathId.parse(req.params.id)));
  }));

  router.get('/scripts', asyncRoute(async (req, res) => {
    const p = await principal(req);
    res.json({ data: await scriptsSvc.list(p, schema.mineScriptsQuery.parse(req.query)) });
  }));
  router.get('/scripts/public', asyncRoute(async (req, res) => {
    res.json({ data: await scriptsSvc.listPublic(schema.publicScriptsQuery.parse(req.query)) });
  }));
  router.get('/scripts/scenarios', asyncRoute(async (req, res) => {
    noInput(req); res.json({ data: await scriptsSvc.scenarios() });
  }));
  router.post('/scripts/validate', asyncRoute(async (req, res) => {
    await principal(req); schema.emptySchema.parse(req.query);
    res.json(await scriptsSvc.validate(schema.validateSchema.parse(req.body).code));
  }));
  router.post('/scripts/dry-run', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await scriptsSvc.dryRun(p, schema.dryRunSchema.parse(req.body)));
  }));
  router.post('/scripts', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.status(201).json(await scriptsSvc.create(p, schema.scriptCreateSchema.parse(req.body)));
  }));
  router.get('/scripts/:id', asyncRoute(async (req, res) => {
    const p = await principalFromRequest(req); noInput(req);
    res.json(await scriptsSvc.get(p, schema.pathId.parse(req.params.id)));
  }));
  router.patch('/scripts/:id', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await scriptsSvc.update(p, schema.pathId.parse(req.params.id), schema.scriptPatchSchema.parse(req.body)));
  }));
  router.delete('/scripts/:id', asyncRoute(async (req, res) => {
    const p = await principal(req); noInput(req);
    res.json(await scriptsSvc.archive(p, schema.pathId.parse(req.params.id)));
  }));
  router.post('/scripts/:id/versions', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.status(201).json(await scriptsSvc.addVersion(p, schema.pathId.parse(req.params.id), schema.versionCreateSchema.parse(req.body)));
  }));
  router.get('/scripts/:id/versions/:version', asyncRoute(async (req, res) => {
    const p = await principalFromRequest(req); noInput(req);
    res.json(await scriptsSvc.getVersion(p, schema.pathId.parse(req.params.id), schema.pathId.parse(req.params.version)));
  }));

  router.post('/matches', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.status(201).json(await matchesSvc.create(p, schema.matchCreateSchema.parse(req.body)));
  }));
  router.get('/matches', asyncRoute(async (req, res) => {
    const p = await principalFromRequest(req);
    res.json({ data: await matchesSvc.list(p, schema.matchesQuery.parse(req.query)) });
  }));
  router.get('/matches/live', asyncRoute(async (req, res) => {
    noInput(req); res.json({ data: await matchesSvc.live() });
  }));
  router.get('/matches/:id', asyncRoute(async (req, res) => {
    const p = await principalFromRequest(req); noInput(req);
    res.json(await matchesSvc.get(p, schema.pathId.parse(req.params.id)));
  }));
  router.get('/matches/:id/replay', asyncRoute(async (req, res) => {
    noInput(req); res.json(await matchesSvc.replay(schema.pathId.parse(req.params.id)));
  }));
  router.get('/matches/:id/frames/:tick', asyncRoute(async (req, res) => {
    const p = await principalFromRequest(req);
    const query = schema.frameQuery.parse(req.query);
    res.json(await matchesSvc.frame(p, schema.pathId.parse(req.params.id), schema.pathTick.parse(req.params.tick), query.viewer));
  }));

  router.get('/ladders', asyncRoute(async (req, res) => {
    noInput(req); res.json({ data: await laddersSvc.list() });
  }));
  router.get('/ladders/mine', asyncRoute(async (req, res) => {
    const p = await principal(req); noInput(req);
    res.json({ data: await laddersSvc.mine(p) });
  }));
  router.get('/ladders/:slug', asyncRoute(async (req, res) => {
    noInput(req); res.json(await laddersSvc.get(schema.slugSchema.parse(req.params.slug)));
  }));
  router.get('/ladders/:slug/leaderboard', asyncRoute(async (req, res) => {
    res.json({ data: await laddersSvc.leaderboard(schema.slugSchema.parse(req.params.slug), schema.leaderboardQuery.parse(req.query)) });
  }));
  router.post('/ladders/:slug/entries', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.status(201).json(await laddersSvc.join(p, schema.slugSchema.parse(req.params.slug), schema.ladderJoinSchema.parse(req.body)));
  }));
  router.patch('/ladders/:slug/entries/:entryId', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await laddersSvc.updateEntry(p, schema.slugSchema.parse(req.params.slug), schema.pathId.parse(req.params.entryId), schema.ladderPatchSchema.parse(req.body)));
  }));
  router.delete('/ladders/:slug/entries/:entryId', asyncRoute(async (req, res) => {
    const p = await principal(req); noInput(req);
    res.json(await laddersSvc.leave(p, schema.slugSchema.parse(req.params.slug), schema.pathId.parse(req.params.entryId)));
  }));
  router.post('/ladders/:slug/entries/:entryId/queue', asyncRoute(async (req, res) => {
    const p = await principal(req); noInput(req);
    res.json(await laddersSvc.queue(p, schema.slugSchema.parse(req.params.slug), schema.pathId.parse(req.params.entryId)));
  }));

  router.get('/teams', asyncRoute(async (req, res) => {
    noInput(req); res.json({ data: await teamsSvc.list() });
  }));
  router.post('/teams', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.status(201).json(await teamsSvc.create(p, schema.teamCreateSchema.parse(req.body)));
  }));
  router.post('/teams/join', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await teamsSvc.join(p, schema.teamJoinSchema.parse(req.body)));
  }));
  router.get('/teams/:id', asyncRoute(async (req, res) => {
    const p = await principalFromRequest(req); noInput(req);
    res.json(await teamsSvc.get(p, schema.pathId.parse(req.params.id)));
  }));
  router.patch('/teams/:id', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await teamsSvc.update(p, schema.pathId.parse(req.params.id), schema.teamPatchSchema.parse(req.body)));
  }));
  router.post('/teams/:id/leave', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await teamsSvc.leave(p, schema.pathId.parse(req.params.id), schema.teamLeaveSchema.parse(req.body ?? {})));
  }));
  router.post('/teams/:id/kick', asyncRoute(async (req, res) => {
    const p = await principal(req); schema.emptySchema.parse(req.query);
    res.json(await teamsSvc.kick(p, schema.pathId.parse(req.params.id), schema.teamKickSchema.parse(req.body).agentId));
  }));
  router.post('/teams/:id/rotate-invite', asyncRoute(async (req, res) => {
    const p = await principal(req); noInput(req);
    res.json(await teamsSvc.rotateInvite(p, schema.pathId.parse(req.params.id)));
  }));

  return router;
}
