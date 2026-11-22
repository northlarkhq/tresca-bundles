// Builds one bundle from bundles.yaml:  node scripts/build.mjs <id>
// 1. checks the tag still points at the pinned commit and the licence matches;
// 2. downloads the upstream source at that commit (data only: nothing upstream is run);
// 3. checks every runtime dependency's licence;
// 4. adds manifest.json, PACKAGED-BY.md and DEPENDENCY-LICENCES.md and packs with the MCP bundle CLI;
// 5. proves every upstream file in the bundle is byte-identical, and writes the SHA-256.
// Output in out/: <id>-<version>.mcpb, SHA256SUMS, release-notes.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkDependencies, licenceReport } from "./licences.mjs";
import { ROOT, buildManifest, bundleFile, findBundle, listFiles, missingWheels, packagedBy, pinnedPython, readZip, releaseName, settingsNotFound, sha256, skillEntries, skillFile, writeZip } from "./lib.mjs";

const ADDED = ["manifest.json", "PACKAGED-BY.md", "DEPENDENCY-LICENCES.md"];

async function gh(pathname) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "tresca-bundles-build" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/${pathname}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub API ${pathname}: HTTP ${r.status}`);
  return r.json();
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function mcpb(args, cwd) {
  // The package's exports don't include package.json, so read it from node_modules (npm ci).
  const pkgFile = path.join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.mcpb;
  return run(process.execPath, [path.join(path.dirname(pkgFile), bin), ...args], { cwd });
}

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error("usage: node scripts/build.mjs <id>");
  const b = findBundle(id);
  const repo = b.upstream.replace("https://github.com/", "");
  const today = new Date().toISOString().slice(0, 10);
  const work = path.join(ROOT, "work", id);
  const out = path.join(ROOT, "out");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, "upstream"), { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  // 1. Tag and licence.
  const commit = (await gh(`repos/${repo}/commits/${encodeURIComponent(b.tag)}`)).sha;
  if (commit !== b.commit) throw new Error(`${b.tag} now points at ${commit}, bundles.yaml pins ${b.commit}`);
  const lic = await gh(`repos/${repo}/license?ref=${b.commit}`);
  if (lic.license?.spdx_id !== b.licence) throw new Error(`upstream licence is ${lic.license?.spdx_id}, bundles.yaml says ${b.licence}`);
  console.log(`${id}: ${b.tag} = ${commit}, licence ${b.licence}`);

  // 2. Source at the pinned commit.
  const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/${b.commit}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`source download: HTTP ${res.status}`);
  const tarball = path.join(work, "source.tar.gz");
  fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  run("tar", ["-xzf", tarball, "-C", path.join(work, "upstream"), "--strip-components=1"]);
  const upstreamDir = path.join(work, "upstream");
  const upstreamFiles = listFiles(upstreamDir);
  for (const f of ADDED) if (upstreamFiles.includes(f)) throw new Error(`upstream already has ${f}; packaging it unchanged isn't possible`);
  if (!upstreamFiles.includes(b.licenceFile ?? "LICENSE")) throw new Error(`upstream has no ${b.licenceFile ?? "LICENSE"}`);
  // Settings the bundle sets (server.mcp_config.env) must still exist upstream: a renamed setting would be
  // ignored silently, and a lock-down setting with it.
  const sourceTexts = upstreamFiles.filter((f) => /\.(py|js|mjs|ts)$/.test(f)).map((f) => fs.readFileSync(path.join(upstreamDir, f), "utf8"));
  const unknown = settingsNotFound(Object.keys(b.server?.mcp_config?.env ?? {}), sourceTexts);
  if (unknown.length) throw new Error(`upstream source never reads these settings the bundle sets: ${unknown.join(", ")}`);
  // The Python uv installs with (pinnedPython explains why). bundles.yaml `python` is written as .python-version.
  const pyFile = path.join(upstreamDir, ".python-version");
  const python = pinnedPython(b, upstreamFiles.includes(".python-version") ? fs.readFileSync(pyFile, "utf8") : undefined);
  const added = b.python !== undefined ? [...ADDED, ".python-version"] : ADDED;
  if (b.python !== undefined) fs.writeFileSync(pyFile, `${b.python}\n`);

  // 3. Dependency licences.
  const result = await checkDependencies(b, fs.readFileSync(path.join(upstreamDir, b.lockfile), "utf8"));
  const report = licenceReport(b, result, today);
  fs.writeFileSync(path.join(out, `${releaseName(b)}.licences.md`), report);
  const bad = result.rows.filter((r) => !r.ok);
  console.log(`${id}: ${result.rows.length} dependencies checked, ${bad.length} not allowed`);
  if (python) {
    const noWheel = missingWheels(fs.readFileSync(path.join(upstreamDir, b.lockfile), "utf8"), result.rows, python);
    if (noWheel.length) throw new Error(`no Windows wheel for Python ${python}, so uv would have to compile: ${noWheel.join(", ")}`);
    console.log(`${id}: Python ${python}, every dependency has a Windows wheel`);
  }
  if (bad.length) throw new Error(`licence check failed:\n${bad.map((r) => `  ${r.name} ${r.version}: ${r.reason} (${r.licence})`).join("\n")}`);

  // 4. Add Tresca's files and pack. Packed twice so PACKAGED-BY.md can name any files the CLI leaves out.
  fs.writeFileSync(path.join(upstreamDir, "manifest.json"), `${JSON.stringify(buildManifest(b), null, 2)}\n`);
  fs.writeFileSync(path.join(upstreamDir, "DEPENDENCY-LICENCES.md"), report);
  const file = path.join(out, bundleFile(b));
  let excluded = [];
  for (let pass = 0; pass < 2; pass++) {
    fs.writeFileSync(path.join(upstreamDir, "PACKAGED-BY.md"), packagedBy(b, excluded));
    mcpb(["validate", "manifest.json"], upstreamDir);
    fs.rmSync(file, { force: true });
    mcpb(["pack", upstreamDir, file], ROOT);
    const entries = readZip(fs.readFileSync(file));
    excluded = upstreamFiles.filter((f) => !entries.has(f));
  }

  // 5. Prove the bundle content.
  const entries = readZip(fs.readFileSync(file));
  for (const f of upstreamFiles) {
    if (!entries.has(f)) continue;
    if (sha256(entries.get(f)) !== sha256(fs.readFileSync(path.join(upstreamDir, f)))) throw new Error(`${f} differs from upstream`);
  }
  const extra = [...entries.keys()].filter((f) => !upstreamFiles.includes(f) && !added.includes(f));
  if (extra.length) throw new Error(`unexpected files in the bundle: ${extra.join(", ")}`);
  for (const f of [...added, b.licenceFile ?? "LICENSE"]) if (!entries.has(f)) throw new Error(`bundle lacks ${f}`);
  if (b.server.type === "uv" && !entries.has(b.lockfile)) throw new Error(`bundle lacks ${b.lockfile}, so uv wouldn't install the checked versions`);

  const hash = sha256(fs.readFileSync(file));

  // 6. The skill, when the project ships one: Claude Desktop can't load a skill from a .mcpb, so it goes
  // out as its own .skill file (a plain zip of the skill folder) that Tresca hands over after the bundle.
  let skill = null;
  if (b.skill) {
    const text = [
      `# Packaged by Tresca`,
      ``,
      `This Claude skill is **${b.name}**'s own skill, by ${b.author.name}, from ${b.upstream} at tag \`${b.tag}\``,
      `(commit \`${b.commit}\`), folder \`${b.skill.folder}\`, unchanged.`,
      ``,
      `Tresca added only \`${b.licenceFile ?? "LICENSE"}\` (the project's licence, ${b.licence}) and this file.`,
      `It goes with the Claude Desktop extension ${bundleFile(b)} from the same release.`,
      ``,
    ].join("\n");
    const s = skillEntries(b, upstreamDir, text);
    const skillPath = path.join(out, skillFile(b));
    fs.writeFileSync(skillPath, writeZip(s.entries));
    const back = readZip(fs.readFileSync(skillPath));
    for (const [n, data] of s.entries) if (!back.has(n) || sha256(back.get(n)) !== sha256(data)) throw new Error(`skill entry ${n} didn't survive packing`);
    if ([...back.keys()].some((n) => !n.startsWith(`${s.name}/`))) throw new Error("a skill entry sits outside its top-level folder");
    if (fs.statSync(skillPath).size > 30 * 1024 * 1024) throw new Error("the skill file is over Claude Desktop's 30 MB limit");
    skill = { file: skillFile(b), hash: sha256(fs.readFileSync(skillPath)), files: s.upstreamFiles.length };
    console.log(`${id}: ${skill.file} ${skill.hash} (${skill.files} upstream files)`);
  }

  const sums = path.join(out, "SHA256SUMS");
  const mine = [bundleFile(b), ...(skill ? [skill.file] : [])];
  const lines = (fs.existsSync(sums) ? fs.readFileSync(sums, "utf8").split("\n").filter(Boolean) : []).filter((l) => !mine.some((f) => l.endsWith(`  ${f}`)));
  fs.writeFileSync(sums, `${[...lines, `${hash}  ${bundleFile(b)}`, ...(skill ? [`${skill.hash}  ${skill.file}`] : [])].join("\n")}\n`);
  fs.writeFileSync(
    path.join(out, `${releaseName(b)}.notes.md`),
    [
      `${b.name} ${b.version} by ${b.author.name}, packaged by Tresca as a Claude Desktop extension.`,
      ``,
      `- Upstream: ${b.upstream} at \`${b.tag}\` (commit \`${b.commit}\`), unchanged. Licence: ${b.licence}.`,
      `- Added by Tresca: manifest.json, PACKAGED-BY.md, DEPENDENCY-LICENCES.md.`,
      `- ${upstreamFiles.length - excluded.length} upstream files included, each byte-identical to the upstream source.${excluded.length ? ` Left out by the bundle tool: ${excluded.join(", ")}.` : ""}`,
      `- Dependency licences: ${result.rows.length} packages checked on ${today}, all allowed (DEPENDENCY-LICENCES.md).`,
      `- SHA-256 of \`${bundleFile(b)}\`: \`${hash}\``,
      ...(skill
        ? [
            `- Skill: \`${skill.file}\`, the project's own skill (\`${b.skill.folder}\`, ${skill.files} files, unchanged) plus its licence and PACKAGED-BY.md. Claude Desktop can't load a skill from an extension, so it is a separate file. SHA-256: \`${skill.hash}\``,
          ]
        : []),
      ``,
    ].join("\n"),
  );
  console.log(`${id}: ${bundleFile(b)} ${hash} (${upstreamFiles.length - excluded.length} upstream files, ${excluded.length} left out)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
