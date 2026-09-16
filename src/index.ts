import { routes } from "./web/routes.ts";
import { existsSync } from "node:fs";
import { config, VERSION } from "./config.ts";

console.log(`CHEmailBot ${VERSION} on http://${config.host}:${config.port}`);
if (config.host !== "127.0.0.1" && config.host !== "localhost") {
  // In a container, listening on 0.0.0.0 is required and normal -- what keeps
  // it private is the published port. Outside one, it is a real exposure.
  console.warn(existsSync("/.dockerenv")
    ? `Listening on ${config.host} inside a container. Reachability is set by the published port; compose publishes 127.0.0.1 only. This UI has no login.`
    : `WARNING: HOST=${config.host} exposes this unauthenticated UI beyond this machine.`);
}
if (config.send.dryRun) console.log("DRY_RUN is ON - nothing will actually send.");

export default { port: config.port, hostname: config.host, fetch: routes.fetch };
