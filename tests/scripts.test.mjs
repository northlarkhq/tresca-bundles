import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";
import { buildManifest, licenceDecision, normaliseLicence, packagedBy, readZip } from "../scripts/lib.mjs";
import { resolveNpmLock, resolveUvLock, windowsMarker } from "../scripts/licences.mjs";
import { oldEnough, setVersion } from "../scripts/upstream-check.mjs";

test("upstream tags are taken only after seven days", () => {
  const today = new Date("2026-11-21T06:00:00Z");
  assert.equal(oldEnough("2026-11-14T06:00:00Z", today), true);
  assert.equal(oldEnough("2026-11-15T06:00:00Z", today), false);
});

const ALLOWED = ["MIT", "BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "MIT-0", "PSF-2.0", "MPL-2.0"];

test("licence names from PyPI and lock files normalise to SPDX-like ids", () => {
  assert.deepEqual(normaliseLicence("MIT License"), ["MIT"]);
  assert.deepEqual(normaliseLicence("Apache Software License"), ["Apache-2.0"]);
  assert.deepEqual(normaliseLicence("Mozilla Public License 2.0 (MPL 2.0)"), ["MPL-2.0"]);
  assert.deepEqual(normaliseLicence("Apache-2.0 OR BSD-3-Clause"), ["Apache-2.0", "BSD-3-Clause"]);
  assert.deepEqual(normaliseLicence(""), []);
});

test("licence decisions follow the allowed list", () => {
  assert.equal(licenceDecision("MIT", ALLOWED).ok, true);
  assert.equal(licenceDecision("Python Software Foundation License", ALLOWED).ok, true);
  assert.equal(licenceDecision("Apache-2.0 OR BSD-3-Clause", ALLOWED).ok, true);
  assert.match(licenceDecision("AGPL-3.0", ALLOWED).reason, /copyleft/);
  assert.match(licenceDecision("LGPL-3.0-or-later", ALLOWED).reason, /copyleft/);
  assert.match(licenceDecision("", ALLOWED).reason, /unknown/);
  assert.match(licenceDecision("Proprietary", ALLOWED).reason, /not allowed/);
  // Dual licence with a permissive alternative passes.
  assert.equal(licenceDecision("GPL-2.0 OR MIT", ALLOWED).ok, true);
});

const LOCK = `version = 1

[[package]]
name = "app"
source = { editable = "." }
dependencies = [
    { name = "lib-a" },
    { name = "lib-b", extra = ["cli"] },
    { name = "lib-mac", marker = "sys_platform == 'darwin'" },
    { name = "lib-c", version = "1.0", source = { registry = "https://pypi.org/simple" }, marker = "python_full_version < '3.14'" },
    { name = "lib-c", version = "2.0", source = { registry = "https://pypi.org/simple" }, marker = "python_full_version >= '3.14'" },
]

[package.dev-dependencies]
dev = [
    { name = "pytest" },
]

[[package]]
name = "lib-a"
version = "1.2.3"

[[package]]
name = "lib-b"
version = "4.0"
dependencies = [{ name = "lib-a" }]

[package.optional-dependencies]
cli = [
    { name = "lib-cli" },
]

[[package]]
name = "lib-cli"
version = "0.1"

[[package]]
name = "lib-mac"
version = "9.9"

[[package]]
name = "lib-c"
version = "1.0"

[[package]]
name = "lib-c"
version = "2.0"

[[package]]
name = "pytest"
version = "8.0"
`;

test("uv.lock: dependencies on Windows, with extras, dev groups and every version", () => {
  const deps = resolveUvLock(LOCK, "app").map((d) => `${d.name}@${d.version}`);
  assert.deepEqual(deps, ["lib-a@1.2.3", "lib-b@4.0", "lib-c@1.0", "lib-c@2.0", "lib-cli@0.1", "pytest@8.0"]);
  assert.deepEqual(resolveUvLock(LOCK.replace(/\n/g, "\r\n"), "app").length, 6);
  assert.equal(windowsMarker("sys_platform == 'linux'"), false);
  assert.equal(windowsMarker("sys_platform == 'win32'"), true);
  assert.throws(() => resolveUvLock(LOCK, "missing"));
});

test("package-lock.json: production packages only", () => {
  const lock = JSON.stringify({ packages: { "": {}, "node_modules/a": { version: "1", license: "MIT" }, "node_modules/b": { version: "2", dev: true, license: "GPL-3.0" } } });
  assert.deepEqual(resolveNpmLock(lock), [{ name: "a", version: "1", licence: "MIT" }]);
});

const BUNDLE = {
  id: "x-mcp", name: "X MCP", upstream: "https://github.com/o/x-mcp", tag: "v1.0.0", commit: "a".repeat(40), version: "1.0.0",
  licence: "MIT", description: "Does X.", author: { name: "o" }, server: { type: "uv", entry_point: "src/x.py" },
};

test("manifest says who packaged it and keeps the project's name", () => {
  const m = buildManifest(BUNDLE);
  assert.equal(m.manifest_version, "0.4");
  assert.equal(m.display_name, "X MCP");
  assert.match(m.description, /Packaged by Tresca, unchanged from https:\/\/github.com\/o\/x-mcp v1.0.0\./);
  assert.deepEqual(m.compatibility.platforms, ["win32"]);
  assert.equal("user_config" in m, false);
  assert.match(packagedBy(BUNDLE, ["a.map"]), /left out these upstream files[\s\S]*a\.map/);
});

test("bundles.yaml in the repository loads", async () => {
  const { loadBundles } = await import("../scripts/lib.mjs");
  assert.ok(loadBundles().length >= 1);
});

test("bundles.yaml version bump changes only tag, commit and version of one entry", () => {
  const text = ["bundles:", "  - id: a", "    tag: v1 # pinned", "    commit: c1", "    version: 1", "  - id: b", "    tag: v5", "    commit: c5", "    version: 5", ""].join("\n");
  const out = setVersion(text, "a", { tag: "v2", commit: "c2", version: "2" });
  assert.equal(out, text.replace("tag: v1", "tag: v2").replace("commit: c1", "commit: c2").replace("version: 1", "version: 2"));
});

test("readZip reads entries after an appended signature block", () => {
  const raw = Buffer.from("hello");
  const data = zlib.deflateRawSync(raw);
  const name = Buffer.from("a.txt");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(name.length, 28);
  const cdLen = 46 + name.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(30 + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, central, name, eocd, Buffer.from("MCPB_SIG_V1....MCPB_SIG_END")]);
  assert.equal(readZip(zip).get("a.txt").toString(), "hello");
});
