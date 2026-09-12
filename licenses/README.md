# License inventory maintenance

Start with [third-party notices](../THIRD_PARTY_NOTICES.md). This directory keeps
original upstream LICENSE/NOTICE texts separate from the project's root MIT.
Content-addressed files under `npm/` are shared by packages with identical notice
text; their names are SHA-256 hashes, not npm package names. The package-to-text
mapping is in [npm-inventory.json](npm-inventory.json).

When dependencies change:

1. Use the resolved versions in all four lockfiles, including optional/platform
   and development entries. Check the exact package manifest and any embedded
   LICENSE, NOTICE or copyright headers. A missing lockfile license is not the
   same as an unlicensed package.
2. Preserve the upstream text verbatim. If a package omits it, record where the
   corresponding upstream notice was obtained. Do not silently manufacture a
   copyright statement from a package author's name. Keep incomplete cases marked
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

The default CI check verifies the recorded source inventory. `--distribution`
also rejects declared-only/partial package notices; even passing that option is
not a substitute for inspecting OS/native dependencies in an actual image or
installer. Ordinary CI does not download or execute upstream research projects,
contact model providers, or require secrets for this check.

Fetched license snapshots for assets are tied to upstream revisions in
[upstream-sources.json](upstream-sources.json). A license snapshot's revision is
not automatically the original import revision of every associated asset;
per-file evidence in `assets.json` makes that distinction explicit.
