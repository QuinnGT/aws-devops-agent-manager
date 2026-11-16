#!/usr/bin/env bash
# Start, stop and inspect DevOps Agent Manager in containers (Podman, or Docker).
#   ./scripts/stack.sh help
# Runs on macOS and Linux, and on Windows inside WSL2. Written for bash 3.2 (the macOS default).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
DAM_IMAGE_DEFAULT="localhost/devops-agent-manager:dev" # the name both compose files use when DAM_IMAGE is not set
# Podman prints a notice every time it hands `compose` to an external provider.
export PODMAN_COMPOSE_WARNING_LOGS=false

REAL_PROJECT="devops-agent-manager"
REAL_FILE="compose.yaml"
DEMO_PROJECT="dam-demo"
DEMO_FILE="compose.demo.yaml"

# An empty folder in the repository. It stands in for ~/.aws and for the policy overlay when there is none.
EMPTY_DIR="$ROOT/scripts/empty"
# The image build needs this much memory in the container engine (measured: a 1.7 GB limit was killed, 3.5 GB worked).
MIN_BUILD_MEMORY_BYTES=3758096384

# shellcheck source=scripts/aws-bridge.sh
. "$ROOT/scripts/aws-bridge.sh"
BRIDGE_PROJECT=$REAL_PROJECT

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

say() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: ./scripts/stack.sh <command> [options]

Commands:
  demo [--reset]     Start the demo with the sample data. No AWS account needed.
                     Open http://127.0.0.1:${DAM_DEMO_PORT:-3001}, signed in as Alex Rivera.
                     Seeds on the first start. --reset removes the demo's data and seeds it again.
  up [options]       Start the app against your own Agent Space on http://127.0.0.1:${DAM_PORT:-3000}.
                     Options:
                       --profile <name>       The AWS profile to use (or set AWS_PROFILE). Any profile
                                              type works: access keys, a role, IAM Identity Center
                                              (SSO), credential_process, an Okta tool's keys.
                       --policy <folder>      Merge the policy files in <folder> over the defaults.
                                              The choice is saved in .env. '--policy none' removes it.
                       --mount-aws-dir        Skip the credential bridge and mount ~/.aws read-only.
                                              Used by itself when the AWS CLI is not installed. Does
                                              not work for SSO or credential_process profiles.
                       --export-credentials   Does nothing. Credentials are renewed automatically.
                     With the AWS CLI (2.9.6 or later) installed, up signs you in if needed, passes
                     short-lived credentials to the containers and keeps them renewed in the
                     background, for as long as your AWS sign-in lasts.
  login [--profile <name>]
                     Sign in to AWS again (aws sso login, or DAM_AWS_LOGIN_COMMAND) and renew the
                     credentials in the containers now. Run it when status says the sign-in ended.
  down [--demo] [--volumes]
                     Stop and remove the containers, and stop the credential refresher. --volumes
                     also deletes the database and the history repositories (cannot be undone).
                     --demo selects the demo.
  logs [--demo] [-f] [service]
                     Show the last 200 log lines; -f follows. Services: web, worker, postgres
                     (and seed for the demo).
  status             Show both stacks and the AWS credential bridge.
  help               Show this text.

Environment:
  DAM_PORT, DAM_DEMO_PORT   Host ports (defaults 3000 and 3001). Always published on 127.0.0.1 only.
  DAM_IMAGE                 A published image such as ghcr.io/<owner>/devops-agent-manager:<tag>.
                            It is pulled and nothing is built. Unset, the image is built from this folder.
  DAM_CONTAINER_CLI         podman or docker. Default: podman if installed, else docker.
  DAM_AWS_LOGIN_COMMAND     A command that signs you in, for example 'okta-aws-cli web --profile <name>'.
                            Run by up and login instead of 'aws sso login'. $AWS_PROFILE holds the profile.
  DAM_SKIP_MEMORY_CHECK     Set to 1 to skip the check that the container engine has enough memory to build.
  DAM_AWS_DIR               Folder mounted as ~/.aws with --mount-aws-dir (default ~/.aws).
