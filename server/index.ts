import { createApp } from "./app";
import { config } from "./config";
import { resumeQueuedLineEvents } from "./line";
const app = await createApp();
await app.listen({ port: config.port, host: config.host });
console.log(`Agent Family is ready at ${config.origin}`);
void resumeQueuedLineEvents();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
