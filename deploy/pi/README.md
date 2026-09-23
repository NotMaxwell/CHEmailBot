# CHEmailBot on a Raspberry Pi

A Pi in the corner of a room, reachable by every laptop in the house and by
nothing on the internet. It costs nothing per month, the sponsor database stays
on hardware you own, and it survives a power cut without anyone doing anything.

Total time: about 40 minutes, most of it the Pi building the container.

---

## 1. What you need

| | |
|---|---|
| **Raspberry Pi 4, 5, or Zero 2 W** | Must be 64-bit capable. A Pi 3 works but the build is slow. |
| **A 64-bit OS** | Raspberry Pi OS (64-bit) Lite. Bun has **no 32-bit ARM build** — a 32-bit OS cannot run this at all, and `setup.sh` stops rather than let you find out later. |
| **2GB RAM or more** | 1GB works with swap. The build is the hungry part, not the app. |
| **Storage** | A USB SSD if you have one. An SD card works, but SQLite writes constantly and cards wear out — if you use one, take the backups in §8 seriously. |
| **Wired ethernet** | Wi-Fi is fine; a cable is one fewer thing that drops at 11pm mid-send. |

## 2. Flash the OS

Raspberry Pi Imager → **Raspberry Pi OS (64-bit) Lite** → the gear icon before
you write:

- set the hostname to `chembot` (this gives you `chembot.local` later)
- enable SSH, with a password or your public key
- set the username and password — the guide assumes the username `pi`
- fill in Wi-Fi only if you are not using a cable

Boot it, then from your laptop:

```bash
ssh pi@chembot.local          # or ssh pi@<ip> if .local does not resolve
sudo apt update && sudo apt full-upgrade -y && sudo reboot
```

## 3. Install

```bash
ssh pi@chembot.local
git clone <your-repo-url> ~/CHEmailBot
~/CHEmailBot/deploy/pi/setup.sh
```

The script installs Docker, asks for the handful of secrets it needs, puts the
data directory somewhere a `git pull` can never touch, admits the LAN through
the firewall, builds and starts the container, and schedules a nightly backup.
It is safe to run again — it skips every step already done and never overwrites
a value already in `.env`.

Have ready:

- the name and postal address that go in the CAN-SPAM footer of every message
- a Gmail **OAuth client ID and secret** (§6 — you can create these afterwards
  and re-run the script, it will ask again for whatever is still blank)

When it finishes it prints the address to give the team. Open it: the first
person to do so creates the admin account.

---

## 4. The one rule

**Do not forward a port to this.** Not port 3000, not port 80, not "just while
I test it."

The app has a login, but the login is the *second* line of defence. Behind it
sits the team's entire sponsor list, the contact history, and a button that
sends mail from a real Gmail account. A publicly reachable instance means
anyone who finds it can sign themselves up at `/signup` and start mailing
sponsors under your team's name, from your team's mailbox.

The router is the first line of defence and it is a good one. §9 is how to
reach the app from outside the house without giving that up.

Sign-up is admin-approved, so a stranger who finds the app can file a request
and wait — they cannot read the sponsor list or send anything. That is the gate
that matters, and it is on by default. The router is the layer in front of it,
and the reason a stranger never gets to try.

If you decide anyway to expose it — through Render, a tunnel, or a forwarded
port — also set `SIGNUP_CODE` in `.env` to a shared phrase. Approval already
stops them getting in; the code keeps the requests page from filling with noise,
and covers the one thing approval cannot: the window before anyone has claimed
the **first** admin account, which is created without approval because there is
nobody to approve it.

---

## 5. Home network

### Give the Pi a fixed address

Its IP is handed out by the router and can change after a reboot, which turns
the bookmark you gave twelve students into a dead link.

1. On the Pi: `ip -4 addr show` and `ip link show` — note the IP and the MAC
   address of the interface you are using.
2. In the router admin page (usually `http://192.168.1.1`), find **DHCP
   reservation**, **static lease**, or **address reservation**, depending on the
   brand. Bind that MAC to that IP.
3. Reboot the Pi and confirm the address did not move.

### The name to hand out

