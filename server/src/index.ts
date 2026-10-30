import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config';
import { requireAuth } from './auth';
import { getDb } from './db';
import { manager } from './game/manager';
import authRoutes from './routes/auth';
import agentRoutes from './routes/agents';
import roomRoutes from './routes/rooms';
import a2aRoutes from './routes/a2a';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

getDb();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'a2a-serpent' });
});

app.use('/api/auth', authRoutes);
app.get('/api/presence', requireAuth, (_req, res) => {
  res.json({ data: manager.listPresence() });
});
app.use('/api/agents', agentRoutes);
app.use('/api/rooms', roomRoutes);
app.use(a2aRoutes);

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/a2a') || req.path.startsWith('/socket.io')) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
manager.attach(io);

server.listen(config.port, () => {
  console.log(`[serpent] http://localhost:${config.port}`);
  console.log(`[serpent] agent card  ${config.publicUrl}/.well-known/agent-card.json`);
  console.log(`[serpent] A2A JSON-RPC ${config.publicUrl}/a2a`);
});
