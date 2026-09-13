# License inventory maintenance

This directory contains third-party LICENSE/NOTICE texts and dependency and asset inventories. See [third-party notices](../THIRD_PARTY_NOTICES.md) for an overview.
Content-addressed files under `npm/` are shared by packages with identical notice
text; their names are SHA-256 hashes, not npm package names. The package-to-text
mapping is in [npm-inventory.json](npm-inventory.json).

When dependencies change:

1. Use the resolved versions in all four lockfiles, including optional/platform
   and development entries. Check the exact package manifest and any embedded
   LICENSE, NOTICE or copyright headers. If the lockfile omits a license, check the package files and upstream repository.
2. Preserve the upstream text verbatim. If a package omits it, record where the
   corresponding upstream notice was obtained. Use the upstream text for copyright information. Keep incomplete cases marked
   explicitly as described in [DISTRIBUTION.md](DISTRIBUTION.md).
3. Update package occurrences, license declarations, evidence and manifest hashes
   in `npm-inventory.json`, along with both human-readable dependency tables.
   Manifest hashes use UTF-8 text with CRLF normalized to LF. Notice and asset
   hashes use the exact stored bytes; `.gitattributes` preserves notice/SVG bytes.
4. Record new or changed distributed visual assets in `assets.json` with their
   source, copyright/license, modification notes and checksum. Keep asset notices
   available to browser users, including transitive icon-geometry notices.
5. Run `node scripts/generate-browser-notices.mjs`, then
   `node scripts/check-license-inventory.mjs` from the repository root.

The default check verifies inventory records, file hashes and browser notices. With `--distribution`, missing or partial license texts also fail the check. Published images and installers need an inventory of their OS packages and native dependencies; see [distribution notes](DISTRIBUTION.md).

[upstream-sources.json](upstream-sources.json) records the upstream revisions used to collect licenses; [assets.json](assets.json) records the sources and matching information for individual assets.

Preserve package identifiers, versions, SPDX identifiers and upstream notice text when updating the dependency tables.