`http://chembot.local:3000` works from macOS, iOS, and most Linux and Windows
laptops without any setup — that is mDNS, and it follows the Pi even if the IP
does change. Some Android versions and some corporate laptops do not do mDNS,
so give people both:

```
http://chembot.local:3000        preferred
http://192.168.1.50:3000         if the first one does not resolve
```

### Check the firewall is doing its job

`setup.sh` opens port 3000 to your subnet only. Verify from outside it —
take a phone **off** the Wi-Fi, onto mobile data, and try your public IP
(`curl -s ifconfig.me` on the Pi tells you what it is):

```
http://<your-public-ip>:3000
```

That must time out. If a login page appears, a port forward or UPnP rule exists
on the router — find it and delete it. While you are in there, turn UPnP off;
it exists to let devices open ports without asking you.

### Things that will surprise you

- **Guest networks and IoT VLANs** isolate clients from each other. A laptop on
  "MyWifi-Guest" cannot see a Pi on "MyWifi", by design.
- **School and office Wi-Fi** usually has client isolation on for the same
  reason. Use §9 there, not the LAN address.
- **A mesh system with separate SSIDs per band** is usually still one subnet —
  but check, because some treat the 2.4GHz band as a separate network.

---

## 6. Connecting Gmail

This is the one fiddly part, and the fiddliness is Google's: it refuses an
OAuth redirect to a private IP over plain `http`. `http://192.168.1.50:3000/...`
is not a redirect URI it will accept. `http://localhost:3000/...` is.

So do the one-time authorisation through an SSH tunnel that makes the Pi look
like `localhost` to your own browser.

**In the Google Cloud console** (*Google Auth Platform → Clients*), create a
client of type **Web application**, and give it exactly this redirect URI:

```
http://localhost:3000/oauth/callback
```

Put the client ID and secret into `.env` on the Pi (or re-run `setup.sh`, which
asks for anything still blank). Then, **from your laptop**:

```bash
ssh -L 3000:localhost:3000 pi@chembot.local
```

Leave that terminal open, and in that laptop's browser visit:

```
http://localhost:3000/oauth/start
```

Grant access. The refresh token is written to `/var/lib/chembot` on the Pi and
reused from then on — you do this once, and again only if you revoke it. Close
the tunnel afterwards; the app keeps working for everyone on the LAN.

> The OAuth scope requested is `gmail.send` only. This cannot read the mailbox.

### Then send one real message to yourself

Two steps, because `test:self` on its own only renders the message — which is
the right first look:

```bash
cd ~/CHEmailBot
# 1. read it without sending anything
docker compose -f deploy/pi/compose.yml exec chemailbot bun run test:self

# 2. actually transmit it, once, leaving the app in dry-run for everything else
docker compose -f deploy/pi/compose.yml exec -e DRY_RUN=0 chemailbot \
  bun run test:self --send
```

It goes to `TEST_EMAIL`, which should be on a **different provider** than the
sending account — same-domain mail routes internally and tells you nothing
about how SPF, DKIM, and spam filtering will treat you. Read what arrives,
footer included, before going further.

### Going live

`DRY_RUN=1` renders and logs messages without transmitting them, and that is
what the app itself is still doing — the `-e DRY_RUN=0` above applied to that
one command only. When the test message looks right:

```bash
nano ~/CHEmailBot/.env                                    # DRY_RUN=0
docker compose -f deploy/pi/compose.yml up -d             # picks up .env
```

---

## 7. Getting the team on it

Send them the URL. Each person asks for an account at `/signup`, and **you
accept it** at `/requests` before they can sign in — so nobody gets in just by
knowing the address, and the name on every sponsor email is one you looked at.

The approval page shows what the decision is actually about: the signature a
sponsor will read on that person's emails, rendered the way a real send renders
it. Approve, or decline to free the username. While anyone is waiting, the nav
carries a count, so you are not expected to remember to check.

The first account is the admin; admins can reset passwords, deactivate accounts,
and hand out admin from `/accounts`. A request is always a student — the role is
granted, never chosen. Accounts with sends logged against them can be
deactivated but never deleted, so the history stays readable.

