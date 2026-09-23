#!/usr/bin/env bash
#
# One-shot setup for CHEmailBot on a Raspberry Pi. Safe to re-run: every step
# checks whether it has already been done, and nothing here overwrites a value
# you have already put in .env.
#
#   git clone <repo> ~/CHEmailBot
#   ~/CHEmailBot/deploy/pi/setup.sh
#
# What it does: installs Docker, collects the secrets into .env, moves the data
# directory out of the repo, admits the LAN (and only the LAN) through the
# firewall, starts the container, and schedules a nightly backup.
#
# What it deliberately does NOT do: open anything to the internet. See
# deploy/pi/README.md for how to reach it from outside the house safely.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO/deploy/pi/compose.yml"
ENV_FILE="$REPO/.env"
DATA_DIR="/var/lib/chembot"
PORT=3000

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
warn()  { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()   { printf '\033[31m\nStopped: %s\033[0m\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- 0. preflight -----------------------------------------------------------

step "Checking this machine"

[[ $EUID -ne 0 ]] || die "Run this as your normal user, not with sudo.
       It needs to know which account to add to the docker group, and root is
       the wrong answer. It will ask for sudo where it actually needs it."

case "$(uname -m)" in
  aarch64|arm64) info "64-bit ARM: good." ;;
  armv7l|armv6l) die "This is a 32-bit OS. Bun has no 32-bit ARM build, so the
       container cannot run. Reflash with the 64-bit Raspberry Pi OS (Pi 4, Pi 5
       or Pi Zero 2 W) and start again." ;;
  x86_64) info "x86_64 -- not a Pi, but everything here still applies." ;;
  *) die "Unrecognised architecture $(uname -m)." ;;
esac

MEM_MB=$(( $(getconf _PHYS_PAGES) * $(getconf PAGE_SIZE) / 1024 / 1024 ))
(( MEM_MB >= 900 )) || warn "Only ${MEM_MB}MB RAM. The build may need swap."
command -v sudo >/dev/null || die "sudo is not installed."
command -v curl >/dev/null || die "curl is not installed: sudo apt install curl"
[[ -t 0 ]] || die "This asks questions, so run it from a terminal rather than a pipe."
[[ -f "$REPO/package.json" ]] || die "Cannot find the repo from $REPO."
info "Repo: $REPO"

# --- 1. docker --------------------------------------------------------------

step "Docker"

if command -v docker >/dev/null 2>&1; then
  info "Already installed: $(docker --version)"
else
  info "Installing from get.docker.com (a few minutes on a Pi)..."
  curl -fsSL https://get.docker.com | sudo sh
fi

docker compose version >/dev/null 2>&1 || {
  info "Installing the compose plugin..."
  sudo apt-get update -qq && sudo apt-get install -y docker-compose-plugin
}

if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  NEEDS_RELOGIN=1
  info "Added $USER to the docker group."
fi

# The group above does not apply to the shell already running this script, so
# fall back to sudo for the rest of the run rather than failing at the build.
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi

sudo systemctl enable --now docker >/dev/null 2>&1 || true
info "Docker starts on boot."

# --- 2. .env ----------------------------------------------------------------

step "Settings and secrets"

[[ -f "$ENV_FILE" ]] || { cp "$REPO/.env.example" "$ENV_FILE"; info "Created .env from .env.example"; }
chmod 600 "$ENV_FILE"

# Reads one key out of .env, ignoring comments.
get_env() { sed -n "s/^${1}=//p" "$ENV_FILE" | tail -1; }

# Sets a key in place, appending it if it is not there. Values are written
# raw, so anything with a '#' or a newline in it would need quoting by hand.
set_env() {
  local key="$1" value="$2" line found=0 tmp
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "${key}="* ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"; found=1
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$ENV_FILE"
  (( found )) || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"          # redirect, not mv: keeps the 600 mode
  rm -f "$tmp"
}

