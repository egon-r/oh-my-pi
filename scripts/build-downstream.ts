#!/usr/bin/env bun
/**
 * macOS arm64 downstream release. Requires Bun 1.4.4, installed workspace
 * dependencies (bun install --frozen-lockfile --ignore-scripts), Xcode command
 * line tools (codesign, tar), and HTTPS access to registry.npmjs.org when the
 * matching native addon is not already provisioned. No Rust toolchain needed.
 * Outputs dist/omp-macos-arm64.tar.gz (bin/omp, LICENSE) and dist/SHA256SUMS.
 * Source metadata/native versions are never bumped; all overrides are build-local.
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
const addonName = "pi_natives.darwin-arm64.node";
const addonPath = path.join(root, "packages/natives/native", addonName);

async function run(command: string[], cwd = root): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
}

async function fetchChecked(url: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
	return response;
}

async function provisionNative(version: string, temporary: string): Promise<void> {
	let existing: Buffer | undefined;
	try {
		existing = await fs.readFile(addonPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing) {
		if (!containsVersionStamp(existing, version) && !containsLegacyVersionSentinel(existing, version)) {
			throw new Error(
				`Existing ${addonPath} does not match upstream ${version}; provision the matching addon first`,
			);
		}
		return;
	}
	const packageName = "@oh-my-pi/pi-natives-darwin-arm64";
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
	await run(["tar", "-xzf", tarball, "-C", temporary, `package/${addonName}`]);
	const addon = await fs.readFile(path.join(temporary, "package", addonName));
	if (!containsVersionStamp(addon, version) && !containsLegacyVersionSentinel(addon, version)) {
		throw new Error("Downloaded native addon lacks matching upstream version stamp");
	}
	// Keep this validated, ignored dependency for subsequent source tests.
	// Exclusive creation never clobbers an addon installed by another process.
	await fs.writeFile(addonPath, addon, { flag: "wx" });
}

async function main(): Promise<void> {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("Downstream releases require a native macOS arm64 host");
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
		await provisionNative(upstream, temporary);
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
			native: { platform: "darwin", arch: "arm64" },
			target: "bun-darwin-arm64",
			minifyIdentifiers: true,
			skipBuiltinCodesign: true,
			files: {
				[utilsManifestPath]: JSON.stringify({ ...utilsManifest, version }),
				[updatePath]: managedSource,
				[path.join(root, "packages/coding-agent/src/export/html/viewer.generated.json")]:
					JSON.stringify(viewerMetadata),
			},
		});
		await run([
			"codesign",
			"--force",
			"--sign",
			"-",
			"--entitlements",
			path.join(root, "scripts/macos-entitlements.plist"),
			outfile,
		]);
		await fs.chmod(outfile, 0o755);
		await fs.copyFile(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
		const dist = path.join(root, "dist");
		await fs.mkdir(dist, { recursive: true });
		const archiveName = "omp-macos-arm64.tar.gz";
		const archive = path.join(temporary, archiveName);
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
			archive,
			"-C",
			stage,
			"bin/omp",
			"LICENSE",
		]);
		const digest = createHash("sha256")
			.update(await fs.readFile(archive))
			.digest("hex");
		await fs.copyFile(archive, path.join(dist, archiveName));
		await fs.writeFile(path.join(dist, "SHA256SUMS"), `${digest}  ${archiveName}\n`);
		console.log(`Built ${version}: dist/${archiveName} and dist/SHA256SUMS`);
	} finally {
		try {
			if (originalStats !== undefined) await fs.writeFile(statsPath, originalStats);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}
}

await main();
