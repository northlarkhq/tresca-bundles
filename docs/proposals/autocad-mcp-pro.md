# Proposal: package AutoCAD MCP Pro

Status: **proposal, for the owner's decision** (2026-11-22). Nothing is added to `bundles.yaml` until the
decisions below are made.

## Recommendation

Package **AutoCAD MCP Pro** (`U-C4N/Autocad-MCP`) as the first AutoCAD bundle, **locked down**: no
raw-command or LISP tools, no destructive tools, file access limited to one folder the user chooses, and an
optional read-only mode. Do it only after the five licence decisions in section 4 and the two checks in
section 6.

It is the most mature of the community AutoCAD MCP servers we reviewed. It is still a one-person project,
tested by hand on AutoCAD 2026 only, so the catalogue listing must say so.

## 1. The project (from its own files at tag `v1.8.0`)

| | |
|---|---|
| Upstream | https://github.com/U-C4N/Autocad-MCP |
| Tag and commit | `v1.8.0` → `6f6a538255ca9f885232e845ac32f10b4433fe3e` (2026-11-06) |
| Licence | MIT (`LICENSE`: "Copyright (c) 2026 Umutcan Edizsalan"); `pyproject.toml` `license = "MIT"` |
| Language and runtime | Python, `requires-python = ">=3.11"`; lock file `uv.lock` |
| Entry point | `pyproject.toml` `[project.scripts]`: `autocad-mcp = "server:main"` |
| Engines | Live AutoCAD through COM (Windows, needs the `com` extra: `pywin32`, `Pillow`); headless DXF through `ezdxf` |
| AutoCAD versions | Live paths tested by hand on one AutoCAD 2026 seat; BricsCAD, ZWCAD and GstarCAD marked "UNVERIFIED" |

## 2. Why this one

A code review on 2026-11-22 compared it with three other community AutoCAD MCP servers (puran-water,
daobataotie, AnCode666). The code was read, not run.

**Strengths**
- **Tests:** about 4,700 automated test functions. AutoCAD itself is simulated (fake COM) in them.
- **CI:** ruff lint and pytest on Ubuntu and Windows. Green at the tag.
- **Releases:** 7 versioned releases (v1.3.0 to v1.8.0, about monthly), a `CHANGELOG.md`, and PyPI releases published from tags.
- **Undo and recovery:** transactions, checkpoints and a durable journal.
- **AutoCAD failures:** handles a busy AutoCAD (message filter) and has per-call time limits.
- **Lock-down controls:** `READ_ONLY`, `MAX_TOOL_COST`, `ALLOWED_PATHS`, and tool allow and deny lists.

**Weaknesses**
- **One person:** one maintainer wrote all 518 commits, and no outside pull request has been merged. Nothing new has been answered since 2026-11-06.
- **Permissive defaults:** raw-command and LISP tools are on, every folder is allowed, and the guards are described by the author as "a guardrail, NOT a security boundary". Issue #23 reports a LISP-check bypass.
- **Open bugs:** two clients on one AutoCAD take over each other's drawing (#28); a timeout leaves a worker stuck (#27); a dimension tolerance loses its minus sign (#24).
- **Claims beyond the evidence:** `pyproject.toml` calls it "Production/Stable" and the README "Production-grade". Tresca does not repeat either claim.

The other three are earlier-stage: no releases, and two have no tests or CI. Their raw-command paths are
unguarded, and one sends requests to AutoCAD through unauthenticated files in `C:\temp`.

## 3. Proposed bundle settings

The server reads its settings from environment variables only (`config.py`: `os.environ.get(...)`;
`ALLOWED_PATHS` is split on commas). The bundle fixes the risky ones and lets the user choose two.

**Fixed in the manifest's `env`:**

| Variable | Value | Why |
|---|---|---|
| `MAX_TOOL_COST` | `mutate` | Allows reading and normal edits. Removes the `destructive` and `escape` tiers, so `system_run_command` and `system_run_lisp` aren't offered. Tiers come from `policy.py`: `read < safe < mutate < destructive < escape` |
| `DANGEROUS_COMMANDS_ENABLED` | `false` | Already the default; kept explicit |
| `CAD_LAUNCH` | `never` | Works only in the AutoCAD session the user opened; never starts one (README "#19") |
| `AUTOCAD_MCP_BACKEND` | `auto` | Live AutoCAD when it's running, else headless DXF |
| `DISCOVERY_MODE` | `search` | The default since 1.8.0. Offers three discovery tools instead of 240, which keeps Claude Desktop's tool list small |

**Chosen by the user (`user_config`):**

| Setting | Type | Passed as | Notes |
|---|---|---|---|
| Project folder | `directory`, required, no default | `ALLOWED_PATHS` | Reads and writes stay inside it. One folder, because how Claude Desktop passes a `directory_list` in an environment variable isn't documented (see section 6) |
| Read only | `boolean`, default `false` | `READ_ONLY` | Only `read` tools run and no file is written |

