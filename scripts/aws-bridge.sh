#!/usr/bin/env bash
# The AWS credential bridge of the container stack. It gives the app containers short-lived AWS
# credentials that the AWS CLI on your computer resolves, and keeps them renewed.
#
# This file has two uses:
#   - ./scripts/stack.sh sources it for the functions below (nothing runs when it is sourced).
#   - ./scripts/stack.sh up starts it in the background as the refresher:
#       scripts/aws-bridge.sh run --cli <podman|docker> --project <compose project> [--profile <name>]
#     You do not run it by hand. Use ./scripts/stack.sh status, login and down.
#
# How it works:
#   1. `aws configure export-credentials` (AWS CLI 2.9.6 or later) resolves the credentials of any
#      profile type: access keys, an assumed role, IAM Identity Center, credential_process.
#   2. The credentials travel on stdin into the worker container, which writes them to
#      /data/.aws-bridge/credentials.json in the app-data volume (mode 0600, owned by the app user), in the
#      JSON format of the AWS credential_process feature. They are never in an argument, an environment
#      variable, a file on your computer or a log.
#   3. /data/.aws-bridge/config, which has no secret, gives the profile (and [default]) a credential_process
#      that runs `cat` on that file. The web and worker containers use it through AWS_CONFIG_FILE, and the AWS
#      SDK runs the command again before the credentials expire.
#   4. The refresher repeats step 1 and 2 every minute while the credentials in the file expire in less
#      than 20 minutes (or have no real expiry), and keeps the old file when a renewal fails.
#
# Written for bash 3.2 (the macOS default). Never turn on `set -x` here: it would print credentials.

BRIDGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BRIDGE_SCRIPT="$BRIDGE_ROOT/scripts/aws-bridge.sh"
BRIDGE_STATE_DIR="$BRIDGE_ROOT/.dam"
BRIDGE_PID_FILE="$BRIDGE_STATE_DIR/aws-bridge.pid"
BRIDGE_LOG_FILE="$BRIDGE_STATE_DIR/aws-bridge.log"
BRIDGE_STATUS_FILE="$BRIDGE_STATE_DIR/aws-bridge.status"

# Set by the caller: the container engine and the compose project of the real stack.
BRIDGE_CLI="${BRIDGE_CLI:-podman}"
BRIDGE_PROJECT="${BRIDGE_PROJECT:-devops-agent-manager}"

# Paths inside the containers (the app-data volume is mounted at /data).
BRIDGE_CONTAINER_DIR=/data/.aws-bridge
BRIDGE_CREDENTIALS_PATH=$BRIDGE_CONTAINER_DIR/credentials.json
# shellcheck disable=SC2034 # used by scripts/stack.sh, which sources this file
BRIDGE_CONFIG_PATH=$BRIDGE_CONTAINER_DIR/config

BRIDGE_INTERVAL_SECONDS=60
# The refresher rewrites the file when the credentials in it expire in less time than this. The AWS SDK
# runs the credential_process again when 5 minutes are left (EXPIRATION_MS in @smithy/core and
# credentialsTreatedAsExpired in @aws-sdk/credential-provider-node), so the file is always renewed first.
BRIDGE_RENEW_BEFORE_SECONDS=1200
# shortcut: when the AWS CLI gives no expiration (access keys, or keys that an Okta tool wrote into
# ~/.aws/credentials), the file still gets one. The AWS SDK treats credentials without an Expiration as
# constant and never reads the file again, so the keys a host tool renewed would never arrive.
# With an Expiration 10 minutes ahead and a rewrite every minute, the SDK re-reads the file whenever it
# is within 5 minutes of that time. Upgrade when a profile type needs another rule.
BRIDGE_NO_EXPIRY_SECONDS=600

# Credential values of the current export. Wiped by bridge_wipe as soon as they are written.
BR_AK="" BR_SK="" BR_ST="" BR_EXP_RAW=""
# A short, safe description of the last failure (never holds a credential).
BRIDGE_ERROR=""