EOF
}

# ---------------------------------------------------------------- container engine

CLI=""

pick_cli() {
  if [ -n "${DAM_CONTAINER_CLI:-}" ]; then
    case "$DAM_CONTAINER_CLI" in
      podman | docker) CLI="$DAM_CONTAINER_CLI" ;;
      *) die "DAM_CONTAINER_CLI must be podman or docker, not '$DAM_CONTAINER_CLI'." ;;
    esac
    command -v "$CLI" >/dev/null 2>&1 || die "DAM_CONTAINER_CLI=$CLI, but $CLI is not installed."
  elif command -v podman >/dev/null 2>&1; then
    CLI=podman
  elif command -v docker >/dev/null 2>&1; then
    CLI=docker
  else
    die "Neither podman nor docker is installed. Install Podman (https://podman.io/docs/installation) and run this again."
  fi
  BRIDGE_CLI=$CLI
}

check_engine() {
  command -v curl >/dev/null 2>&1 || die "curl is not installed. This script uses it to check that the app answers."
  if ! "$CLI" info >/dev/null 2>&1; then
    if [ "$CLI" = podman ]; then
      die "Podman is installed but not answering. On macOS and Windows, start its virtual machine with 'podman machine start' (the first time: 'podman machine init' and then 'podman machine start'), then run this again."
    fi
    die "Docker is installed but not answering. Start Docker Desktop (or the docker service) yourself, then run this again. This script never starts it."
  fi
  "$CLI" compose version >/dev/null 2>&1 || die "'$CLI compose' is not available. Install the Docker Compose plugin or docker-compose (https://docs.docker.com/compose/install/)."
}

# compose <demo|real> <compose arguments...>
compose() {
  local which=$1 project file
  shift
  if [ "$which" = demo ]; then
    project=$DEMO_PROJECT
    file=$DEMO_FILE
  else
    project=$REAL_PROJECT
    file=$REAL_FILE
  fi
  "$CLI" compose --project-directory "$ROOT" -p "$project" -f "$ROOT/$file" "$@"
}

# True on Windows Subsystem for Linux.
in_wsl() {
  [ -r /proc/version ] && grep -qi microsoft /proc/version
}

# The image build runs `next build`, which the kernel kills (exit 137) when the engine has too little memory.
# A new Podman machine has 2 GB. Stops with the fix instead of letting the build fail after minutes.
MEMORY_CHECKED=no
check_build_memory() {
  local bytes="" tenths
  [ -z "${DAM_IMAGE:-}" ] || return 0 # a named image is pulled or used as it is: nothing is built
  [ "${DAM_SKIP_MEMORY_CHECK:-}" = 1 ] && return 0
  [ "$MEMORY_CHECKED" = no ] || return 0
  MEMORY_CHECKED=yes
  if [ "$CLI" = podman ]; then
    bytes="$(podman info --format '{{.Host.MemTotal}}' 2>/dev/null || true)"
  else
    bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"
  fi
  case "$bytes" in
    '' | *[!0-9]*) return 0 ;; # the engine did not say; do not block on a guess
  esac
  [ "$bytes" -ge "$MIN_BUILD_MEMORY_BYTES" ] && return 0
  tenths=$((bytes * 10 / 1073741824))
  {
    printf 'Error: the container engine has %s.%s GiB of memory. Building the image needs at least 3.5 GiB;\n' $((tenths / 10)) $((tenths % 10))
    printf 'with less, the build step "next build" is killed (exit 137, "Killed").\n\n'
    if in_wsl; then
      printf 'Raise the memory of the WSL 2 virtual machine. In Windows, put these lines in %%UserProfile%%\\.wslconfig:\n\n'
      printf '  [wsl2]\n  memory=6GB\n\n'
      printf 'then run "wsl --shutdown" in PowerShell and open the Linux shell again.\n'
      printf 'See https://learn.microsoft.com/windows/wsl/wsl-config#configure-global-options-with-wslconfig\n'
    elif [ "$(uname -s)" = Darwin ] && [ "$CLI" = podman ]; then
      printf 'Give the Podman machine 4 GiB or more:\n\n'
      printf '  podman machine stop\n  podman machine set --memory 4096\n  podman machine start\n'
    elif [ "$(uname -s)" = Darwin ]; then
      printf 'In Docker Desktop, open Settings > Resources and raise the memory limit to 4 GB or more, then Apply.\n'
    else
      printf 'Free memory on this computer or add swap, then run this again.\n'
    fi
    printf '\nTo build anyway, set DAM_SKIP_MEMORY_CHECK=1. To skip the build, use a published image (DAM_IMAGE).\n'
  } >&2
  exit 1
}

