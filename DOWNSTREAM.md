# egon-r OMP distribution

This is an independently maintained fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). Compatibility with upstream is not guaranteed. Use this repository's releases and package-manager commands, not upstream's installer or updater.

## Versions and supported platform

`downstream-version.txt` is the downstream release version: `<upstream-version>-egon.<revision>`, initially `18.16.0-egon.1`. Increment the downstream revision for each changed build; do not replace assets of a published version. When integrating a newer upstream, change the upstream part and restart at `egon.1`.

Releases contain `omp-macos-arm64.tar.gz` and `omp-linux-x64` plus one combined `SHA256SUMS`. The macOS archive contains only `bin/omp` and `LICENSE`; its executable is ad-hoc signed, not Apple-notarized. Review the source and use macOS's explicit approval flow if Gatekeeper blocks a downloaded binary. The Linux x64 asset is the unsigned standalone executable from the same `downstream-version.txt` revision, smoke-tested (`--version`, `--help`, `--smoke-test`, checksum) in CI before publication; `mise github:egon-r/oh-my-pi` installs it as `omp` on Linux hosts.
On Linux x64 hosts the same script also performs a local source build: `bun scripts/build-downstream.ts` compiles the standalone `dist/omp-linux-x64` executable plus `dist/SHA256SUMS` for installing on the build host without waiting for a tagged release. Native addons are reused from the matching upstream `@oh-my-pi/pi-natives-linux-x64` npm package with the same integrity and version-stamp checks.

The compiled version string identifies this fork. Native code is reused from the matching published upstream npm native package, with package integrity verified during the build. This release path is suitable for TypeScript changes; changes to native Rust code require building and embedding a matching custom native addon before publishing.

## Install with mise

```sh
mise install 'github:egon-r/oh-my-pi[asset_pattern=omp-macos-arm64.tar.gz,bin_path=bin]@18.16.0-egon.1'
mise exec 'github:egon-r/oh-my-pi[asset_pattern=omp-macos-arm64.tar.gz,bin_path=bin]@18.16.0-egon.1' -- omp --version
```

Installation alone does not replace your active OMP. To deliberately select it globally, remove or deactivate any competing OMP tool declaration first, then run:

```sh
mise use --global 'github:egon-r/oh-my-pi[asset_pattern=omp-macos-arm64.tar.gz,bin_path=bin]@18.16.0-egon.1'
```

Pin an exact version, especially for a freshly published release; mise's release-age filter can exclude new releases from `latest`. To upgrade, repeat with a newer published downstream version. `mise where github:egon-r/oh-my-pi` locates its installation.

## Install with Homebrew

```sh
brew install egon-r/tap/omp-egon
brew upgrade egon-r/tap/omp-egon
```

The formula installs the same `omp` executable, so it conflicts with the upstream Homebrew formula. Choose one manager and check `command -v omp` before switching. A mise-managed binary can still precede Homebrew on PATH. Neither release installation nor switching package managers changes authentication or enables the experimental local judge.

## Build, check, and publish

Bun 1.4.4 is required on every host; macOS release builds additionally need the command-line developer tools (`codesign`, `tar`):

```sh
bun install --frozen-lockfile --ignore-scripts
bun scripts/build-downstream.ts
bun test packages/coding-agent/test/judgment-chain.test.ts
bun run --cwd packages/coding-agent check:types
```

The build reuses the existing standalone compiler and native loader, generates the required embedded assets, signs the executable, and creates the release archive/checksum. The validated native addon remains as an ignored dependency for source checks; generated assets are restored and temporary staging is removed.

Publish only the clean CI build, not a workstation rebuild: Bun can embed build-host paths. Before uploading, CI runs `scripts/check-downstream-archive.py` (Python 3), enforces the two-file archive allowlist, rejects symlinks and owner/xattr leakage, and scans raw executable bytes for workstation paths and common credential formats. Upstream's synthetic `/Users/dev/` fixtures and hosted-runner paths are allowed. This is a guardrail, not an exhaustive scan of compressed executable payloads; review source and embedded docs before publishing. No home directory, credentials, sessions, databases, profiles, model weights, or dependency caches are staged.

After updating `downstream-version.txt` and the changelog, commit the change and push the matching tag:

```sh
git push origin main
git tag v18.16.0-egon.1
git push origin v18.16.0-egon.1
```

`.github/workflows/downstream.yml` builds and smoke-tests on main pushes, pull requests, and manual dispatch. Matching `v*-egon.*` tags publish the verified binary and checksum as a GitHub Release. A mismatched tag/version fails before building. Release publishing uses only GitHub's short-lived repository token; it does not need npm, cloud-storage, signing-account, or cross-repository credentials.

Standard hosted macOS and Ubuntu runners are free while this repository is public. The build job explicitly refuses private repositories rather than silently consuming private-repository minutes. Only tagged builds upload temporary Actions artifacts, retained for one day to limit storage use; tagged release assets remain available. Main/PR builds upload no artifacts. No paid/self-hosted runner is required.

The inherited `CI`, `OMP Nix`, and `Warm bun store cache` workflows are disabled in this repository's Actions settings. Keep them disabled: they belong to upstream's larger infrastructure and publishing setup. The dedicated `Egon OMP` workflow is the maintained downstream path.

After publishing, update `Formula/omp-egon.rb` in [egon-r/homebrew-tap](https://github.com/egon-r/homebrew-tap): change the version and release URL, and copy the **published archive's** SHA-256 from `SHA256SUMS`. Never use a checksum from a separate local rebuild; compiled archives may differ. The tap needs no GitHub credentials for public downloads.

## Maintenance and local judge

Keep `origin` pointed at `egon-r/oh-my-pi` and `upstream` at `can1357/oh-my-pi`. Fetch and merge upstream deliberately, resolve changes, run the downstream checks, then publish a new downstream version. Do not run upstream's `scripts/release.ts` or publish these package versions to npm.

The local-judge fix and benchmark are documented in [docs/local-models.md](docs/local-models.md). Qwen3 1.7B remains opt-in: fixing batch formatting did not establish reliable semantic judgment quality. Global model-role defaults are not changed by these releases.
