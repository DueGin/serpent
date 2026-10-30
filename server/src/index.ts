import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { config } from './config';
import { getDb } from './db';
import authRoutes from './routes/auth';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

getDb();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'serpent-arena' });
});

app.use('/api/auth', authRoutes);

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path.startsWith('/socket.io')) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

const server = http.createServer(app);

server.listen(config.port, () => {
  console.log(`[serpent] http://localhost:${config.port}`);
});
