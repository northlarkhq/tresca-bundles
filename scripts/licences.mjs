// Dependency licence check: resolves the runtime dependencies from the upstream lock file at the
// pinned commit (Windows only), looks up each licence and compares it with licences.yaml.
// Reads files as data; never installs or runs upstream code.
import { licenceDecision, loadYaml } from "./lib.mjs";

const PACKAGE_RE = /\{ name = "([^"]+)"(?:, version = "[^"]+")?(?:, source = \{[^}]*\})?(?:, extra = \[([^\]]*)\])?(?:, marker = "([^"]*)")?/g;
const parseDeps = (s) => [...(s ?? "").matchAll(PACKAGE_RE)].map((m) => ({ name: m[1], extras: (m[2] || "").replace(/"/g, "").split(",").map((x) => x.trim()).filter(Boolean), marker: m[3] || "" }));

/** True unless the marker limits the dependency to another platform. */
export function windowsMarker(marker) {
  return !/sys_platform == '(linux|darwin)'|platform_system == '(Linux|Darwin)'|sys_platform != 'win32'|platform_system != 'Windows'/.test(marker);
}

/** Runtime packages (name, version) from a uv.lock, walking from the root package with extras. */
export function resolveUvLock(text, root) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\[\[package\]\]\n/).slice(1);
  const pkgs = new Map();
  for (const b of blocks) {
    const name = b.match(/^name = "([^"]+)"/m)?.[1];
    const version = b.match(/^version = "([^"]+)"/m)?.[1];
    const deps = parseDeps(b.match(/^dependencies = \[([\s\S]*?)\n\]/m)?.[1] ?? b.match(/^dependencies = \[(.*)\]$/m)?.[1]);
    const optional = {};
    const opt = b.match(/\[package\.optional-dependencies\]\n([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
    for (const m of opt.matchAll(/^([\w-]+) = \[([\s\S]*?)\n?\]$/gm)) optional[m[1]] = parseDeps(m[2]);
    // A package can appear in several versions (python-version markers); every one is checked.
    pkgs.set(name, [...(pkgs.get(name) ?? []), { version, deps, optional }]);
  }
  if (!pkgs.has(root)) throw new Error(`uv.lock has no package "${root}"`);
  const seen = new Map();
  const walk = (name, extras) => {
    const variants = pkgs.get(name);
    if (!variants) throw new Error(`uv.lock: dependency "${name}" not found`);
    const had = seen.get(name);
    const fresh = !had || extras.some((e) => !had.has(e));
    const set = had ?? new Set();
    extras.forEach((e) => set.add(e));
    seen.set(name, set);
    if (!fresh) return;
    for (const p of variants) {
      for (const d of p.deps) if (windowsMarker(d.marker)) walk(d.name, d.extras);
      for (const e of extras) for (const d of p.optional[e] ?? []) if (windowsMarker(d.marker)) walk(d.name, d.extras);
    }
  };
  walk(root, []);
  seen.delete(root);
  return [...seen.keys()].sort().flatMap((name) => pkgs.get(name).map((v) => ({ name, version: v.version })));
}

/** Runtime packages from an npm package-lock.json (v2/v3), with the licence the lock records. */
export function resolveNpmLock(text) {
  const lock = JSON.parse(text);
  return Object.entries(lock.packages ?? {})
    .filter(([p, v]) => p && !v.dev && !v.devOptional)
    .map(([p, v]) => ({ name: p.replace(/^.*node_modules\//, ""), version: v.version, licence: v.license ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function pypiLicence(name, version) {
  const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return { licence: "", source: `PyPI HTTP ${r.status}` };
  const i = (await r.json()).info;
  const classifiers = (i.classifiers ?? []).filter((c) => c.startsWith("License ::") && !/OSI Approved$/.test(c)).map((c) => c.split(" :: ").pop());
  const licence = i.license_expression || (classifiers.length ? classifiers.join(" OR ") : "") || ((i.license ?? "").length < 40 ? i.license ?? "" : "");
  return { licence, source: `https://pypi.org/project/${name}/${version}/` };
}

/** Checks every runtime dependency. Returns rows and whether all pass. */
export async function checkDependencies(bundle, lockText) {
  const policy = loadYaml("licences.yaml");
  const overrides = new Map((policy.overrides ?? []).map((o) => [o.package.toLowerCase(), o]));
  const deps = bundle.ecosystem === "pypi" ? resolveUvLock(lockText, bundle.lockRoot) : resolveNpmLock(lockText);
  const rows = [];
  for (const d of deps) {
    let { licence, source } = bundle.ecosystem === "pypi" ? await pypiLicence(d.name, d.version) : { licence: d.licence, source: "package-lock.json" };
    const o = overrides.get(d.name.toLowerCase());
    if (!licenceDecision(licence, policy.allowed).ok && o) ({ licence, source } = { licence: o.licence, source: `${o.sourceUrl} (checked ${o.checkedOn})` });
    rows.push({ ...d, licence: licence || "unknown", source, ...licenceDecision(licence, policy.allowed) });
  }
  return { rows, ok: rows.every((r) => r.ok) };
}

export function licenceReport(bundle, result, date) {
  const lines = [
    `# Dependency licences`,
    ``,
    `${bundle.name} ${bundle.version} (${bundle.upstream}, commit \`${bundle.commit}\`) runs with these packages on Windows,`,
    `resolved from its \`${bundle.lockfile}\`. Checked ${date} against Tresca's licence policy`,
    `(https://github.com/northlarkhq/tresca-bundles/blob/main/licences.yaml).`,
    bundle.server?.type === "uv" ? `\nThey aren't inside this bundle: Claude Desktop installs them with uv when you add the extension.\n` : ``,
    `| Package | Version | Licence | Source | Result |`,
    `|---|---|---|---|---|`,
    ...result.rows.map((r) => `| ${r.name} | ${r.version ?? ""} | ${r.licence} | ${r.source} | ${r.ok ? "allowed" : r.reason} |`),
    ``,
  ];
  return lines.join("\n");
}