# ---------------------------------------------------------------- time

bridge_now() {
  date +%s
}

# bridge_iso_to_epoch <RFC 3339 timestamp>: prints seconds since 1970, or fails when it cannot parse.
# Pure bash so that it works the same with the BSD date of macOS and the GNU date of Linux.
bridge_iso_to_epoch() {
  local re='^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?([Zz]|[+-][0-9]{2}:?[0-9]{2})?$'
  local y m d hh mm ss tz offset=0 era yoe doy doe days
  [[ $1 =~ $re ]] || return 1
  y=$((10#${BASH_REMATCH[1]})) m=$((10#${BASH_REMATCH[2]})) d=$((10#${BASH_REMATCH[3]}))
  hh=$((10#${BASH_REMATCH[4]})) mm=$((10#${BASH_REMATCH[5]})) ss=$((10#${BASH_REMATCH[6]}))
  tz=${BASH_REMATCH[8]}
  case "$tz" in
    [+-]*)
      local sign=${tz:0:1} digits=${tz:1}
      digits=${digits/:/}
      offset=$((10#${digits:0:2} * 3600 + 10#${digits:2:2} * 60))
      [ "$sign" = "-" ] && offset=$((-offset))
      ;;
  esac
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$d" -ge 1 ] && [ "$d" -le 31 ] || return 1
  # Days since 1970-01-01 for a date in the proleptic Gregorian calendar.
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$(((y >= 0 ? y : y - 399) / 400))
  yoe=$((y - era * 400))
  doy=$(((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  days=$((era * 146097 + doe - 719468))
  printf '%s\n' $((days * 86400 + hh * 3600 + mm * 60 + ss - offset))
}

# bridge_epoch_to_iso <seconds>: prints YYYY-MM-DDTHH:MM:SSZ (UTC).
bridge_epoch_to_iso() {
  local t=$1 days secs z era doe yoe y doy mp d m
  days=$((t / 86400))
  secs=$((t % 86400))
  if [ "$secs" -lt 0 ]; then
    secs=$((secs + 86400))
    days=$((days - 1))
  fi
  z=$((days + 719468))
  era=$(((z >= 0 ? z : z - 146096) / 146097))
  doe=$((z - era * 146097))
  yoe=$(((doe - doe / 1460 + doe / 36524 - doe / 146096) / 365))
  y=$((yoe + era * 400))
  doy=$((doe - (365 * yoe + yoe / 4 - yoe / 100)))
  mp=$(((5 * doy + 2) / 153))
  d=$((doy - (153 * mp + 2) / 5 + 1))
  m=$((mp < 10 ? mp + 3 : mp - 9))
  [ "$m" -le 2 ] && y=$((y + 1))
  printf '%04d-%02d-%02dT%02d:%02d:%02dZ\n' "$y" "$m" "$d" $((secs / 3600)) $((secs % 3600 / 60)) $((secs % 60))
}

# "5 minutes", "2 hours", "40 seconds"
bridge_duration() {
  local s=$1
  [ "$s" -lt 0 ] && s=$((-s))
  if [ "$s" -lt 120 ]; then
    printf '%s seconds' "$s"
  elif [ "$s" -lt 7200 ]; then
    printf '%s minutes' $((s / 60))
  else
    printf '%s hours' $((s / 3600))
  fi
}

# ---------------------------------------------------------------- state folder (no secrets in it)

bridge_state_init() {
  mkdir -p "$BRIDGE_STATE_DIR"
  chmod 700 "$BRIDGE_STATE_DIR"
}

bridge_log() {
  printf '%s %s\n' "$(bridge_epoch_to_iso "$(bridge_now)")" "$*"
}

# bridge_state_get <key>: the value, or nothing.
bridge_state_get() {
  [ -f "$BRIDGE_STATUS_FILE" ] || return 0
  sed -n "s/^$1=//p" "$BRIDGE_STATUS_FILE" | tail -n 1
}

# bridge_state_set <key> <value>: replaces the line of <key>. The value is one line of plain text.
bridge_state_set() {
  local tmp
  bridge_state_init
  tmp="$(umask 077 && mktemp "$BRIDGE_STATE_DIR/.status.XXXXXX")"
  {
    if [ -f "$BRIDGE_STATUS_FILE" ]; then grep -v "^$1=" "$BRIDGE_STATUS_FILE" || true; fi
    printf '%s=%s\n' "$1" "$2"
  } >"$tmp"
  mv "$tmp" "$BRIDGE_STATUS_FILE"
}

bridge_state_clear() {
  rm -f "$BRIDGE_STATUS_FILE"
}

# ---------------------------------------------------------------- AWS CLI

# Prints "missing", "old <version>" or "ok".
bridge_cli_state() {
  local line ver major minor patch
  command -v aws >/dev/null 2>&1 || {
    echo missing
    return 0
  }
  line="$(aws --version 2>&1 | head -n 1 || true)"
  ver="${line#aws-cli/}"
  ver="${ver%% *}"
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  patch="${ver#*.*.}"
  patch="${patch%%[!0-9]*}"
  case "$major$minor$patch" in
    '' | *[!0-9]*)
      echo "old ${ver:-unknown}"
      return 0
      ;;
  esac
  # export-credentials needs AWS CLI 2.9.6 or later.
  if [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && { [ "$minor" -gt 9 ] || { [ "$minor" -eq 9 ] && [ "$patch" -ge 6 ]; }; }; }; then
    echo ok
  else
    echo "old $ver"
  fi
}

# One line of plain text from CLI output, with anything that could be a credential removed.
bridge_clean_error() {
  printf '%s\n' "$1" |
    sed -E -e '/AWS_(ACCESS|SECRET|SESSION)|AccessKeyId|SecretAccessKey|SessionToken/d' -e 's/[A-Za-z0-9\/+=_-]{40,}/[removed]/g' |
    head -n 3 | tr '\n\t' '  ' | tr -s ' ' | sed -E 's/^ +//; s/ +$//' | cut -c1-300
}

# bridge_wipe: forget the credential values held in this shell.
bridge_wipe() {
  BR_AK="" BR_SK="" BR_ST="" BR_EXP_RAW=""
}

# bridge_parse_export <output of `aws configure export-credentials --format env-no-export`>
# Sets BR_AK, BR_SK, BR_ST and BR_EXP_RAW. Only the four known names are read, and only a value that
# looks like a credential is accepted: no quote, space or shell syntax gets through. It reads the text
# with parameter expansion only, because a here-string or heredoc can make bash write a temporary
# file, and these values must never reach a file on this computer.
bridge_parse_export() {
  local rest=$1 line name value
  bridge_wipe
  while [ -n "$rest" ]; do
    case "$rest" in
      *$'\n'*)
        line=${rest%%$'\n'*}
        rest=${rest#*$'\n'}
        ;;
      *)
        line=$rest
        rest=""
        ;;
    esac
    line=${line%$'\r'}
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    name=${line%%=*}
    value=${line#*=}
    case "$name" in
      AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_SESSION_TOKEN | AWS_CREDENTIAL_EXPIRATION) ;;
      *) continue ;;
    esac
    case "$value" in
      '' | *[!A-Za-z0-9/+=_.:-]*)
        bridge_wipe
        BRIDGE_ERROR="The AWS CLI printed a value for $name in a format this script does not accept."
        return 1
        ;;
    esac
    case "$name" in
      AWS_ACCESS_KEY_ID) BR_AK=$value ;;
      AWS_SECRET_ACCESS_KEY) BR_SK=$value ;;
      AWS_SESSION_TOKEN) BR_ST=$value ;;
      AWS_CREDENTIAL_EXPIRATION) BR_EXP_RAW=$value ;;
    esac
  done
  if [ -z "$BR_AK" ] || [ -z "$BR_SK" ]; then
    bridge_wipe
    BRIDGE_ERROR="The AWS CLI output had no access key and secret."
    return 1
  fi
}