# Asks only for what is still blank, so re-running this is not an interrogation.
ask() {
  local key="$1" prompt="$2" secret="${3:-}" current answer
  current="$(get_env "$key")"
  if [[ -n "$current" ]]; then
    info "$key is already set -- leaving it alone."
    return
  fi
  if [[ -n "$secret" ]]; then
    read -rsp "  $prompt: " answer; echo
  else
    read -rp "  $prompt: " answer
  fi
  if [[ -n "$answer" ]]; then set_env "$key" "$answer"; fi
}

bold "Who the emails come from (CAN-SPAM requires all three; sending refuses without them)"
ask SENDER_NAME          "Name that signs the emails (e.g. Max McCormick)"
ask SENDER_ORG           "Organisation (e.g. Critical Hit Robotics)"
ask SENDER_POSTAL_ADDRESS "Real postal address, one line"

echo
bold "Gmail OAuth client (Google Cloud console > Google Auth Platform > Clients)"
info "Create a Web application client if you have not. The redirect URI to add"
info "is printed at the end of this script -- it is NOT this machine's IP."
ask GMAIL_CLIENT_ID     "GMAIL_CLIENT_ID"
ask GMAIL_CLIENT_SECRET "GMAIL_CLIENT_SECRET" secret
ask GMAIL_SENDER        "The Gmail address mail will leave from"
ask TEST_EMAIL          "Your own address on a DIFFERENT provider (for the send self-test)"

# Fixed by the deployment rather than asked about.
set_env HOST 0.0.0.0
set_env PORT "$PORT"
# Google will not accept a redirect URI on a private IP over plain http, so the
# OAuth round trip is done through an SSH tunnel to localhost instead. See the
# closing notes and README.md#connecting-gmail.
set_env GMAIL_REDIRECT_URI "http://localhost:${PORT}/oauth/callback"

if [[ "$(get_env DRY_RUN)" != "0" ]]; then
  set_env DRY_RUN 1
  info "DRY_RUN=1 -- messages are rendered and logged, never transmitted."
fi

# On a LAN this stays blank and anyone on the network can sign themselves up,
# which is the intended model. It only matters if the app is ever exposed.
if [[ -z "$(get_env SIGNUP_CODE)" ]]; then
  set_env SIGNUP_CODE ""
  info "SIGNUP_CODE is blank: anyone on the LAN can ASK for an account."
  info "They still cannot sign in until an admin approves it at /requests."
fi

# --- 3. data directory ------------------------------------------------------

step "Data directory"

sudo mkdir -p "$DATA_DIR"
sudo chown "$USER":"$USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
info "$DATA_DIR (outside the repo, so a git pull cannot touch it)"

if [[ -f "$REPO/data/chembot.db" && ! -f "$DATA_DIR/chembot.db" ]]; then
  read -rp "  Found an existing database in the repo. Copy it in? [Y/n] " reply
  if [[ ! "$reply" =~ ^[Nn] ]]; then
    cp "$REPO/data/chembot.db" "$DATA_DIR/chembot.db"
    if [[ -f "$REPO/data/.gmail-token.json" ]]; then
      cp "$REPO/data/.gmail-token.json" "$DATA_DIR/"
    fi
    info "Copied. The original is untouched."
  fi
fi

# --- 4. firewall ------------------------------------------------------------

step "Firewall"

if ! command -v ufw >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y ufw
fi

IFACE="$(ip -4 route show default | awk '{print $5; exit}')"
LAN_IP="$(ip -4 -o addr show dev "$IFACE" | awk '{print $4; exit}' | cut -d/ -f1)"
# The kernel's own route for the interface IS the subnet -- no netmask maths.
SUBNET="$(ip -4 route show dev "$IFACE" proto kernel scope link | awk '{print $1; exit}')"
[[ -n "$SUBNET" ]] || die "Could not work out this network's subnet from interface $IFACE."
info "Interface $IFACE, address $LAN_IP, subnet $SUBNET"

