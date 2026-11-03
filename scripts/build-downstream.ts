#!/usr/bin/env bun
/**
 * Downstream release build for the native host: macOS arm64 release archives
 * and Linux x64 local builds. Requires Bun 1.4.4, installed workspace
 * dependencies (bun install --frozen-lockfile --ignore-scripts), Xcode command
 * line tools on macOS (codesign, tar), and HTTPS access to registry.npmjs.org
 * when the matching native addon is not already provisioned. No Rust toolchain
 * needed. macOS outputs dist/omp-macos-arm64.tar.gz (bin/omp, LICENSE) and
 * dist/SHA256SUMS; Linux outputs the unsigned dist/omp-linux-x64 executable
 * and dist/SHA256SUMS for local installation (no release archive, no publish).
 * Source metadata/native versions are never bumped; all overrides are
 * build-local.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { buildExportViewer } from "../packages/collab-web/scripts/build-export-viewer";
import { containsLegacyVersionSentinel, containsVersionStamp } from "../packages/natives/native/version-sentinel.js";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";

const root = path.resolve(import.meta.dir, "..");
interface DownstreamHost {
	platform: "darwin" | "linux";
	arch: "arm64" | "x64";
	addonNames: string[];
	nativePackage: string;
	target: Bun.Build.CompileTarget;
}

/** Host platforms whose upstream native leaf package this script reuses. */
function downstreamHost(): DownstreamHost | null {
	if (process.platform === "darwin" && process.arch === "arm64") {
		return {
			platform: "darwin",
			arch: "arm64",
			addonNames: ["pi_natives.darwin-arm64.node"],
			nativePackage: "@oh-my-pi/pi-natives-darwin-arm64",
			target: "bun-darwin-arm64",
		};
	}
	if (process.platform === "linux" && process.arch === "x64") {
		return {
			platform: "linux",
			arch: "x64",
			addonNames: ["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"],
			nativePackage: "@oh-my-pi/pi-natives-linux-x64",
			target: "bun-linux-x64",
		};
	}
	return null;
}

async function run(command: string[], cwd = root): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

async function fetchChecked(url: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
	return response;
}

