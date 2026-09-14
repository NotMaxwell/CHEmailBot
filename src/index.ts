import { routes } from "./web/routes.ts";
import { config, VERSION } from "./config.ts";

console.log(`CHEmailBot ${VERSION} on http://${config.host}:${config.port}`);
if (config.host !== "127.0.0.1" && config.host !== "localhost") {
  console.warn(`WARNING: HOST=${config.host} exposes this unauthenticated UI beyond this machine.`);
}
if (config.send.dryRun) console.log("DRY_RUN is ON - nothing will actually send.");

export default { port: config.port, hostname: config.host, fetch: routes.fetch };