# bridge_export <profile or empty>: asks the AWS CLI for the credentials. 0 and BR_* set, or 1 and BRIDGE_ERROR set.
bridge_export() {
  local out
  if [ -n "$1" ]; then
    out="$(aws configure export-credentials --profile "$1" --format env-no-export 2>&1)" || {
      BRIDGE_ERROR="$(bridge_clean_error "$out")"
      [ -n "$BRIDGE_ERROR" ] || BRIDGE_ERROR="The AWS CLI could not export credentials for profile '$1'."
      return 1
    }
  else
    out="$(aws configure export-credentials --format env-no-export 2>&1)" || {
      BRIDGE_ERROR="$(bridge_clean_error "$out")"
      [ -n "$BRIDGE_ERROR" ] || BRIDGE_ERROR="The AWS CLI could not export credentials from its default credential chain."
      return 1
    }
  fi
  bridge_parse_export "$out" || {
    out=""
    return 1
  }
  out=""
}

# ---------------------------------------------------------------- containers

# Prints the ID of a running app container (the worker, else the web app) of the real stack.
bridge_find_container() {
  local service id
  for service in worker web; do
    id="$("$BRIDGE_CLI" ps -q --filter "label=com.docker.compose.project=$BRIDGE_PROJECT" --filter "label=com.docker.compose.service=$service" --filter status=running 2>/dev/null | head -n 1 || true)"
    if [ -n "$id" ]; then
      printf '%s\n' "$id"
      return 0
    fi
  done
  return 1
}

