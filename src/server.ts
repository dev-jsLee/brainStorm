import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const app = await buildApp(cfg);
const addrs = await app.listen();
app.fastify.log.info({ addrs, dataDir: cfg.dataDir }, 'brainStorm listening');

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    app.fastify.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
