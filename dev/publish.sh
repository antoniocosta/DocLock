#!/bin/sh
# Copies the app (app/ plus your config.js) into a folder of a static site's
# git repository and commits it there. Only app/ is published: no tests,
# reference files or README.
#
#   dev/publish.sh SITE_REPO [FOLDER]     # FOLDER defaults to doclock
#   cd SITE_REPO && git push              # then deploy the site as usual
set -eu

site=${1:?usage: dev/publish.sh SITE_REPO [FOLDER]}
folder=${2:-doclock}
app=$(cd "$(dirname "$0")/../app" && pwd)

grep -q 'apps.googleusercontent.com' "$app/config.js" 2>/dev/null ||
  { echo "app/config.js is missing or has no client ID (see README)." >&2; exit 1; }
git -C "$site" rev-parse --is-inside-work-tree >/dev/null
[ -z "$(git -C "$site" status --porcelain -- "$folder")" ] ||
  { echo "$site/$folder has uncommitted changes; commit or discard them first." >&2; exit 1; }

version=$(git -C "$app/.." describe --always --dirty)
rm -rf "${site:?}/$folder"
mkdir -p "$site/$folder"
cp -R "$app"/. "$site/$folder/"
rm -f "$site/$folder/config.example.js"

git -C "$site" add -A -- "$folder"
if git -C "$site" diff --cached --quiet -- "$folder"; then
  echo "Nothing changed in $folder."
else
  git -C "$site" commit -q -m "DocLock $version" -- "$folder"
  echo "Committed DocLock $version to $site/$folder. Push the site repo to publish."
fi