# bridge_put <file name>: writes stdin to /data/.aws-bridge/<file name> inside the app containers' shared
# volume, as the app user, mode 0600, through a temporary file so that a reader never sees half of it.
# The data goes through the standard input of `exec`, not through an argument or the environment.
bridge_put() {
  local id
  id="$(bridge_find_container)" || {
    cat >/dev/null
    return 3
  }
  # The single quotes are on purpose: the script runs in the container, and its variables are the container shell's.
  # shellcheck disable=SC2016
  "$BRIDGE_CLI" exec -i "$id" sh -c '
    umask 077
    d=/data/.aws-bridge
    t="$d/.tmp.$$"
    if mkdir -p "$d" && chmod 700 "$d" && cat >"$t" && mv "$t" "$d/$1"; then exit 0; fi
    rm -f "$t"
    exit 1
  ' sh "$1" >/dev/null 2>&1
}

# bridge_put_failed <return code of bridge_put>: sets BRIDGE_ERROR. bridge_put runs in a pipeline, so it cannot set it.
bridge_put_failed() {
  case "$1" in
    3) BRIDGE_ERROR="The app containers are not running." ;;
    *) BRIDGE_ERROR="Could not write into the app containers." ;;
  esac
}

# bridge_write_config <profile or empty>: the config file the containers read. It has no secret.
bridge_write_config() {
  local profile=$1 region="" line="credential_process = cat $BRIDGE_CREDENTIALS_PATH"
  if [ -n "$profile" ]; then
    region="$(aws configure get region --profile "$profile" 2>/dev/null || true)"
  else
    region="$(aws configure get region 2>/dev/null || true)"
  fi
  case "$region" in
    '' | *[!a-z0-9-]*) region="" ;;
  esac
  {
    printf '# Written by scripts/aws-bridge.sh. It holds no secret.\n[default]\n%s\n' "$line"
    if [ -n "$region" ]; then printf 'region = %s\n' "$region"; fi
    if [ -n "$profile" ] && [ "$profile" != default ]; then
      printf '\n[profile %s]\n%s\n' "$profile" "$line"
      if [ -n "$region" ]; then printf 'region = %s\n' "$region"; fi
    fi
  } | bridge_put config || {
    bridge_put_failed $?
    return 1
  }
}

