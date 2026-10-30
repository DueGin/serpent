import { startServer } from './app';

void startServer().then(({ server, close }) => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : address;
  console.log(`[serpent] http://localhost:${port}`);
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    void close().then(() => {
      clearTimeout(deadline);
      process.exit(0);
    }).catch(() => {
      console.error('[serpent] 服务关闭失败');
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}).catch(() => {
  console.error('[serpent] 服务启动失败');
  process.exitCode = 1;
});