**One thing stays on a laptop:** `bun run form:assist <id>` drives a *visible*
browser for sponsors that only have a contact form. A headless Pi has no screen
to show it, so run that one on a real computer, against a clone of the repo.

---

## 8. Day to day

Every command below assumes `cd ~/CHEmailBot` first.

```bash
docker compose -f deploy/pi/compose.yml logs -f      # watch it
docker compose -f deploy/pi/compose.yml restart      # after editing .env
docker compose -f deploy/pi/compose.yml ps           # is it healthy?
git pull && docker compose -f deploy/pi/compose.yml up -d --build   # update
```

### Backups

`setup.sh` adds a cron job at 03:17 that snapshots the database into
`/var/lib/chembot/backups` and prunes past 30 days. Snapshots use SQLite's
`VACUUM INTO`, which is consistent even mid-write — unlike `cp`, which can
catch the file between a write and its checkpoint.

Take one by hand before anything risky:

```bash
docker compose -f deploy/pi/compose.yml exec chemailbot bun run backup
```

**Copy them off the Pi.** A backup on the same SD card as the database is not a
backup. From your laptop, once a week or after a big scrape:

```bash
rsync -av pi@chembot.local:/var/lib/chembot/backups/ ~/chembot-backups/
```

To restore, stop the container, copy a snapshot over `chembot.db` (and delete
any `chembot.db-wal` beside it), then start it again.

---

## 9. Reaching it from outside the house

You will want this — a sponsor call on a Saturday, a student working from home.
The answer is a private network, not a port forward.

**[Tailscale](https://tailscale.com)** is free for personal use and takes about
five minutes. On the Pi:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Install the app on each laptop and phone, sign in to the same tailnet, and
`http://chembot:3000` works from anywhere — no ports opened, nothing reachable
by anyone not in the tailnet. Add the firewall rule so Tailscale's interface is
allowed as well:

```bash
sudo ufw allow in on tailscale0 to any port 3000 proto tcp
```

An SSH tunnel (§6) is the zero-install alternative for a one-off:

```bash
ssh -L 3000:localhost:3000 pi@<pi-address>   # then http://localhost:3000
```

`tailscale serve` can also put a real HTTPS certificate in front of this. It is
not required — the tailnet is already private — and if you do turn it on, the
Gmail redirect URI stays `http://localhost:3000/oauth/callback`, because that
authorisation only ever happens once, through the tunnel.

---

## 10. When something is wrong

**`setup.sh` says the OS is 32-bit.** Reflash with Raspberry Pi OS (64-bit).
`uname -m` must print `aarch64`.

**The build fails or the Pi freezes while building.** It ran out of memory.
Add swap and try again:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

**The build fails inside the Bun image.** The Dockerfile uses
`oven/bun:1-alpine`. If musl misbehaves on your Pi, change both `FROM` lines to
`oven/bun:1` (Debian-based, larger, slower to pull, more forgiving) and rebuild.

**A laptop cannot reach it.** In order: is the Pi up (`ping chembot.local`); is
the container healthy (`docker compose -f deploy/pi/compose.yml ps`); is the
laptop on the *same* network and not the guest SSID; does the IP still match
what the router hands out.

**Every form says "Forbidden".** That is the CSRF origin check, and it means
you reached the app under a name it did not expect. Use one address
consistently — `chembot.local` *or* the IP, not a mix.

**Sending refuses with "missing sender identity".** `SENDER_NAME` or
`SENDER_POSTAL_ADDRESS` is blank in `.env`. Both are CAN-SPAM requirements and
the app will not send without them.

**Gmail says `redirect_uri_mismatch`.** The URI on the OAuth client must be
`http://localhost:3000/oauth/callback`, character for character, and the browser
must be going through the SSH tunnel — not to the Pi's IP.

**The container keeps restarting.** `docker compose -f deploy/pi/compose.yml
logs --tail 50`. A corrupt `.env` line is the usual cause.

---

## 11. Worth doing eventually

```bash
sudo apt install -y unattended-upgrades          # security patches, unattended
sudo raspi-config                                # expand filesystem, set locale
```

Put the Pi on a UPS if there is one going. And once a term, check that the
backups in `~/chembot-backups/` on someone's laptop are actually recent —
untested backups have a way of not existing.