# ---------------------------------------------------------------- .env and secrets

# True when .env gives NAME a value.
has_secret() {
  [ -f "$ENV_FILE" ] && grep -q "^$1=." "$ENV_FILE"
}

# The value of NAME in .env (the last assignment, single quotes removed), or nothing.
env_file_value() {
  local line
  [ -f "$ENV_FILE" ] || return 0
  line="$(grep "^$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  case "$line" in
    \'*\')
      line="${line#\'}"
      line="${line%\'}"
      ;;
  esac
  printf '%s\n' "$line"
}

# env_file_set NAME VALUE: writes NAME='VALUE' into .env, replacing earlier lines of NAME. VALUE has no single quote.
env_file_set() {
  local tmp
  (
    umask 077
    tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    if [ -f "$ENV_FILE" ]; then
      grep -v "^$1=" "$ENV_FILE" >"$tmp" || true
    else
      printf '# Created by scripts/stack.sh. Not committed. Holds passwords: do not share it.\n' >"$tmp"
    fi
    printf "%s='%s'\n" "$1" "$2" >>"$tmp"
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
  )
}

env_file_unset() {
  local tmp
  [ -f "$ENV_FILE" ] || return 0
  (
    umask 077
    tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    grep -v "^$1=" "$ENV_FILE" >"$tmp" || true
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
  )
}

