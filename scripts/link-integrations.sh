#!/usr/bin/env bash
#
# Link the external WhiteBox integrations into this monorepo for local dev.
#
# Integrations live OUTSIDE the monorepo (default: ../whitebox-integrations,
# override with WB_INTEGRATIONS_DIR), each in its own repo. This wires them into
# the monorepo's node_modules so `import { mailgun } from 'whitebox-mail-mailgun'`
# (etc.) resolves. Run it after `npm install`. Idempotent; skips anything not
# present on disk.
#
# Two cases:
#   • adnetwork packages depend on the in-monorepo `whitebox-adnetworks` kernel,
#     which isn't published — so we symlink the kernel into them (their only
#     runtime dep) rather than `npm install` (which would 404).
#   • other integrations (mail/auth) have ordinary registry deps — we install
#     those, skipping the unpublished `whitebox-*` peer deps.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTEGRATIONS_DIR="${WB_INTEGRATIONS_DIR:-$(cd "$ROOT/.." && pwd)/whitebox-integrations}"
KERNEL="whitebox-adnetworks"

if [ ! -d "$INTEGRATIONS_DIR" ]; then
  echo "No integrations directory at $INTEGRATIONS_DIR — nothing to link."
  exit 0
fi

mkdir -p "$ROOT/node_modules"
echo "Linking integrations from $INTEGRATIONS_DIR"
linked=()

shopt -s nullglob
for dir in "$INTEGRATIONS_DIR"/*/; do
  dir="${dir%/}"
  [ -f "$dir/package.json" ] || continue
  name="$(node -p "require('$dir/package.json').name" 2>/dev/null)" || continue
  printf '  → %-28s' "$name"

  if node -e "process.exit((require('$dir/package.json').dependencies||{})['$KERNEL']?0:1)"; then
    # adnetwork: bridge the unpublished kernel (its only runtime dep)
    mkdir -p "$dir/node_modules"
    ln -sfn "$ROOT/$KERNEL" "$dir/node_modules/$KERNEL"
    echo "[kernel bridged]"
  else
    # mail/auth/etc: ensure registry deps are installed (idempotent), ignoring
    # the unpublished whitebox-* peer deps. We verify a declared dep actually
    # resolves rather than trusting a (possibly stale) node_modules dir.
    if node -e "const d=Object.keys(require('$dir/package.json').dependencies||{}); if(!d.length)process.exit(0); try{require.resolve(d[0],{paths:['$dir/node_modules']});process.exit(0)}catch{process.exit(1)}"; then
      echo "[deps present]"
    else
      ( cd "$dir" && npm install --legacy-peer-deps --no-audit --no-fund --no-package-lock >/dev/null 2>&1 ) \
        && echo "[deps installed]" || echo "[deps install FAILED — run npm install in $dir]"
    fi
  fi

  ln -sfn "$dir" "$ROOT/node_modules/$name"
  linked+=("$name")
done

echo "Linked ${#linked[@]} integration(s) into $ROOT/node_modules:"
for n in "${linked[@]}"; do echo "    $n"; done
