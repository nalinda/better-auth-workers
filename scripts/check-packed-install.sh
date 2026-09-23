#!/usr/bin/env bash
# Installs the packed tarball into a fresh Bun project, the way a consumer
# pinning a release asset does, and imports every entry point. Catches a
# tarball that is missing `dist/` or an `exports` map that points at nothing.
# The package must not need install-time scripts (consumers would have to
# trust it for them to run), so any in the packed package.json fail the
# check; the consumer trusts the package anyway, so a lifecycle script Bun
# does run on install still gets exercised.
#
# Usage: scripts/check-packed-install.sh [path/to/better-auth-workers-x.y.z.tgz]
# Without an argument it packs the current tree (run `bun run build` first).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

if [ "$#" -ge 1 ]; then
  tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  tarball="$workdir/$(cd "$root" && npm pack --ignore-scripts --silent --pack-destination "$workdir")"
fi

# The consumer supplies better-auth as a peer; pin the version this
# repository is tested against so the check does not drift with the registry.
better_auth_version="$(cd "$root" && bun -e "console.log(require('better-auth/package.json').version)")"

cd "$workdir"
mkdir consumer
cd consumer
echo '{ "name": "consumer", "private": true, "type": "module", "trustedDependencies": ["better-auth-workers"] }' > package.json
bun add "$tarball" "better-auth@$better_auth_version" >/dev/null

cat > check.ts <<'TS'
const manifest = await Bun.file('node_modules/better-auth-workers/package.json').json();
for (const hook of ['preinstall', 'install', 'postinstall']) {
  if (manifest.scripts?.[hook]) throw new Error(`the packed package.json declares a ${hook} script`);
}
const root = await import('better-auth-workers');
const client = await import('better-auth-workers/client');
if (typeof root.createAuth !== 'function') throw new Error('createAuth is not exported');
if (typeof client.createSessionClient !== 'function') {
  throw new Error('createSessionClient is not exported from better-auth-workers/client');
}
for (const dir of ['migrations/postgres', 'migrations/sqlite']) {
  const glob = new Bun.Glob('*.sql');
  const files = [...glob.scanSync(`node_modules/better-auth-workers/${dir}`)];
  if (files.length === 0) throw new Error(`no SQL shipped under ${dir}`);
}
console.log('packed install OK');
TS
bun check.ts