# 48 hex characters from the system random source.
new_password() {
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

# Add NAME=<random password> to .env unless it is already there. The value is never printed.
# VOLUME is the database volume of the stack: an old one holds a database created with a password
# that .env no longer has, and a new password would be refused by it.
ensure_secret() {
  local name=$1 volume=$2 tmp
  has_secret "$name" && return 0
  if "$CLI" volume inspect "$volume" >/dev/null 2>&1; then
    die "$ENV_FILE has no $name, but the volume $volume already holds a database made with a password. Put the old value back in .env, or delete the volume with './scripts/stack.sh down --volumes' (this deletes its data)."
  fi
  (
    umask 077
    if [ -f "$ENV_FILE" ]; then
      # An empty "NAME=" line, left by copying .env.example, is replaced.
      tmp="$(mktemp "$ENV_FILE.XXXXXX")"
      grep -v "^$name=$" "$ENV_FILE" >"$tmp" || true
      cat "$tmp" >"$ENV_FILE"
      rm -f "$tmp"
    else
      printf '# Created by scripts/stack.sh. Not committed. Holds passwords: do not share it.\n' >"$ENV_FILE"
    fi
    printf '%s=%s\n' "$name" "$(new_password)" >>"$ENV_FILE"
  )
  say "Created a random $name in .env."
}

# Commands that do not start anything (down, logs, status) still make compose read the whole file,
# which fails when a required password is missing. Give it a throwaway value in that case only.
placeholder_secrets() {
  has_secret DAM_POSTGRES_PASSWORD || export DAM_POSTGRES_PASSWORD=not-used-by-this-command
  has_secret DAM_DEMO_POSTGRES_PASSWORD || export DAM_DEMO_POSTGRES_PASSWORD=not-used-by-this-command
}

# ---------------------------------------------------------------- image

prepare_image() {
  local which=$1
  if [ -n "${DAM_IMAGE:-}" ]; then
    case "$DAM_IMAGE" in
      localhost/*)
        "$CLI" image inspect "$DAM_IMAGE" >/dev/null 2>&1 || die "DAM_IMAGE=$DAM_IMAGE is a local name and no such image exists. Build it, or unset DAM_IMAGE to build the default one."
        ;;
      *)
        say "Pulling $DAM_IMAGE ..."
        compose "$which" pull web
        ;;
    esac
  else
    check_build_memory
    say "Building $DAM_IMAGE_DEFAULT from this folder (the first build takes several minutes) ..."
    compose "$which" build web
  fi
}

# ---------------------------------------------------------------- waiting

valid_port() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# A container of this project that exited with an error, as "<name> <status>", or nothing.
failed_container() {
  "$CLI" ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -E 'Exited \([1-9][0-9]*\)' | head -n 1 || true
}

# wait_for_app <demo|real> <project> <url> <seconds>
wait_for_app() {
  local which=$1 project=$2 url=$3 limit=$4 waited=0 code failed
  say "Waiting for $url ..."
  while [ "$waited" -lt "$limit" ]; do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null || true)"
    case "$code" in 2* | 3*) return 0 ;; esac
    failed="$(failed_container "$project")"
    if [ -n "$failed" ]; then
      compose "$which" logs --tail 40 >&2 || true
      die "A container stopped with an error: $failed. The last log lines are above."
    fi
    sleep 3
    waited=$((waited + 3))
  done
  compose "$which" logs --tail 40 >&2 || true
  die "$url did not answer within $limit seconds. The last log lines are above."
}

# ---------------------------------------------------------------- policy overlay

# resolve_policy_overlay <value of --policy, or empty>
# Decides which host folder the containers mount read-only as the policy overlay, and exports it for
# compose. An explicit --policy is saved in .env so that later runs keep it; "none" removes it.
resolve_policy_overlay() {
  local arg=$1 dir="" name found=no
  if [ "$arg" = none ]; then
    env_file_unset DAM_POLICY_OVERLAY_HOST_DIR
    say "Policy overlay removed. The containers use the default policy only."
  elif [ -n "$arg" ]; then
    [ -d "$arg" ] || die "--policy needs a folder, and '$arg' is not one."
    dir="$(cd "$arg" && pwd -P)"
    case "$dir" in
      *"'"* | *$'\n'*) die "The policy folder path '$dir' has a single quote or a line break in it. Move the folder to a path without one." ;;
    esac
    for name in "$ROOT"/policy/*; do
      [ -e "$dir/${name##*/}" ] && found=yes
    done
    [ "$found" = yes ] || warn "$dir has none of the files and folders the app reads (the names in policy/, for example sync.yaml). It will have no effect."
    env_file_set DAM_POLICY_OVERLAY_HOST_DIR "$dir"
    say "Policy overlay: $dir (mounted read-only, saved in .env; remove it with --policy none)."
  else
    dir="${DAM_POLICY_OVERLAY_HOST_DIR:-$(env_file_value DAM_POLICY_OVERLAY_HOST_DIR)}"
    if [ -n "$dir" ]; then
      [ -d "$dir" ] || die "The policy overlay folder $dir (DAM_POLICY_OVERLAY_HOST_DIR) does not exist. Run 'up --policy <folder>' with a folder that does, or 'up --policy none'."
      say "Policy overlay: $dir (from DAM_POLICY_OVERLAY_HOST_DIR; remove it with --policy none)."
    fi
  fi
  if [ -n "$dir" ]; then
    export DAM_POLICY_OVERLAY_HOST_DIR="$dir"
  else
    export DAM_POLICY_OVERLAY_HOST_DIR="$EMPTY_DIR"
  fi
}

# ---------------------------------------------------------------- AWS credentials

login_command() {
  printf '%s\n' "${DAM_AWS_LOGIN_COMMAND:-$(env_file_value DAM_AWS_LOGIN_COMMAND)}"
}

# True when the AWS CLI knows the profile as an IAM Identity Center (SSO) profile.
profile_is_sso() {
  aws configure get sso_session --profile "$1" >/dev/null 2>&1 || aws configure get sso_start_url --profile "$1" >/dev/null 2>&1
}

