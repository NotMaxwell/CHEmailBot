# CHEmailBot on Render

`render.yaml` in the repo root describes the whole service. You point Render at
the repo, type in the secrets it asks for, and it builds the Docker image,
attaches a persistent disk, and starts the app.

**Read this first:** a Render service is on the public internet at a guessable
URL. Sign-up is admin-approved, so finding the app is not the same as getting
into it — a stranger can file a request and wait. The blueprint also sets
`SIGNUP_CODE`, which keeps the requests page free of noise and covers the window
before anyone has claimed the first admin account. Even so, the
[Raspberry Pi deployment](../pi/README.md) is the better home for a sponsor
database and a live send button. Use Render when nobody can host the Pi, or when
the team needs it reachable from anywhere without installing anything.

Costs: Starter instance + 1GB disk, currently about $8/month. Free instances
cannot have a disk and spin down when idle, which would lose the database and
every in-flight scrape, so the blueprint does not offer that option.

---

## 1. Deploy

1. Push this repo to GitHub or GitLab.
2. Render dashboard → **New → Blueprint** → select the repo → **Apply**.
3. Fill in the values it asks for:

   | | |
   |---|---|
   | `SENDER_NAME` | The name that signs the emails |
   | `SENDER_ORG` | e.g. Critical Hit Robotics |
   | `SENDER_POSTAL_ADDRESS` | A real one, on one line — CAN-SPAM requires it |
   | `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | From §2, so do that first |
   | `GMAIL_SENDER` | The Gmail address mail leaves from |
   | `TEST_EMAIL` | Your own address, on a **different** provider |

   Everything else — ports, paths, the disk, the sending guardrails — is
   already set in `render.yaml`.

4. When the first deploy finishes, note the service URL:
   `https://chemailbot-xxxx.onrender.com`.

5. **Get the sign-up code.** Dashboard → the service → **Environment** →
   `SIGNUP_CODE`. Render generated it. Creating any account, including the
   first admin one, needs it. Give it to the team, or replace it with a phrase
   they can remember and redeploy.

6. Open the URL and create the first account — it is the admin, and claiming it
   promptly is the point of step 5. Everyone else asks for an account at
   `/signup`, and you accept them at `/requests`; the nav carries a count while
   anyone is waiting.

## 2. Gmail

In the Google Cloud console, *Google Auth Platform → Clients*, create a client
of type **Web application**. Its redirect URI is your Render URL plus the
callback path — exactly, no trailing slash:

```
https://chemailbot-xxxx.onrender.com/oauth/callback
```

You do not need to put that URI into Render as well: the app derives it from
`RENDER_EXTERNAL_URL`, which Render sets to the service's own address. (If you
attach a **custom domain**, that stops matching — add `GMAIL_REDIRECT_URI`
explicitly with the custom domain, and add that URI to the Google client too.)

Paste the client ID and secret into Render's Environment tab if you have not
already, then open `/oauth/start` on the live site and grant access. The
refresh token is written to the disk at `/var/data` and survives deploys.

The scope requested is `gmail.send` only — it cannot read the mailbox.

## 3. Before you let it send

Dashboard → the service → **Shell**:

```bash
bun run test:self                  # renders it; sends nothing
DRY_RUN=0 bun run test:self --send # transmits exactly one, to TEST_EMAIL
```

Read what arrives, footer included. The second command's `DRY_RUN=0` applies to
that one command — the service itself is still in dry-run. When you are
satisfied, set `DRY_RUN=0` in the Environment tab; Render restarts the service
automatically.

## 4. What to know about running it here

**One instance, always.** The database is a SQLite file on the attached disk.
Scaling to two instances would give you two processes writing one file. Leave
the instance count at 1. This is also why deploys have a few seconds of
downtime — a disk cannot be mounted by the old and new instance at once.

**Backups are not automatic here.** The nightly cron in the Pi deployment has
no equivalent. Take one from the Shell tab and copy it somewhere off Render:

```bash
bun run backup          # writes to /var/data/backups
```

Render's own disk snapshots are a second layer, not a substitute — they go away
with the service.

**Long scrapes survive, deploys do not.** A Chamber sync runs in the background
inside the process. A redeploy or a restart kills it mid-run; nothing is
corrupted, but you start it again.

**The contact-form assistant does not run here.** `bun run form:assist <id>`
drives a visible browser. Run it on a laptop against a local clone.

**Auto-deploy is on.** A push to the default branch redeploys. Turn it off
under Settings if you would rather deploy on purpose.

## 5. Troubleshooting

**Deploy succeeds, health check fails.** `healthCheckPath` must be `/login` —
`/` redirects there, and Render reads the 302 as unhealthy.

**Every form action returns "Forbidden".** The CSRF origin check compares
hosts. Use one hostname consistently; mixing the `onrender.com` URL and a
custom domain in the same session will do it.

**`redirect_uri_mismatch` from Google.** The Google client's redirect URI has
to match what the app sends, character for character — `https`, the exact
hostname, `/oauth/callback`, no trailing slash.

**"Refusing to send: missing sender identity."** `SENDER_NAME` or
`SENDER_POSTAL_ADDRESS` is empty in the Environment tab.

**The database looks empty after a deploy.** `DB_PATH` is not pointing at the
disk. It must be `/var/data/chembot.db`, and the disk must be mounted at
`/var/data` — not `/app/data`, which would hide the schema file the image
ships and stop the app from starting at all.
