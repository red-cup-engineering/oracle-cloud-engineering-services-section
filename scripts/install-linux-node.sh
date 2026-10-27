#!/bin/sh
# Make a Linux server a fleet worker node. Idempotent: run it again after an update.
#
#   install-linux-node.sh --failure-domain oracle-free-tier --power mains --network always-on
#
# Runs as root, from cloud-init on a new VM or by hand. Needs a provisioning file the operator supplies
# (default /etc/node-fleet/provision.env, mode 600):
#   NODE_JOB_NODE_ID=oracle-free-1                  lowercase letters, digits, hyphens; the node's fleet id
#   NODE_JOB_STORE_URL=https://example/fleet.git    the fleet store (its fleet-facts branch)
#   NODE_JOB_STORE_USER=... NODE_JOB_STORE_TOKEN=... (optional) git credentials for the store
# This script holds no credential and refuses to run without that file. It installs Node from the distro,
# the pinned package from the house registry, and a `fleet` user whose systemd user manager runs the fleet
# monitor (node-job-fleet-join installs it). The monitor publishes this node's offer when it changes: events,
# not a timer. The node's cores and memory are read from the machine by the package, so the offer states
# the real capacity; the failure domain, power and network facts are the arguments above.
set -eu

PACKAGE="@red-cup-engineering/node-job-service"
VERSION="0.5.0"
REGISTRY="https://registry.561.group"
MIN_NODE_MAJOR=20

FLEET_USER="${NODE_FLEET_USER:-fleet}"
PROVISION="${NODE_FLEET_PROVISION:-/etc/node-fleet/provision.env}"

die() { printf 'install-linux-node: %s\n' "$*" >&2; exit 1; }
say() { printf 'install-linux-node: %s\n' "$*"; }
fact_ok() { case "$2" in ''|-*|*[!a-z0-9-]*) die "$1 must be lowercase letters, digits and hyphens" ;; esac; }

FAILURE_DOMAIN=""; POWER=""; NETWORK=""; STAGE="root"
while [ $# -gt 0 ]; do
  case "$1" in
    --failure-domain) FAILURE_DOMAIN="${2:-}"; shift 2 ;;
    --power) POWER="${2:-}"; shift 2 ;;
    --network) NETWORK="${2:-}"; shift 2 ;;
    --as-fleet-user) STAGE="user"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
fact_ok --failure-domain "$FAILURE_DOMAIN"
fact_ok --power "$POWER"
fact_ok --network "$NETWORK"

# The fleet user cannot read root's copy; it reads its own, which the root half installs.
[ "$STAGE" = "user" ] && PROVISION="$HOME/.node-fleet/provision.env"
[ -f "$PROVISION" ] || die "no provisioning file at $PROVISION. Copy the file the operator made for this node there, then run this again."
value_of() { sed -n "s/^$1=//p" "$PROVISION" | head -n 1; }
NODE_ID=$(value_of NODE_JOB_NODE_ID)
STORE_URL=$(value_of NODE_JOB_STORE_URL)
fact_ok NODE_JOB_NODE_ID "$NODE_ID"
case "$STORE_URL" in https://*@*|https://*:*@*) die "NODE_JOB_STORE_URL in $PROVISION must not contain credentials" ;; https://*) ;; *) die "NODE_JOB_STORE_URL in $PROVISION must be an https git URL" ;; esac

# --- The fleet user's half: package, store clone, fleet join. Reached only through the root half below. ---
if [ "$STAGE" = "user" ]; then
  ROOT="$HOME/.node-fleet"
  LIB="$ROOT/lib"
  PACKAGE_DIR="$LIB/node_modules/$PACKAGE"
  BIN="$ROOT/bin"
  mkdir -p "$ROOT" "$BIN"
  chmod 700 "$ROOT"

  installed=$(node -p "try{require('$PACKAGE_DIR/package.json').version}catch(e){''}" 2>/dev/null || true)
  if [ "$installed" != "$VERSION" ]; then
    mkdir -p "$LIB"
    npm install --prefix "$LIB" --registry "$REGISTRY" --omit=dev --ignore-scripts --no-audit --no-fund --no-save --no-package-lock --cache "$ROOT/.npm-cache" "$PACKAGE@$VERSION"
    rm -rf "$ROOT/.npm-cache"
  fi

  # git asks this helper for the store credential; it answers from the provisioning file, so no second copy exists.
  cat > "$BIN/git-askpass.sh.part" <<ASKPASS
