import { createService } from "./app";
import { loadConfig } from "./config";

const config = await loadConfig();
const service = createService(config);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: 8 * 1024 * 1024,
  fetch: service.app.fetch,
});
console.info(
  JSON.stringify({ event: "listening", host: config.host, port: server.port }),
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await service.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