**Server** (uv type, like FreeCAD MCP):

```yaml
server:
  type: uv
  entry_point: server.py
  mcp_config:
    command: uv
    args: [run, --directory, "${__dirname}", --extra, com, --extra, pdf, autocad-mcp]
```

`--extra com` is needed for live AutoCAD. `--extra pdf` (matplotlib) is needed for any rendering. The `office`
extra (openpyxl, XLSX takeoffs) is optional. Without it the server writes CSV.

**Description:** not the upstream description ("Production-grade AutoCAD MCP server …"), because Tresca
never says "production". Proposed: the README's second line, "Live through COM on Windows, or headless
through ezdxf anywhere", plus "Packaged by Tresca". This needs the owner's OK, because `bundles.yaml`
otherwise takes descriptions unchanged from the upstream files.

## 4. Licence check (first pass, needs decisions)

All 96 packages in `uv.lock` were checked against PyPI metadata on 2026-11-22. The dev group (pytest,
ruff and others) is included, because Claude Desktop installs dev groups too (see the FreeCAD MCP entry).
The project and almost everything else is MIT, BSD, Apache-2.0, ISC, PSF-2.0 or MIT-0. `certifi` is
MPL-2.0, which is allowed when used unmodified.

**Not on `licences.yaml`'s allowed list; all permissive; each needs an owner decision:**

| Package | Licence (PyPI) | Needed for | Decision |
|---|---|---|---|
| `pillow` 12.3.0 | MIT-CMU (HPND-style) | Every render path, and the COM screenshot. Required by the `com` and `pdf` extras | Allow `MIT-CMU`? |
| `matplotlib` 3.11.1 | Matplotlib licence (PSF-based) | Rendering (`pdf` extra) | Allow, as an override with its licence file? |
| `numpy` 2.4.6 / 2.5.1 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | matplotlib | Allow `0BSD`, `Zlib`, `CC0-1.0`? |
| `email-validator` 2.3.0 | Unlicense | pydantic, via fastmcp | Allow `Unlicense`? |
| `python-dateutil` 2.9.0.post0 | "Dual License" (Apache-2.0 OR BSD-3-Clause per its LICENSE) | matplotlib | Override with its licence file |

If `pillow` isn't allowed, the bundle can't drive live AutoCAD: `pywin32` and `Pillow` come together in the
`com` extra. The build's own licence check (`npm run build`) is the final word; this table is a first pass.

## 5. What the catalogue listing must say (tresca repository)

- **Kind:** `tresca` (packaged by Tresca). Not official.
- **Access:** `read_write`, or read-only when the user sets Read only.
- **Needs:**
  - Windows;
  - full AutoCAD (LT isn't mentioned upstream), running with a drawing open;
  - live testing on AutoCAD 2026 only.
- **Limitations, from upstream:**
  - one maintainer;
  - open bugs #24, #27 and #28;
  - writing DWG without AutoCAD needs the ODA File Converter, otherwise the headless engine saves DXF;
  - some standards tables (DIN 471/472) ship empty in 1.7 and later.
- **Raw-command, LISP and destructive tools are switched off in this bundle.**
- The usual safety note: work on copies, and have results checked by a qualified engineer.

## 6. Checks before the first release

1. **Extras with the uv type:** does Claude Desktop honour `--extra com --extra pdf` when it prepares the environment? It handles the environment itself and ignored `--no-dev` for FreeCAD MCP. If it drops extras, the live engine won't load.
2. **The folder setting:** confirm `${user_config.project_folder}` reaches `ALLOWED_PATHS` as a plain Windows path, and that writes outside it are refused.
3. **A live run on a real AutoCAD seat, on copies of drawings:**
   - attach to an open session;
   - read entities and make one edit, then undo it;
   - export a PDF;
   - confirm `system_run_command` and `system_run_lisp` are not offered.

   This needs a machine with full AutoCAD (owner).

## 7. Decisions for the owner

1. Package AutoCAD MCP Pro at all, given the one-person maintenance and the open bugs?
2. The five licence decisions in section 4.
3. The lock-down in section 3: `MAX_TOOL_COST=mutate` (no raw-command or LISP tools, no destructive tools) and `CAD_LAUNCH=never`.
4. The non-upstream description in section 3.
5. Who runs the live check in section 6, and on which AutoCAD version?

If the answers are yes, the next step is a `bundles.yaml` entry and a build on a branch, then the checks in
section 6. Weekly upstream updates would then follow the usual 7-day wait. Because the lock-down depends on
the upstream's setting names (`MAX_TOOL_COST`, `CAD_LAUNCH`), the build should fail if a new tag renames them.