# Order matters: allow SSH BEFORE enabling, or this script locks you out of the
# machine it is running on.
sudo ufw allow OpenSSH >/dev/null 2>&1 || sudo ufw allow 22/tcp >/dev/null
sudo ufw allow from "$SUBNET" to any port "$PORT" proto tcp comment 'CHEmailBot (LAN only)' >/dev/null
sudo ufw --force enable >/dev/null
info "Port $PORT is open to $SUBNET and to nothing else."

# Docker publishes ports by writing its own iptables rules, which sit in front
# of ufw's -- the allow rule above is the intent, this is the enforcement.
if ! grep -q '^DOCKER_OPTS\|^{' /etc/docker/daemon.json 2>/dev/null; then
  warn "Docker's published ports bypass ufw on some setups. Verify from a"
  warn "phone on mobile data that http://$LAN_IP:$PORT does NOT answer."
fi

# --- 5. build and start -----------------------------------------------------

step "Building and starting (first build takes a few minutes)"

"${DOCKER[@]}" compose -f "$COMPOSE_FILE" up -d --build

printf '  waiting for it to answer'
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/login" >/dev/null 2>&1; then
    printf ' ok\n'; UP=1; break
  fi
  printf '.'; sleep 2
done
[[ "${UP:-}" == 1 ]] || {
  printf '\n'
  warn "It did not answer in 60s. Logs:"
  "${DOCKER[@]}" compose -f "$COMPOSE_FILE" logs --tail 40
  die "Start the container by hand once you have fixed the above."
}

# --- 6. nightly backup ------------------------------------------------------

step "Nightly backup"

BACKUP_CMD="$(command -v docker) compose -f $COMPOSE_FILE exec -T chemailbot sh -c 'bun run backup && find /app/data/backups -name \"*.db\" -mtime +30 -delete' >/dev/null 2>&1"
CRON_LINE="17 3 * * * $BACKUP_CMD"

if crontab -l 2>/dev/null | grep -qi 'chemailbot\|chembot'; then
  info "A backup job is already in your crontab."
else
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
  info "03:17 nightly, into $DATA_DIR/backups, keeping 30 days."
fi

# --- done -------------------------------------------------------------------

HOSTN="$(hostname)"
cat <<EOF

$(bold "Running.")

  On the LAN          http://$LAN_IP:$PORT
                      http://$HOSTN.local:$PORT   (if the laptop speaks mDNS)

  The first person to open it creates the admin account. Everyone else asks
  for one at /signup, and an admin accepts it at /requests -- nobody gets in
  just by knowing the address.

$(bold "Connecting Gmail -- do this from your laptop, not the Pi")

  Google refuses a redirect URI on a private IP over plain http, so run the
  OAuth round trip through a tunnel that makes the Pi look like localhost:

      ssh -L $PORT:localhost:$PORT $USER@$LAN_IP

  Leave that open, and in the same laptop's browser go to

      http://localhost:$PORT/oauth/start

  In the Google console, the Web application client needs exactly this
  redirect URI -- no IP address, no hostname:

      http://localhost:$PORT/oauth/callback

  The refresh token lands in $DATA_DIR and is reused from then on. You only
  ever do this once, and again if you revoke it.

$(bold "Then")

  1.  Read one rendered message, then send exactly one to yourself:

          cd $REPO
          docker compose -f deploy/pi/compose.yml exec chemailbot bun run test:self
          docker compose -f deploy/pi/compose.yml exec -e DRY_RUN=0 chemailbot \\
            bun run test:self --send

      The second goes to TEST_EMAIL for real; the app stays in dry-run.
  2.  Set DRY_RUN=0 in .env and restart, when you are ready to actually send.
  3.  Read deploy/pi/README.md for the router, remote access, and what NOT to
      open up.

  Day to day, from $REPO:

  Logs      docker compose -f deploy/pi/compose.yml logs -f
  Restart   docker compose -f deploy/pi/compose.yml restart
  Update    git pull && docker compose -f deploy/pi/compose.yml up -d --build

EOF

if [[ -n "${NEEDS_RELOGIN:-}" ]]; then
  warn "Log out and back in before running docker without sudo."
fi
exit 0