# sign_in <profile or empty>: runs the sign-in that fits the profile, in the foreground.
# Returns 1 when no sign-in applies, and 2 when the command failed.
sign_in() {
  local profile=$1 cmd
  cmd="$(login_command)"
  if [ -n "$cmd" ]; then
    say "Signing in with DAM_AWS_LOGIN_COMMAND: $cmd"
    if [ -n "$profile" ]; then
      AWS_PROFILE="$profile" bash -c "$cmd" || return 2
    else
      bash -c "$cmd" || return 2
    fi
  elif [ -n "$profile" ] && profile_is_sso "$profile"; then
    say "Profile '$profile' uses IAM Identity Center. Signing in with: aws sso login --profile $profile"
    say "A browser window opens. If it cannot (for example in WSL), the command prints a URL and a code."
    aws sso login --profile "$profile" || return 2
  else
    return 1
  fi
}

# The message for a profile that has no credentials and no sign-in this script can run.
no_sign_in_hint() {
  local profile=$1
  if [ -n "$profile" ]; then
    cat >&2 <<EOF
Profile '$profile' is not an IAM Identity Center profile, and DAM_AWS_LOGIN_COMMAND is not set, so this
script cannot sign you in. Sign in the way you normally do first (for an Okta tool such as okta-aws-cli,
gimme-aws-creds or saml2aws, run it now), then run this command again. To have this script run your tool,
set DAM_AWS_LOGIN_COMMAND, for example:  DAM_AWS_LOGIN_COMMAND='okta-aws-cli web --profile $profile'
EOF
  else
    cat >&2 <<'EOF'

No AWS credentials were found, and no profile is named. Pick one:

  1. Name a profile, and sign in to it the way you normally do:
       ./scripts/stack.sh up --profile <name>        (or AWS_PROFILE=<name> ./scripts/stack.sh up)
  2. Run this in a shell that already has AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY,
     for example from aws-vault). They are passed on once and cannot be renewed, so a named profile is better.

To look around without AWS, use ./scripts/stack.sh demo. Details: docs/getting-started.md
EOF
  fi
}

# True when AWS refuses the credentials the AWS CLI resolves for the profile. One free STS call finds out. Only a
# clear "expired or invalid" answer counts: a network error leaves the question open, and the answer is "not refused".
keys_refused() {
  local out
  if [ -n "$1" ]; then
    out="$(aws sts get-caller-identity --profile "$1" 2>&1)" && return 1
  else
    out="$(aws sts get-caller-identity 2>&1)" && return 1
  fi
  case "$out" in
    *ExpiredToken* | *InvalidClientTokenId* | *"security token included in the request is"*) return 0 ;;
  esac
  return 1
}

# Runs one export, to find out now that the credentials are there. Sets BRIDGE_ERROR and returns 1 when they are not.
credentials_usable() {
  local profile=$1 no_expiry=no
  bridge_export "$profile" || return 1
  [ -n "$BR_EXP_RAW" ] || no_expiry=yes
  bridge_wipe
  # Access keys, and keys that an Okta tool wrote into ~/.aws/credentials, come without an expiry time, so the
  # export succeeds even after they ended. Ask AWS.
  if [ "$no_expiry" = yes ] && keys_refused "$profile"; then
    BRIDGE_ERROR="AWS no longer accepts these credentials: they have expired."
    return 1
  fi
}

# Before anything starts: finds out that the sign-in has ended, and signs in once when it has.
ensure_signed_in() {
  local profile=$1 rc=0
  credentials_usable "$profile" && return 0
  say "The AWS CLI has no usable credentials${profile:+ for profile $profile}: $BRIDGE_ERROR"
  sign_in "$profile" || rc=$?
  case "$rc" in
    0)
      if credentials_usable "$profile"; then
        say "Signed in."
        return 0
      fi
      die "Still no usable credentials after the sign-in: $BRIDGE_ERROR"
      ;;
    1)
      no_sign_in_hint "$profile"
      exit 1
      ;;
    *) die "The sign-in command failed. Fix that, then run this again." ;;
  esac
}