# bridge_renew <profile or empty>: export, check, and write the credentials into the containers.
# Returns 0, or 1 with BRIDGE_ERROR set (the old file stays as it was). Records the result in the status file.
bridge_renew() {
  local profile=$1 now exp_epoch real json rc=0 token_json=""
  BRIDGE_ERROR=""
  if ! bridge_export "$profile"; then
    bridge_note_error "$BRIDGE_ERROR"
    return 1
  fi
  now="$(bridge_now)"
  if [ -n "$BR_EXP_RAW" ] && exp_epoch="$(bridge_iso_to_epoch "$BR_EXP_RAW")"; then
    real=1
  else
    exp_epoch=$((now + BRIDGE_NO_EXPIRY_SECONDS))
    real=0
  fi
  if [ "$exp_epoch" -le "$now" ]; then
    bridge_wipe
    BRIDGE_ERROR="The AWS CLI returned credentials that have already expired."
    bridge_note_error "$BRIDGE_ERROR"
    return 1
  fi
  if [ -n "$BR_ST" ]; then token_json="$(printf ',"SessionToken":"%s"' "$BR_ST")"; fi
  json="$(printf '{"Version":1,"AccessKeyId":"%s","SecretAccessKey":"%s"%s,"Expiration":"%s"}' "$BR_AK" "$BR_SK" "$token_json" "$(bridge_epoch_to_iso "$exp_epoch")")"
  bridge_wipe
  token_json=""
  printf '%s\n' "$json" | bridge_put credentials.json || rc=$?
  json=""
  if [ "$rc" -ne 0 ]; then
    bridge_put_failed "$rc"
    bridge_note_error "$BRIDGE_ERROR"
    return 1
  fi
  bridge_state_set last_renewal "$now"
  bridge_state_set expiry "$exp_epoch"
  bridge_state_set real_expiry "$real"
  bridge_state_set error ""
  bridge_state_set error_at ""
}

bridge_note_error() {
  bridge_state_set error "$1"
  bridge_state_set error_at "$(bridge_now)"
}

# bridge_clear: delete the credentials and the config from the volume. Uses a running app container, else a
# throwaway one that mounts the volume. Prints what it could not do and returns 1.
bridge_clear() {
  local id image="${DAM_IMAGE:-localhost/devops-agent-manager:dev}" volume="${BRIDGE_PROJECT}_app-data"
  if id="$(bridge_find_container)"; then
    "$BRIDGE_CLI" exec "$id" rm -rf "$BRIDGE_CONTAINER_DIR" >/dev/null 2>&1 && return 0
  fi
  if "$BRIDGE_CLI" volume inspect "$volume" >/dev/null 2>&1; then
    if "$BRIDGE_CLI" image inspect "$image" >/dev/null 2>&1 &&
      "$BRIDGE_CLI" run --rm --entrypoint rm -v "$volume:/data" "$image" -rf "$BRIDGE_CONTAINER_DIR" >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------- the refresher process

# True when <pid> is a refresher of this repository (a number in a file may belong to something else by now).
bridge_pid_is_ours() {
  local pid=$1 cmd
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  cmd="$(ps -ww -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *"$BRIDGE_SCRIPT run"*) return 0 ;;
  esac
  return 1
}

# Prints the PID of the running refresher, or nothing.
bridge_refresher_pid() {
  local pid=""
  [ -f "$BRIDGE_PID_FILE" ] && pid="$(head -n 1 "$BRIDGE_PID_FILE" 2>/dev/null || true)"
  if bridge_pid_is_ours "$pid"; then printf '%s\n' "$pid"; fi
}

bridge_stop_refresher() {
  local pid waited=0
  pid="$(bridge_refresher_pid)"
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 50 ]; do
      sleep 0.1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$BRIDGE_PID_FILE"
}

