# tresca-bundles

Claude Desktop extensions (`.mcpb` files) that Tresca packages from open-source projects for engineering software. Each one is the project's tagged source, unchanged, plus three files Tresca adds:

- `manifest.json`, which tells Claude Desktop how to run the server;
- `PACKAGED-BY.md`, which names the upstream project, tag and commit;
- `DEPENDENCY-LICENCES.md`, which lists every package the server runs with and its licence.

The project's own `LICENSE` (and `NOTICE`, if it has one) is part of the unchanged source.

Bundles are published as GitHub Releases named `{id}-{version}`, each with the `.mcpb`, its SHA-256 and the licence list. The Tresca for Windows app downloads them only from here and checks the SHA-256 before handing the file to Claude Desktop.

## Rules

- **Licences:** permissive only, for the project and every dependency it runs with. The list is in `licences.yaml`. A GPL-family or unknown licence stops the bundle.
- **Unchanged:** the build downloads the source at the commit pinned in `bundles.yaml`. It checks that the tag still points at that commit, then checks that each upstream file in the `.mcpb` is byte-identical to the source. Any file the bundle tool leaves out is named in `PACKAGED-BY.md` and in the release notes.
- **Names:** a bundle keeps the project's own name. Its description says "Packaged by Tresca". There are no vendor names or logos as branding.
- **Nothing runs at build time:** upstream code is read as data. It is never installed or run here.

## How it works

| File | What it does |
|---|---|
| `bundles.yaml` | Each project: upstream repository, tag and commit, licence, and the manifest settings to declare |
| `licences.yaml` | Allowed licences, and per-package licence overrides with their sources |
| `scripts/build.mjs` | Builds and checks one bundle: `npm run build -- <id>` |
| `scripts/upstream-check.mjs` | Looks for newer upstream tags and updates `bundles.yaml` |
| `.github/workflows/build.yml` | On every push and pull request: tests and builds. On `main`: publishes a release for each new `{id}-{version}` |
| `.github/workflows/upstream-check.yml` | Weekly: takes a newer upstream tag once it is at least 7 days old, builds and checks it, and only if that passes commits it to `main` and publishes the release |

To add a project, add an entry to `bundles.yaml` and open a pull request. The build checks it.

## Problems

For a problem with a project itself, open an issue in that project's repository. For a problem with the packaging, open an issue here.
