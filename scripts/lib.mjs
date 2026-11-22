// Shared helpers for the build, the licence check and the upstream check.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadYaml(file) {
  return YAML.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

const REQUIRED = ["id", "name", "upstream", "tag", "commit", "version", "licence", "ecosystem", "lockfile", "lockRoot", "description", "author", "server"];

/** bundles.yaml, checked. */
export function loadBundles() {
  const data = loadYaml("bundles.yaml");
  const list = data?.bundles ?? [];
  const ids = new Set();
  for (const b of list) {
    for (const k of REQUIRED) if (b[k] === undefined) throw new Error(`bundles.yaml: ${b.id ?? "?"} has no ${k}`);
    if (!/^[a-z0-9-]+$/.test(b.id)) throw new Error(`bundles.yaml: bad id ${b.id}`);
    if (ids.has(b.id)) throw new Error(`bundles.yaml: ${b.id} is listed twice`);
    ids.add(b.id);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(b.upstream)) throw new Error(`bundles.yaml: ${b.id} upstream must be https://github.com/owner/repo`);
    if (!/^[0-9a-f]{40}$/.test(b.commit)) throw new Error(`bundles.yaml: ${b.id} commit must be a full 40-character SHA`);
  }
  return list;
}

export function findBundle(id) {
  const b = loadBundles().find((x) => x.id === id);
  if (!b) throw new Error(`no bundle "${id}" in bundles.yaml`);
  return b;
}

export const releaseName = (b) => `${b.id}-${b.version}`;
export const bundleFile = (b) => `${b.id}-${b.version}.mcpb`;

// ---- Licences -------------------------------------------------------------

const ALIASES = [
  [/^mit(-0)?$/i, (m) => (m[1] ? "MIT-0" : "MIT")],
  [/^mit license$/i, () => "MIT"],
  [/^mit no attribution$/i, () => "MIT-0"],
  [/^bsd license$/i, () => "BSD"],
  [/^bsd-([23])-clause$/i, (m) => `BSD-${m[1]}-Clause`],
  [/^(apache-2\.0|apache software license|apache license,? version 2\.0)$/i, () => "Apache-2.0"],
  [/^isc( license \(iscl\)| license)?$/i, () => "ISC"],
  [/^(psf-2\.0|python software foundation license)$/i, () => "PSF-2.0"],
  [/^(mpl-2\.0|mozilla public license 2\.0 \(mpl 2\.0\))$/i, () => "MPL-2.0"],
  [/^(the )?unlicense( \(unlicense\))?$/i, () => "Unlicense"],
];

const alias = (p) => {
  const t = p.trim();
  for (const [re, f] of ALIASES) {
    const m = t.match(re);
    if (m) return f(m);
  }
  return t;
};

/** A licence string from PyPI or a lock file as alternatives ("A OR B"), each a list of ids that all apply
 * ("A AND B": a package whose files carry several licences, such as numpy). */
export function licenceAlternatives(raw) {
  const text = String(raw ?? "").trim();
  if (!text || /^unknown$/i.test(text)) return [];
  const inner = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1) : text;
  // "(A AND B) OR C": brackets only around a whole alternative are grouping; others belong to a name such
  // as "Mozilla Public License 2.0 (MPL 2.0)".
  const group = (alt) => (/^\(.*\)$/.test(alt.trim()) && /\s+AND\s+/.test(alt) ? alt.trim().slice(1, -1) : alt);
  return inner.split(/\s+OR\s+|\s+\/\s+/).map((alt) => group(alt).split(/\s+AND\s+/).map(alias));
}

/** A licence string as SPDX-like ids, alternatives joined with " AND " where all parts apply. */
export function normaliseLicence(raw) {
  return licenceAlternatives(raw).map((parts) => parts.join(" AND "));
}

/** allowed: SPDX-like ids from licences.yaml. A package passes when, for one alternative, every licence that
 * applies ("A AND B") is allowed. */
export function licenceDecision(raw, allowed) {
  const alts = licenceAlternatives(raw);
  if (!alts.length) return { ok: false, reason: "unknown licence" };
  const shown = alts.map((parts) => parts.join(" AND ")).join(" OR ");
  const hit = alts.find((parts) => parts.every((id) => allowed.includes(id)));
  if (hit) return { ok: true, licence: hit.join(" AND ") };
  if (alts.some((parts) => parts.some((id) => /GPL/i.test(id)))) return { ok: false, reason: `copyleft: ${shown}` };
  return { ok: false, reason: `not allowed: ${shown}` };
}

/** Environment settings the bundle sets that no upstream source file names (as a quoted string), so the
 * server would ignore them. */
export function settingsNotFound(keys, sourceTexts) {
  return keys.filter((k) => !sourceTexts.some((t) => t.includes(`"${k}"`) || t.includes(`'${k}'`)));
}

// ---- Manifest ---------------------------------------------------------------

/** The manifest.json Tresca adds to an upstream tree. Every value comes from bundles.yaml. */
export function buildManifest(b) {
  const manifest = {
    manifest_version: b.server.type === "uv" ? "0.4" : "0.3",
    name: b.id,
    display_name: b.name,
    version: b.version,
    description: `${b.description} Packaged by Tresca, unchanged from ${b.upstream} ${b.tag}.`,
    author: b.author,
    repository: { type: "git", url: b.upstream },
    homepage: b.upstream,
    license: b.licence,
    server: b.server,
    compatibility: b.compatibility ?? { platforms: ["win32"] },
  };
  if (b.user_config && Object.keys(b.user_config).length) manifest.user_config = b.user_config;
  return manifest;
}

export function packagedBy(b, excluded) {
  return [
    `# Packaged by Tresca`,
    ``,
    `This Claude Desktop extension contains **${b.name}** by ${b.author.name}, from`,
    `${b.upstream} at tag \`${b.tag}\` (commit \`${b.commit}\`), unchanged.`,
    ``,
    `Tresca added only these files: \`manifest.json\`, \`PACKAGED-BY.md\` and \`DEPENDENCY-LICENCES.md\`.`,
    `The project's own licence is in \`${b.licenceFile ?? "LICENSE"}\` (${b.licence}).`,
    ...(excluded.length ? [``, `The MCP bundle tool left out these upstream files:`, ``, ...excluded.map((f) => `- \`${f}\``)] : []),
    ``,
    `Built by ${"https://github.com/northlarkhq/tresca-bundles"} from \`bundles.yaml\`. Report problems with the`,
    `project itself to ${b.upstream}/issues.`,
    ``,
  ].join("\n");
}

// ---- Files ------------------------------------------------------------------

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

/** All entries of a zip held in memory (handles a signature block appended after the archive). */
export function readZip(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
    if (!name.endsWith("/")) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