# bridge_start_refresher <profile or empty>
bridge_start_refresher() {
  local pid args launcher=()
  bridge_state_init
  (umask 077 && : >>"$BRIDGE_LOG_FILE")
  args=(run --cli "$BRIDGE_CLI" --project "$BRIDGE_PROJECT")
  if [ -n "$1" ]; then args+=(--profile "$1"); fi
  # A session of its own: no terminal, so an AWS CLI prompt (an MFA code) cannot stop it or garble your
  # terminal, and Ctrl+C or closing the terminal does not reach it. macOS has no setsid command, but has perl.
  if command -v perl >/dev/null 2>&1; then
    launcher=(perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV')
  elif command -v setsid >/dev/null 2>&1; then
    launcher=(setsid)
  fi
  # nohup keeps it running when the terminal closes. It holds no credential: it asks the AWS CLI each time.
  nohup ${launcher[@]+"${launcher[@]}"} bash "$BRIDGE_SCRIPT" "${args[@]}" >>"$BRIDGE_LOG_FILE" 2>&1 </dev/null &
  pid=$!
  disown "$pid" 2>/dev/null || true
  (umask 077 && printf '%s\n' "$pid" >"$BRIDGE_PID_FILE")
  sleep 1
  kill -0 "$pid" 2>/dev/null
}

# The refresher's loop. <profile or empty>
bridge_run() {
  local profile=$1 sleep_pid="" gone=0 now expiry real remaining listing
  local err_logged="" err_logged_at=0 ok_logged_at=0
  trap '[ -z "$sleep_pid" ] || kill "$sleep_pid" 2>/dev/null || true; bridge_log "refresher stopped"; exit 0' TERM INT HUP
  bridge_log "refresher started (pid $$, profile ${profile:-none})"
  while true; do
    now="$(bridge_now)"
    # An engine that does not answer is not the same as a stack that is gone: only the second ends the refresher.
    if listing="$("$BRIDGE_CLI" ps -a -q --filter "label=com.docker.compose.project=$BRIDGE_PROJECT" 2>/dev/null)"; then
      if [ -z "$listing" ]; then
        gone=$((gone + 1))
        if [ "$gone" -ge 15 ]; then
          bridge_log "the app containers are gone; refresher stopped"
          bridge_state_clear
          rm -f "$BRIDGE_PID_FILE"
          exit 0
        fi
      else
        gone=0
      fi
    fi
    expiry="$(bridge_state_get expiry)"
    real="$(bridge_state_get real_expiry)"
    remaining=0
    case "$expiry" in '' | *[!0-9]*) ;; *) remaining=$((expiry - now)) ;; esac
    if [ "$real" = 1 ] && [ "$remaining" -ge "$BRIDGE_RENEW_BEFORE_SECONDS" ]; then
      : # the credentials in the file are good for a while yet
    elif bridge_renew "$profile"; then
      if [ -n "$err_logged" ]; then
        bridge_log "credentials renewed again, valid until $(bridge_epoch_to_iso "$(bridge_state_get expiry)")"
        ok_logged_at=$now
      elif [ "$((now - ok_logged_at))" -ge 1800 ]; then
        bridge_log "credentials renewed, valid until $(bridge_epoch_to_iso "$(bridge_state_get expiry)")"
        ok_logged_at=$now
      fi
      err_logged=""
    else
      # The same message is logged once, then again every 10 minutes.
      if [ "$BRIDGE_ERROR" != "$err_logged" ] || [ "$((now - err_logged_at))" -ge 600 ]; then
        bridge_log "renewal failed, the old credentials stay in place: $BRIDGE_ERROR. If your AWS sign-in ended, run ./scripts/stack.sh login"
        err_logged=$BRIDGE_ERROR
        err_logged_at=$now
      fi
    fi
    # Keep the log small.
    if [ -f "$BRIDGE_LOG_FILE" ] && [ "$(wc -c <"$BRIDGE_LOG_FILE")" -gt 262144 ]; then
      tail -n 200 "$BRIDGE_LOG_FILE" >"$BRIDGE_LOG_FILE.tmp" && cat "$BRIDGE_LOG_FILE.tmp" >"$BRIDGE_LOG_FILE"
      rm -f "$BRIDGE_LOG_FILE.tmp"
    fi
    sleep "$BRIDGE_INTERVAL_SECONDS" &
    sleep_pid=$!
    wait "$sleep_pid" || true
    sleep_pid=""
  done
}