# The profile name for up and login, from the option, else AWS_PROFILE. Refuses names that could break a config file.
checked_profile() {
  local profile=$1
  [ -n "$profile" ] || profile="${AWS_PROFILE:-}"
  if [ -n "$profile" ]; then
    case "$profile" in
      [!A-Za-z0-9]* | *[!A-Za-z0-9_.@:+=,/-]*) die "'$profile' is not a valid AWS profile name." ;;
    esac
  fi
  printf '%s\n' "$profile"
}

# aws_mode_for <mount yes|no> <aws cli state>: bridge or mount, with the reason when it is mount.
choose_aws_mode() {
  local want_mount=$1 cli_state=$2
  if [ "$want_mount" = yes ]; then
    AWS_MODE=mount
  elif [ "$cli_state" = ok ]; then
    AWS_MODE=bridge
  else
    AWS_MODE=mount
    case "$cli_state" in
      missing) warn "The AWS CLI is not installed, so the credentials cannot be renewed automatically. Falling back to mounting ~/.aws read-only. Profiles that use IAM Identity Center (SSO) or credential_process do not work that way. Install AWS CLI 2.9.6 or later: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" ;;
      *) warn "The AWS CLI on this computer is version ${cli_state#old }, and automatic credentials need 2.9.6 or later. Falling back to mounting ~/.aws read-only. Profiles that use IAM Identity Center (SSO) or credential_process do not work that way. Update the AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" ;;
    esac
  fi
}

AWS_MODE=bridge

# Sets what compose needs for the chosen mode. <profile or empty>
prepare_aws_env() {
  local profile=$1
  if [ "$AWS_MODE" = bridge ]; then
    # No ~/.aws in the containers: they read the bridge's config, which has no secret. A profile name in the
    # containers would make the AWS SDK skip other sources, so none is passed; [default] holds the bridge.
    unset AWS_PROFILE
    export DAM_AWS_DIR="$EMPTY_DIR"
    export DAM_CONTAINER_AWS_CONFIG_FILE="$BRIDGE_CONFIG_PATH"
    export DAM_CONTAINER_AWS_CREDENTIALS_FILE="$BRIDGE_CONTAINER_DIR/no-credentials-file"
  else
    [ -n "$profile" ] || die "No AWS profile given. Without the credential bridge the containers can only read a profile from ~/.aws: use --profile <name> (or AWS_PROFILE=<name>)."
    local dir="${DAM_AWS_DIR:-$(env_file_value DAM_AWS_DIR)}"
    dir="${dir:-$HOME/.aws}"
    [ -d "$dir" ] || die "Profile '$profile' needs the folder $dir, which does not exist. Run 'aws configure --profile $profile' first."
    export AWS_PROFILE="$profile"
    unset DAM_CONTAINER_AWS_CONFIG_FILE DAM_CONTAINER_AWS_CREDENTIALS_FILE
    say "Using AWS profile '$profile' from $dir (mounted read-only)."
  fi
}

# After the containers run: write the config, the first credentials, and start the refresher.
start_bridge() {
  local profile=$1
  bridge_stop_refresher
  bridge_state_init
  bridge_state_clear
  bridge_state_set mode bridge
  bridge_state_set profile "$profile"
  if ! bridge_write_config "$profile"; then
    warn "Could not write the AWS config into the containers: $BRIDGE_ERROR"
  fi
  if bridge_renew "$profile"; then
    say "AWS credentials are in the containers. They are renewed every minute while your AWS sign-in lasts."
  else
    warn "Could not pass credentials to the containers: $BRIDGE_ERROR"
    warn "The refresher keeps trying. After you sign in again, run ./scripts/stack.sh login"
  fi
  if bridge_start_refresher "$profile"; then
    say "Credential refresher started (log: .dam/aws-bridge.log)."
  else
    warn "The credential refresher did not start. See .dam/aws-bridge.log."
  fi
}

# ---------------------------------------------------------------- commands

