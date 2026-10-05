import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db.js';
import { createApp } from './app.js';

async function main() {
  await connectDb(env.MONGODB_URI);
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`Bookly API listening on http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
