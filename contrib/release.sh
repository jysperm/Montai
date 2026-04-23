#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Error: working tree is not clean" >&2
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists" >&2
  exit 1
fi

echo "Publishing montai@$VERSION to npm..."
npm publish

echo "Creating and pushing tag $TAG..."
git tag "$TAG"
git push origin "$TAG"

echo "Released montai@$VERSION"
