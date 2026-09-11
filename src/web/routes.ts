import { Hono } from "hono";
import { layout } from "./views/layout.ts";

export const routes = new Hono();

// Review queue: every company + its resolved address + contact status.
// TODO: render table, approve/reject buttons (hx-post), per-company preview.
routes.get("/", (c) => c.html(layout("Companies", "<p>TODO: review queue</p>")));

// TODO: edit subject/body, live-preview merge fields against a sample company.
routes.get("/templates", (c) => c.html(layout("Template", "<p>TODO</p>")));

// TODO: every send attempt, status, error, timestamp.
routes.get("/log", (c) => c.html(layout("Send log", "<p>TODO</p>")));

// TODO: Gmail OAuth bootstrap.
routes.get("/oauth/start", (c) => c.text("TODO"));
routes.get("/oauth/callback", (c) => c.text("TODO"));
