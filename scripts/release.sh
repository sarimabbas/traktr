#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 1.0.1"
  exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: version must be in x.y.z format (got '$VERSION')"
  exit 1
fi

# Ensure working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes — commit or stash first"
  exit 1
fi

echo "Releasing $VERSION..."

# Update manifest.json
node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  m.version = '$VERSION';
  fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
"

# Update package.json (--no-git-tag-version so we control the tag)
npm version "$VERSION" --no-git-tag-version --no-workspaces-update > /dev/null

# Update versions.json — carry forward the current minAppVersion
node -e "
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
  versions[manifest.version] = manifest.minAppVersion;
  fs.writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
"

# Build
npm run build

# Commit
git add manifest.json package.json package-lock.json versions.json main.js
git commit -m "chore: release $VERSION"

# Tag
git tag -a "$VERSION" -m "$VERSION"

# Push
git push origin main
git push origin "$VERSION"

echo "Done — $VERSION pushed. Check GitHub Actions for the draft release."
