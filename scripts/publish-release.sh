#!/usr/bin/env bash
set -euo pipefail

tag="$1"
assets="$2"
version="${tag#v}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+|\.rc\.[0-9]+)?$ ]] || { echo "Invalid release tag" >&2; exit 1; }
flags=(--prerelease=false)
notes=()
if [[ "$version" == *-* || "$version" == *.rc.* ]]; then
  flags=(--prerelease --latest=false)
fi
if [[ -s "$assets/release-notes.md" ]]; then
  notes+=(--notes-file "$assets/release-notes.md")
else
  notes+=(--generate-notes)
fi

# A failed lookup is not necessarily a missing release (auth/network errors).
releases="$(gh api --paginate "repos/${GH_REPO}/releases?per_page=100" --jq ".[] | select(.tag_name == \"$tag\") | .draft")"
if [[ "$releases" == false ]]; then
  echo "Release $tag is already published."
  exit 0
fi
if [[ -z "$releases" ]]; then
  if ! gh release create "$tag" --draft --verify-tag --title "Pluto $tag" "${flags[@]}" "${notes[@]}"; then
    echo "Draft creation failed. If GitHub reports an immutable-release tag collision, this tag is permanently reserved; do not delete or move it. Prepare a fresh version after approval." >&2
    exit 1
  fi
fi
# Upload everything before publication locks assets and the tag.
gh release upload "$tag" "$assets"/*.dmg "$assets/SHA256SUMS.txt" --clobber
if [[ -s "$assets/release-notes.md" ]]; then
  gh release edit "$tag" --draft=false "${flags[@]}" --notes-file "$assets/release-notes.md"
else
  gh release edit "$tag" --draft=false "${flags[@]}"
fi