#!/bin/sh
case "\$1" in
  *sername*) user=\$(sed -n 's/^NODE_JOB_STORE_USER=//p' "$ROOT/provision.env" | head -n 1); printf '%s\n' "\${user:-git}" ;;
  *) sed -n 's/^NODE_JOB_STORE_TOKEN=//p' "$ROOT/provision.env" | head -n 1 ;;
esac
ASKPASS
  chmod 700 "$BIN/git-askpass.sh.part"
  mv "$BIN/git-askpass.sh.part" "$BIN/git-askpass.sh"

  if [ ! -d "$ROOT/fleet/.git" ]; then
    GIT_ASKPASS="$BIN/git-askpass.sh" GIT_TERMINAL_PROMPT=0 git clone --quiet --branch fleet-facts --single-branch "$STORE_URL" "$ROOT/fleet"
  fi
  git -C "$ROOT/fleet" remote set-url origin "$STORE_URL"
  git -C "$ROOT/fleet" config user.name "$NODE_ID"
  git -C "$ROOT/fleet" config user.email "$NODE_ID@fleet.invalid"
  git -C "$ROOT/fleet" config core.askPass "$BIN/git-askpass.sh"

  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; *) ARCH=$(uname -m) ;; esac
  node "$PACKAGE_DIR/scripts/install-fleet-sync.mjs" --store "$STORE_URL" --clone "$ROOT/fleet" --id "$NODE_ID" \
    --capability "failure-domain:$FAILURE_DOMAIN" --capability "power:$POWER" --capability "network:$NETWORK" --capability "arch:$ARCH"
  exit 0
fi

# --- The root half: tools, the fleet user, its systemd user manager. ---
[ "$(id -u)" -eq 0 ] || die "run as root (the fleet user's half is run for you)"

missing=""
for pair in node:nodejs npm:npm git:git flock:util-linux; do
  command -v "${pair%%:*}" >/dev/null 2>&1 || missing="$missing ${pair#*:}"
done
if [ -n "$missing" ]; then
  if command -v dnf >/dev/null 2>&1; then
    # Oracle Linux 8/9 ship Node as a module stream; later releases have no modules and install it directly.
    if dnf module list nodejs >/dev/null 2>&1; then dnf -y module enable nodejs:22; fi
    # shellcheck disable=SC2086
    dnf -y install $missing
  elif command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q
    # shellcheck disable=SC2086
    apt-get install -y -q $missing
  else
    die "missing:$missing, and neither dnf nor apt-get is available"
  fi
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ] || die "the distro's Node is $NODE_MAJOR; node-job-service needs $MIN_NODE_MAJOR or newer. Use a distro release that ships it."

id "$FLEET_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$FLEET_USER"
FLEET_UID=$(id -u "$FLEET_USER")
FLEET_HOME=$(getent passwd "$FLEET_USER" | cut -d: -f6)

# The fleet user's systemd user manager runs from boot, without a login. Starting its unit waits until it is up.
loginctl enable-linger "$FLEET_USER"
systemctl start "user@$FLEET_UID.service"

install -d -m 700 -o "$FLEET_USER" -g "$FLEET_USER" "$FLEET_HOME/.node-fleet"
install -m 600 -o "$FLEET_USER" -g "$FLEET_USER" "$PROVISION" "$FLEET_HOME/.node-fleet/provision.env"

SELF=$(readlink -f "$0")
runuser -u "$FLEET_USER" -- env HOME="$FLEET_HOME" XDG_RUNTIME_DIR="/run/user/$FLEET_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$FLEET_UID/bus" \
  "$SELF" --as-fleet-user --failure-domain "$FAILURE_DOMAIN" --power "$POWER" --network "$NETWORK"

say "$NODE_ID joined the fleet from failure domain $FAILURE_DOMAIN (node-job-service $VERSION): $(nproc) cores, $(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo) GB memory."
say "Check it with: runuser -u $FLEET_USER -- env XDG_RUNTIME_DIR=/run/user/$FLEET_UID systemctl --user status node-fleet-monitor"
