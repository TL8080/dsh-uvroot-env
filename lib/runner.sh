#!/bin/bash
#
# @local/dsh-uvroot-env — confinement runner for the DSH sandbox seam.
#
# The local sandbox provider spawns us in place of bubblewrap as
#   runner.sh <bwrap-profile-args...> -- <argv...>
# and hands us the calling session's environment, which the plugin's
# `shellEnv` contributor fills with:
#
#   DSH_UVROOT_SPEC       generated uvroot argv for the session's container
#   DSH_UVROOT_CONTAINER  the container id (for diagnostics)
#   DSH_UVROOT_WORKSPACE  the session workspace (host path)
#
# With a spec we run the command INSIDE the uvroot container, binding the
# workspace at its own absolute path and honouring the profile's mode: the
# profile carries `--bind <root> <root>` for workspace-write and only
# read-only binds for read-only. Without a spec we replay the profile through
# the real bubblewrap, so normal-mode sessions keep the shipped behaviour.

set -u

profile=()
inner=()
seen=0
for arg in "$@"; do
  if [ "$seen" -eq 0 ] && [ "$arg" = "--" ]; then
    seen=1
    continue
  fi
  if [ "$seen" -eq 0 ]; then
    profile+=("$arg")
  else
    inner+=("$arg")
  fi
done

if [ "${#inner[@]}" -eq 0 ]; then
  echo "uvroot-runner: no command after --" >&2
  exit 127
fi

spec="${DSH_UVROOT_SPEC:-}"

if [ -n "$spec" ] && [ -r "$spec" ]; then
  # shellcheck disable=SC1090
  . "$spec"

  if [ -z "${UVROOT_BIN:-}" ] || [ ! -x "$UVROOT_BIN" ]; then
    echo "uvroot-runner: uvroot binary is missing or not executable: ${UVROOT_BIN:-<unset>}" >&2
    echo "uvroot-runner: configure it in Settings -> uvroot environments" >&2
    exit 127
  fi

  # The profile's writable bind is the only signal that separates the two
  # modes; the workspace bind is added here so it always targets the session's
  # real directory.
  mode=ro
  index=0
  while [ "$index" -lt "${#profile[@]}" ]; do
    if [ "${profile[$index]}" = "--bind" ]; then
      mode=rw
      break
    fi
    index=$((index + 1))
  done

  workspace="${DSH_UVROOT_WORKSPACE:-$PWD}"
  args=("${UVROOT_ARGS[@]}")

  if [ -n "$workspace" ] && [ "${workspace#*:}" = "$workspace" ]; then
    args+=(-b "$workspace:$workspace")
    if [ "$mode" = ro ]; then
      args+=("--ro=$workspace")
    fi
  fi

  # DSH always shells out to `bash -c`; swap in a shell the guest actually has.
  # The generated spec may name one, otherwise derive it from the rootfs so a
  # bash-less image (Alpine/busybox) still runs. `-L` matters: a rootfs entry
  # like `/bin/sh -> /bin/busybox` is an absolute symlink that resolves against
  # the HOST root, so only the link itself is a reliable host-side probe.
  guest_shell="${UVROOT_SHELL:-}"
  if [ -z "$guest_shell" ]; then
    rootfs=''
    index=0
    while [ "$index" -lt "${#UVROOT_ARGS[@]}" ]; do
      if [ "${UVROOT_ARGS[$index]}" = "-r" ]; then
        rootfs="${UVROOT_ARGS[$((index + 1))]:-}"
        break
      fi
      index=$((index + 1))
    done
    guest_shell=bash
    if [ -n "$rootfs" ] && [ -d "$rootfs" ]; then
      if [ -e "$rootfs/bin/bash" ] || [ -L "$rootfs/bin/bash" ] \
        || [ -e "$rootfs/usr/bin/bash" ] || [ -L "$rootfs/usr/bin/bash" ]; then
        guest_shell=bash
      elif [ -e "$rootfs/bin/sh" ] || [ -L "$rootfs/bin/sh" ] \
        || [ -e "$rootfs/usr/bin/sh" ] || [ -L "$rootfs/usr/bin/sh" ]; then
        guest_shell=sh
      fi
    fi
  fi
  if [ -n "$guest_shell" ] && [ "$guest_shell" != "bash" ] && [ "${inner[0]}" = "bash" ]; then
    inner[0]="$guest_shell"
  fi

  # Include the configured library directory when the container's driver is
  # resolved with dlopen (libext2fs for image-backed root filesystems).
  if [ -n "${UVROOT_LIB_DIR:-}" ]; then
    export LD_LIBRARY_PATH="${UVROOT_LIB_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi

  # Container environment. A non-interactive `sh -c` never reads
  # /etc/profile.d, so the variables are sourced HERE, on the host, and the
  # guest process inherits them. Order: the spec's per-container file, then
  # `<data root>/env/<container id>.sh`, then the shared `<data root>/env.sh`.
  uvroot_root="$(dirname "$(dirname "$spec")")"
  for env_file in \
    "${UVROOT_ENV_FILE:-}" \
    "$uvroot_root/env/${UVROOT_CONTAINER:-}.sh" \
    "$uvroot_root/env.sh"; do
    if [ -n "$env_file" ] && [ -r "$env_file" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$env_file"
      set +a
    fi
  done

  # Keep the command inside the workspace even when PWD points elsewhere.
  workdir="${UVROOT_GUEST_CWD:-$PWD}"
  if [ -n "${DSH_UVROOT_WORKSPACE:-}" ] && [ "${PWD#"$DSH_UVROOT_WORKSPACE"}" = "$PWD" ]; then
    workdir="$DSH_UVROOT_WORKSPACE"
  fi

  # uvroot takes the guest command directly (no `--` separator).
  exec "$UVROOT_BIN" "${args[@]}" --kill-on-exit -w "$workdir" "${inner[@]}"
fi

exec bwrap "${profile[@]}" -- "${inner[@]}"
