import { routes } from "./web/routes.ts";
import { config } from "./config.ts";

console.log(`CHEmailBot on http://localhost:${config.port}`);
if (config.send.dryRun) console.log("DRY_RUN is ON - nothing will actually send.");

export default { port: config.port, fetch: routes.fetch };