cmd_up() {
  local profile="" mount=no policy="" port cli_state
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile)
        [ $# -ge 2 ] || die "--profile needs a profile name."
        profile=$2
        shift 2
        ;;
      --policy)
        [ $# -ge 2 ] || die "--policy needs a folder, or 'none'."
        policy=$2
        shift 2
        ;;
      --mount-aws-dir)
        mount=yes
        shift
        ;;
      --export-credentials)
        say "--export-credentials is no longer needed: the credentials are now renewed automatically. Continuing without it."
        shift
        ;;
      *) die "Unknown option for 'up': $1 (see './scripts/stack.sh help')." ;;
    esac
  done
  port="${DAM_PORT:-3000}"
  valid_port "$port" || die "DAM_PORT must be a port number, not '$port'."
  profile="$(checked_profile "$profile")"
  cli_state="$(bridge_cli_state)"
  choose_aws_mode "$mount" "$cli_state"
  pick_cli
  check_engine
  resolve_policy_overlay "$policy"
  # Before the sign-in: a build that cannot work should not make you sign in first.
  check_build_memory
  if [ "$AWS_MODE" = bridge ]; then
    ensure_signed_in "$profile"
  fi
  prepare_aws_env "$profile"
  ensure_secret DAM_POSTGRES_PASSWORD "${REAL_PROJECT}_pg-data"
  prepare_image real
  compose real up -d --no-build || {
    compose real logs --tail 40 >&2 || true
    die "The stack did not start. The last log lines are above."
  }
  if [ "$AWS_MODE" = bridge ]; then
    start_bridge "$profile"
  else
    bridge_stop_refresher
    bridge_clear || warn "Could not remove credentials left by an earlier run from the app-data volume."
    bridge_state_clear
    bridge_state_set mode mount
    bridge_state_set profile "$profile"
  fi
  wait_for_app real "$REAL_PROJECT" "http://127.0.0.1:$port/" 180
  say ""
  say "DevOps Agent Manager is running at http://127.0.0.1:$port (this computer only)."
  say "Next: register your Agent Space in the app. Leave its 'AWS profile' field empty${profile:+, or enter $profile}. See docs/getting-started.md."
  if [ "$AWS_MODE" = bridge ]; then
    say "Check the AWS credentials with './scripts/stack.sh status'. If your AWS sign-in ends, run './scripts/stack.sh login'."
  fi
  say "Stop it with './scripts/stack.sh down'."
}

cmd_login() {
  local profile="" rc=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile)
        [ $# -ge 2 ] || die "--profile needs a profile name."
        profile=$2
        shift 2
        ;;
      *) die "Unknown option for 'login': $1 (see './scripts/stack.sh help')." ;;
    esac
  done
  if [ -z "$profile" ]; then profile="$(bridge_state_get profile)"; fi
  profile="$(checked_profile "$profile")"
  [ "$(bridge_cli_state)" = ok ] || die "'login' needs the AWS CLI, version 2.9.6 or later (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)."
  [ "$(bridge_state_get mode)" != mount ] || die "This stack was started with ~/.aws mounted (--mount-aws-dir, or without the AWS CLI). There is no bridge to renew. Run './scripts/stack.sh up --profile <name>' with the AWS CLI installed."
  pick_cli
  check_engine
  bridge_find_container >/dev/null || die "The app containers are not running. Start them with './scripts/stack.sh up --profile <name>'."
  sign_in "$profile" || rc=$?
  case "$rc" in
    0) ;;
    1) say "No sign-in command applies (the profile is not an IAM Identity Center profile, and DAM_AWS_LOGIN_COMMAND is not set). Renewing from what the AWS CLI has now." ;;
    *) die "The sign-in command failed. Fix that, then run this again." ;;
  esac
  bridge_state_set mode bridge
  bridge_state_set profile "$profile"
  bridge_write_config "$profile" || warn "Could not write the AWS config into the containers: $BRIDGE_ERROR"
  bridge_renew "$profile" || {
    no_sign_in_hint "$profile"
    die "The AWS CLI still has no usable credentials: $BRIDGE_ERROR"
  }
  say "Renewed. The containers have new credentials."
  if [ -z "$(bridge_refresher_pid)" ]; then
    if bridge_start_refresher "$profile"; then
      say "Credential refresher started again (log: .dam/aws-bridge.log)."
    else
      warn "The credential refresher did not start. See .dam/aws-bridge.log."
    fi
  fi
}