# ---------------------------------------------------------------- status

# Prints the bridge section of `stack.sh status`.
bridge_print_status() {
  local pid profile last expiry real error error_at now mode
  now="$(bridge_now)"
  mode="$(bridge_state_get mode)"
  profile="$(bridge_state_get profile)"
  echo "== AWS access"
  case "$mode" in
    bridge) ;;
    mount)
      echo "The ~/.aws folder is mounted read-only into the containers${profile:+ (profile $profile)}. No credential bridge runs."
      return 0
      ;;
    *)
      echo "not set up (./scripts/stack.sh up starts it)"
      return 0
      ;;
  esac
  pid="$(bridge_refresher_pid)"
  if [ -n "$pid" ]; then
    echo "refresher:        running (PID $pid, log .dam/aws-bridge.log)"
  else
    echo "refresher:        NOT running. Start it with ./scripts/stack.sh login"
  fi
  echo "profile:          ${profile:-none (credentials come from the shell that ran up, and will not renew)}"
  last="$(bridge_state_get last_renewal)"
  if [ -n "$last" ]; then
    echo "last renewal:     $(bridge_epoch_to_iso "$last") ($(bridge_duration $((now - last))) ago)"
  else
    echo "last renewal:     never"
  fi
  expiry="$(bridge_state_get expiry)"
  real="$(bridge_state_get real_expiry)"
  if [ -n "$expiry" ]; then
    if [ "$real" = 1 ]; then
      if [ "$expiry" -gt "$now" ]; then
        echo "credentials end:  $(bridge_epoch_to_iso "$expiry") (in $(bridge_duration $((expiry - now))))"
      else
        echo "credentials end:  $(bridge_epoch_to_iso "$expiry") (EXPIRED $(bridge_duration $((now - expiry))) ago)"
      fi
    else
      echo "credentials end:  no expiry from the AWS CLI; the file is renewed every minute and valid for about $(bridge_duration "$BRIDGE_NO_EXPIRY_SECONDS")"
    fi
  fi
  error="$(bridge_state_get error)"
  error_at="$(bridge_state_get error_at)"
  if [ -n "$error" ]; then
    echo "last error:       $error (${error_at:+$(bridge_duration $((now - error_at))) ago})"
    echo "                  If your AWS sign-in ended, run ./scripts/stack.sh login"
  else
    echo "last error:       none"
  fi
}

# ---------------------------------------------------------------- command line (the refresher)

bridge_main() {
  # No -e: the refresher must outlive a failed command and report it.
  set -uo pipefail
  local command="${1:-}" profile=""
  [ $# -gt 0 ] && shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --cli) BRIDGE_CLI=$2 ;;
      --project) BRIDGE_PROJECT=$2 ;;
      --profile) profile=$2 ;;
      *)
        echo "aws-bridge.sh: unknown option $1" >&2
        exit 2
        ;;
    esac
    shift 2
  done
  case "$command" in
    run) bridge_run "$profile" ;;
    *)
      echo "aws-bridge.sh is started by ./scripts/stack.sh up. See ./scripts/stack.sh help." >&2
      exit 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  bridge_main "$@"
fi