async function provisionNative(host: DownstreamHost, version: string, temporary: string): Promise<void> {
	const addonPaths = host.addonNames.map(name => path.join(root, "packages/natives/native", name));
	const missing: string[] = [];
	for (const [index, addonPath] of addonPaths.entries()) {
		let existing: Buffer | undefined;
		try {
			existing = await fs.readFile(addonPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!existing) {
			missing.push(host.addonNames[index]);
			continue;
		}
		if (!containsVersionStamp(existing, version) && !containsLegacyVersionSentinel(existing, version)) {
			throw new Error(
				`Existing ${addonPath} does not match upstream ${version}; provision the matching addon first`,
			);
		}
	}
	if (missing.length === 0) return;
	const packageName = host.nativePackage;
	const manifest = (await (
		await fetchChecked(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`)
	).json()) as {
		name: string;
		version: string;
		dist: { tarball: string; integrity: string };
	};
	if (manifest.name !== packageName || manifest.version !== version)
		throw new Error("Unexpected native registry manifest");
	const tarballUrl = new URL(manifest.dist.tarball);
	if (tarballUrl.protocol !== "https:" || tarballUrl.hostname !== "registry.npmjs.org")
		throw new Error("Unexpected native tarball origin");
	const integrity = manifest.dist.integrity?.split(/\s+/).find(value => value.startsWith("sha512-"));
	if (!integrity) throw new Error("Native registry manifest lacks SHA-512 integrity");
	const bytes = Buffer.from(await (await fetchChecked(tarballUrl.href)).arrayBuffer());
	const expected = Buffer.from(integrity.slice("sha512-".length), "base64");
	const actual = createHash("sha512").update(bytes).digest();
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		throw new Error("Native tarball integrity mismatch");
	const tarball = path.join(temporary, "native.tgz");
	await fs.writeFile(tarball, bytes);
	for (const addonName of missing) {
		await run(["tar", "-xzf", tarball, "-C", temporary, `package/${addonName}`]);
		const addon = await fs.readFile(path.join(temporary, "package", addonName));
		if (!containsVersionStamp(addon, version) && !containsLegacyVersionSentinel(addon, version)) {
			throw new Error("Downloaded native addon lacks matching upstream version stamp");
		}
		// Keep this validated, ignored dependency for subsequent source tests.
		// Exclusive creation never clobbers an addon installed by another process.
		await fs.writeFile(addonPaths[host.addonNames.indexOf(addonName)], addon, { flag: "wx" });
	}
}

async function main(): Promise<void> {
	const host = downstreamHost();
	if (!host) throw new Error("Downstream builds require a native macOS arm64 or Linux x64 host");
	if (Bun.version !== "1.4.4") throw new Error(`Expected Bun 1.4.4, got ${Bun.version}; select it with mise`);
	// The compiler embeds docs/**/*.md. Refuse local-only or edited docs so
	// workstation notes cannot accidentally enter a public release binary.
	await run(["git", "diff", "--quiet", "HEAD", "--", "docs"]);
	const extraDocs = Bun.spawn(["git", "ls-files", "--others", "-z", "--", "docs"], {
		cwd: root,
		stdout: "pipe",
		stderr: "inherit",
	});
	const extraDocPaths = (await new Response(extraDocs.stdout).text()).split("\0").filter(file => file.endsWith(".md"));
	if ((await extraDocs.exited) !== 0) throw new Error("Unable to inspect release documentation inputs");
	if (extraDocPaths.length) throw new Error(`Refusing to embed untracked documentation: ${extraDocPaths.join(", ")}`);
	const utilsManifestPath = path.join(root, "packages/utils/package.json");
	const utilsManifest = await Bun.file(utilsManifestPath).json();
	const nativeManifest = await Bun.file(path.join(root, "packages/natives/package.json")).json();
	const upstream = utilsManifest.version as string;
	const version = (await Bun.file(path.join(root, "downstream-version.txt")).text()).trim();
	if (
		!/^\d+\.\d+\.\d+$/.test(upstream) ||
		!version.startsWith(`${upstream}-egon.`) ||
		!/^[0-9]+\.[0-9]+\.[0-9]+-egon\.[1-9][0-9]*$/.test(version)
	) {
		throw new Error(`downstream-version.txt must be ${upstream}-egon.N (positive integer N)`);
	}
	if (nativeManifest.version !== upstream) throw new Error("Native and agent upstream versions differ");
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-downstream-"));
	const statsPath = path.join(root, "packages/stats/src/embedded-client.generated.txt");
	let originalStats: Buffer | undefined;
	try {
		await provisionNative(host, upstream, temporary);
		originalStats = await fs.readFile(statsPath);
		await run([process.execPath, "run", "gen:stats"]);
		const viewerMetadata = await buildExportViewer({ outDir: path.join(temporary, "export-assets") });
		const updatePath = path.join(root, "packages/coding-agent/src/cli/update-cli.ts");
		const updateSource = await fs.readFile(updatePath, "utf8");
		const managerSignature =
			"export async function managedInstallName(binaryPath: string): Promise<string | undefined> {";
		if (updateSource.split(managerSignature).length !== 2)
			throw new Error("Upstream managed-install boundary changed; review downstream updater policy");
		// Every downstream binary, including manually extracted archives, must use
		// the supported manager-owned update path rather than public upstream.
		const managedSource = updateSource.replace(
			managerSignature,
			`${managerSignature}\n\treturn "egon downstream releases (https://github.com/egon-r/oh-my-pi/releases)";`,
		);
		const require = createRequire(import.meta.url);
		const transformersVersion = require("@huggingface/transformers/package.json").version;
		if (typeof transformersVersion !== "string") throw new Error("Missing Transformers.js version");
		const stage = path.join(temporary, "stage");
		await fs.mkdir(path.join(stage, "bin"), { recursive: true });
		const outfile = path.join(stage, "bin/omp");
		await compileCodingAgent({
			repoRoot: root,
			entrypoint: path.join(root, "packages/coding-agent/src/cli.ts"),
			outfile,
			transformersVersion,
			native: { platform: host.platform, arch: host.arch },
			target: host.target,
			minifyIdentifiers: true,
			skipBuiltinCodesign: host.platform === "darwin",
			files: {
				[utilsManifestPath]: JSON.stringify({ ...utilsManifest, version }),
				[updatePath]: managedSource,
				[path.join(root, "packages/coding-agent/src/export/html/viewer.generated.json")]:
					JSON.stringify(viewerMetadata),
			},
		});
		if (host.platform === "darwin") {
			await run([
				"codesign",
				"--force",
				"--sign",
				"-",
				"--entitlements",
				path.join(root, "scripts/macos-entitlements.plist"),
				outfile,
			]);
		}
		await fs.chmod(outfile, 0o755);
		const dist = path.join(root, "dist");
		await fs.mkdir(dist, { recursive: true });
		let artifactName: string;
		let artifactPath: string;
		if (host.platform === "darwin") {
			await fs.copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
			artifactName = "omp-macos-arm64.tar.gz";
			artifactPath = path.join(temporary, artifactName);
			await run([
				"tar",
				"--uid",
				"0",
				"--gid",
				"0",
				"--uname",
				"root",
				"--gname",
				"root",
				"--no-xattrs",
				"--no-acls",
				"--disable-copyfile",
				"-czf",
				artifactPath,
				"-C",
				stage,
				"bin/omp",
				"LICENSE",
			]);
		} else {
			// Local Linux build: ship the standalone executable itself, no release archive.
			artifactName = "omp-linux-x64";
			artifactPath = path.join(stage, "bin/omp");
		}
		const digest = createHash("sha256")
			.update(await fs.readFile(artifactPath))
			.digest("hex");
		await fs.copyFile(artifactPath, path.join(dist, artifactName));
		await fs.writeFile(path.join(dist, "SHA256SUMS"), `${digest}  ${artifactName}\n`);
		console.log(`Built ${version}: dist/${artifactName} and dist/SHA256SUMS`);
	} finally {
		try {
			if (originalStats !== undefined) await fs.writeFile(statsPath, originalStats);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}
}

await main();