cmd_demo() {
  local reset=no port
  while [ $# -gt 0 ]; do
    case "$1" in
      --reset)
        reset=yes
        shift
        ;;
      *) die "Unknown option for 'demo': $1 (see './scripts/stack.sh help')." ;;
    esac
  done
  port="${DAM_DEMO_PORT:-3001}"
  valid_port "$port" || die "DAM_DEMO_PORT must be a port number, not '$port'."
  pick_cli
  check_engine
  if [ "$reset" = yes ]; then
    say "Removing the demo containers and volumes ..."
    # In a subshell: the throwaway password must not reach the `up` below.
    (
      placeholder_secrets
      compose demo down --volumes --remove-orphans
    )
  fi
  ensure_secret DAM_DEMO_POSTGRES_PASSWORD "${DEMO_PROJECT}_pg-data"
  prepare_image demo
  say "Starting the demo. The first start loads the sample data, which takes a few minutes."
  compose demo up -d --no-build || {
    compose demo logs --tail 40 >&2 || true
    die "The demo did not start. The last log lines are above."
  }
  wait_for_app demo "$DEMO_PROJECT" "http://127.0.0.1:$port/" 300
  say ""
  say "The demo is running at http://127.0.0.1:$port (this computer only), signed in as Alex Rivera."
  say "Start with the sample space: http://127.0.0.1:$port/spaces/anycompany-tickets"
  say "Nothing in it calls AWS. Stop it with './scripts/stack.sh down --demo'."
}

cmd_down() {
  local which=real volumes=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --demo) which=demo ;;
      --volumes) volumes=(--volumes) ;;
      *) die "Unknown option for 'down': $1 (see './scripts/stack.sh help')." ;;
    esac
    shift
  done
  if [ "$which" = real ]; then
    # The refresher first, so that it cannot write credentials again while they are being removed.
    bridge_stop_refresher
  fi
  pick_cli
  check_engine
  placeholder_secrets
  if [ "$which" = real ]; then
    # While the worker still runs: the credentials go from the volume.
    bridge_clear || warn "Could not remove the AWS credentials from the app-data volume. They expire by themselves; './scripts/stack.sh down --volumes' deletes the volume."
    bridge_state_clear
  fi
  compose "$which" down --remove-orphans ${volumes[@]+"${volumes[@]}"}
  if [ "${#volumes[@]}" -gt 0 ]; then
    say "Removed the containers and their volumes."
  else
    say "Removed the containers. The data volumes are kept; add --volumes to delete them."
  fi
}

cmd_logs() {
  local which=real rest=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --demo) which=demo ;;
      *) rest+=("$1") ;;
    esac
    shift
  done
  pick_cli
  check_engine
  placeholder_secrets
  compose "$which" logs --tail 200 ${rest[@]+"${rest[@]}"}
}

cmd_status() {
  local which project port
  pick_cli
  check_engine
  placeholder_secrets
  for which in real demo; do
    if [ "$which" = demo ]; then
      project=$DEMO_PROJECT
      port="${DAM_DEMO_PORT:-3001}"
    else
      project=$REAL_PROJECT
      port="${DAM_PORT:-3000}"
    fi
    say "== $which stack (compose project $project, http://127.0.0.1:$port)"
    if [ -n "$("$CLI" ps -a -q --filter "label=com.docker.compose.project=$project" 2>/dev/null)" ]; then
      compose "$which" ps -a
    else
      say "not created"
    fi
    say ""
  done
  bridge_print_status
}

main() {
  local command="${1:-help}"
  [ $# -gt 0 ] && shift
  case "$command" in
    demo) cmd_demo "$@" ;;
    up) cmd_up "$@" ;;
    login) cmd_login "$@" ;;
    down) cmd_down "$@" ;;
    logs) cmd_logs "$@" ;;
    status) cmd_status "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage >&2
      die "Unknown command '$command'."
      ;;
  esac
}

main "$@"
