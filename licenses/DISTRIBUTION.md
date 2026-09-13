# Distribution and license notes

## Scope of this inventory

The checked-in inventory covers 846 unique npm name/version pairs from four
lockfiles (1,028 lockfile locations, including optional and development packages).
The source snapshot does not vendor `node_modules`, research clones, language
server installations, container images or native binaries.

When distributing third-party code or assets, preserve their copyright notices and license texts and follow the applicable terms.

## Missing license materials

All 846 packages have a verified license declaration from a lockfile, installed
package manifest or exact-version npm metadata. 833 have a collected upstream
license/notice. The following 13 records are marked
`metadata-only-or-partial`:

| Packages | Evidence / limitation |
| --- | --- |
| `@mariozechner/clipboard@0.3.9` and ten platform packages at `0.3.9` | Published metadata declares MIT. The inspected package/upstream tree does not provide a full LICENSE file. The fork credits CrossCopy/clipboard and clipboard-rs; native Rust dependencies require their own binary-level inventory. |
| `@napi-rs/lzma-linux-x64-gnu@1.5.1` | Published metadata declares MIT, but no full upstream license text was located for this package. A native-library dependency review is needed before repackaging its binary. |
| `stackback@0.0.2` | Metadata declares MIT without a separate full MIT notice. `formatstack.js` contains a V8 BSD-3-Clause copyright/license header, which is preserved in the collected notices. Treat this embedded code as BSD-3-Clause, not MIT-only. This is a development dependency. |

The source repository records npm dependencies; binaries are obtained during installation or building. Before publishing a preinstalled image,
executable, desktop installer or bundled SDK, resolve the applicable exceptions
and inventory the **actual artifact**, including embedded native dependencies.
`node scripts/check-license-inventory.mjs --distribution` fails until these materials are complete.

## Licenses requiring particular attention

- `lightningcss@1.33.0` and its eleven platform packages declare MPL-2.0.
  They are Web development/build dependencies. Covered files retain MPL-2.0. If distributing covered executables or modified covered files, satisfy
  the MPL's source-availability obligations for those files. Building Web assets
  with a tool does not, by itself, place all generated application code under the
  tool's license. See [Mozilla's MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
  and the package's collected license.
- `caniuse-lite@1.0.30001809` contains browser-support data under CC-BY-4.0.
  Credit the caniuse/caniuse-lite contributors, link to
  [caniuse-lite](https://github.com/browserslist/caniuse-lite) and retain its
  [license](https://creativecommons.org/licenses/by/4.0/) if redistributing the
  dataset.
- `json-schema@0.4.0` offers AFL-2.1 **or** BSD-3-Clause. For this project's use,
  select the BSD-3-Clause option; the original dual-license text is retained.
- Jason Handwriting remains under SIL OFL 1.1. Its full-font TTF-to-WOFF2
  conversion and the font-derived brand wordmark are documented in ASSETS.md.
  System font fallbacks are references to fonts on the user's device, not copies.
- Apache-2.0 dependencies retain their full LICENSE and any supplied NOTICE;
  include modification notices when changing third-party source.
- Brand logos remain subject to their owners' trademark rights. The project's
  MIT is not permission to imply endorsement or claim ownership of those marks.

## Containers and external processes

The deployment configuration references the following images, programs and services. Check the third-party materials included in a distribution package separately from the npm inventory:

| Component | Usage and license |
| --- | --- |
| Node.js, Debian/Alpine, Nginx, PostgreSQL, tini and Docker CLI | External image/OS/tool dependencies. Preserve their distributed copyright files and license inventory in any published image; npm license output does not cover OS packages. |
| Redis 7.4 (`redis:7.4-alpine`) | External service image. This series uses **RSALv2 or SSPLv1**, not the older BSD license. Its terms are not replaced by what-the-repo MIT. See [Redis's version-specific license table](https://redis.io/legal/licenses/). |
| Grafana (`grafana/grafana:13.1.0`) | Optional external monitoring image. Grafana OSS uses AGPLv3; plugins and image contents can have additional terms. See [Grafana licensing](https://grafana.com/licensing/). |
| Prometheus, Alertmanager and k3s/k3d | External monitoring/cluster tooling; upstream Apache-2.0 projects. Inspect exact image contents before redistribution. |
| WAL-G `v3.0.9` | The PostgreSQL Dockerfile downloads its binary. Preserve [WAL-G's copyright notice](upstream/wal-g.txt) and [Apache-2.0](upstream/Apache-2.0.txt). Its compiled Go dependencies and OS packages require an actual-image inventory before publishing that image. |
| Language servers | Configured external executables, not bundled in this source repository. Each installed implementation/version has its own terms. |
| OAuth, model providers, search APIs and object storage | External services governed by their service terms. Their credentials are not included in the source release. |
