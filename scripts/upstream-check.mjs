// Weekly: looks for a newer upstream tag for each bundle and updates bundles.yaml in place
// (tag, commit and version only; comments and everything else stay). A tag is taken only once its
// commit is at least MIN_AGE_DAYS old. The workflow builds and checks the new version, and only if
// that passes commits to main and publishes (owner decision 2026-11-21: no manual review).
//   node scripts/upstream-check.mjs            update bundles.yaml
//   node scripts/upstream-check.mjs --dry-run  only report
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadBundles } from "./lib.mjs";

async function gh(pathname) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "tresca-bundles-upstream-check" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/${pathname}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub API ${pathname}: HTTP ${r.status}`);
  return r.json();
}

export const MIN_AGE_DAYS = 7;

/** True when a release made at iso is at least `days` old on `today`. */
export function oldEnough(iso, today, days = MIN_AGE_DAYS) {
  return today.getTime() - new Date(iso).getTime() >= days * 86_400_000;
}

const versionOf = (tag) => tag.replace(/^v/i, "");
const newer = (a, b) => versionOf(a).localeCompare(versionOf(b), undefined, { numeric: true }) > 0;

/** Newest non-prerelease release tag, or the newest version-like tag when there are no releases. */
export async function latestTag(repo) {
  const releases = await gh(`repos/${repo}/releases?per_page=20`);
  const rel = releases.filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name);
  const tags = rel.length ? rel : (await gh(`repos/${repo}/tags?per_page=50`)).map((t) => t.name).filter((t) => /^v?\d+(\.\d+)*$/.test(t));
  return tags.sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0];
}

/** Replaces tag, commit and version inside one entry of bundles.yaml text. */
export function setVersion(text, id, { tag, commit, version }) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^  - id: ${id}\\s*$`).test(l));
  if (start < 0) throw new Error(`bundles.yaml: no entry ${id}`);
  let end = lines.findIndex((l, i) => i > start && /^  - id: /.test(l));
  if (end < 0) end = lines.length;
  const set = (key, value) => {
    const i = lines.slice(start, end).findIndex((l) => new RegExp(`^    ${key}: `).test(l));
    if (i < 0) throw new Error(`bundles.yaml: ${id} has no ${key}`);
    lines[start + i] = lines[start + i].replace(new RegExp(`^(    ${key}: )\\S+`), `$1${value}`);
  };
  set("tag", tag);
  set("commit", commit);
  set("version", version);
  // A new upstream version is a first packaging again.
  const r = lines.slice(start, end).findIndex((l) => /^    revision: /.test(l));
  if (r >= 0) lines.splice(start + r, 1);
  return lines.join("\n");
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const file = path.join(ROOT, "bundles.yaml");
  let text = fs.readFileSync(file, "utf8");
  const changed = [];
  for (const b of loadBundles()) {
    const repo = b.upstream.replace("https://github.com/", "");
    const tag = await latestTag(repo);
    if (!tag || !newer(tag, b.tag)) {
      console.log(`${b.id}: ${b.tag} is current`);
      continue;
    }
    const c = await gh(`repos/${repo}/commits/${encodeURIComponent(tag)}`);
    const date = c.commit?.committer?.date ?? c.commit?.author?.date;
    if (!date || !oldEnough(date, new Date())) {
      console.log(`${b.id}: ${tag} (${date ?? "no date"}) is newer than ${MIN_AGE_DAYS} days; waiting`);
      continue;
    }
    console.log(`${b.id}: ${b.tag} -> ${tag} (${c.sha}, ${date})`);
    text = setVersion(text, b.id, { tag, commit: c.sha, version: versionOf(tag) });
    changed.push({ id: b.id, from: b.tag, to: tag });
  }
  if (!dry && changed.length) fs.writeFileSync(file, text);
  if (process.env.GITHUB_OUTPUT) {
    const summary = changed.map((x) => `${x.id} ${x.from} -> ${x.to}`).join("; ");
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length ? "true" : "false"}\nids=${changed.map((x) => x.id).join(" ")}\nsummary=${summary}\n`);
  }
}

// Run only when started directly, so tests can import the helpers.
if (process.argv[1]?.endsWith("upstream-check.mjs")) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
