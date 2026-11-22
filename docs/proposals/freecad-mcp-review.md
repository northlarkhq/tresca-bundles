# Review: FreeCAD MCP 0.1.32 as packaged (`freecad-mcp-0.1.32`)

Status: **for the owner's decision** (2026-11-22). The bundle is released and in the catalogue; this review
came after it, to match the code review AutoCAD MCP Pro had before packaging. Read only: no upstream code was
run, apart from the install test recorded in tresca-app PROGRESS.md (server started; FreeCAD not installed
here, so no tool ran).

## Recommendation

**Keep the bundle.** The code is careful and well tested. It can't be locked down the way AutoCAD MCP Pro was,
because upstream has no option to turn tools off and Tresca packages upstream unchanged. Running Python inside
FreeCAD is what the server is for, so the listing keeps saying that plainly (it already does).

Two optional changes, each a new packaging (`revision: 2`) and a catalogue update:

1. An optional **FreeCAD RPC token** setting (sensitive), passed as `FREECAD_MCP_TOKEN`, for people who set
   a token in FreeCAD. Upstream supports it (`docs/configuration.md`, "Require an auth token").
2. An optional **FreeCADCmd.exe** setting, passed as `--freecadcmd`, so `execute_code_headless` works on
   Windows. Needs a live test first: whether Claude Desktop passes an empty optional setting as an empty
   argument (upstream treats an empty value as "auto-detect") is not known.

## 1. What was checked

| | |
|---|---|
| Upstream | https://github.com/neka-nat/freecad-mcp, tag `v0.1.32`, commit `246f608d5de49089aadc41d2d91cfce2ad8a44cd` |
| Licence | MIT; 45 dependency versions on Windows, all allowed (release `DEPENDENCY-LICENCES.md`) |
| Release file | SHA-256 `d9f5b5b1…3836a13`, 7,161,690 bytes; matches its `.sha256` and the tresca catalogue |
| Contents | upstream files byte-identical (`.gitignore`, `examples/adk/.env` left out by the CLI), `uv.lock`, upstream's `.python-version` (3.12), LICENSE, Tresca's three files |
| How it runs | `uv run freecad-mcp`, no options, as upstream's README configures Claude Desktop. No environment variables set |
| Python 3.12 | every Windows dependency has a ready-built wheel (build check, 2026-11-22) |

Code read: `src/freecad_mcp/server.py`, `headless.py`, `addon/FreeCADMCP/rpc_server/rpc_server.py`,
`ip_filter.py`, `parts_library.py`, `docs/tools.md`, `docs/configuration.md`, `docs/execution.md`, the test
list and CI.

## 2. What the server can do

18 tools (`docs/tools.md`): documents and objects (create, edit, delete, list, reload), screenshots,
CalculiX FEM, the FreeCAD parts library, and three ways to run Python:

- `execute_code`: any Python on FreeCAD's GUI thread (`exec` in `rpc_server.py`).
- `execute_code_async`: the same as a background job.
- `execute_code_headless`: a script in a separate `freecadcmd` process on the MCP server's machine.

That Python runs with your Windows account's permissions: it can read, write and delete any file you can,
and reach the network. Nothing in the server limits it, and there is no setting to turn these tools off
(`server.py` registers every tool; its only options are `--only-text-feedback`, `--host`, `--auth-token`,
`--freecadcmd` and the HTTP-transport ones). This is the same class of risk as AutoCAD MCP Pro's
`system_run_command` and `system_run_lisp`, which that bundle switches off; here it can't be.

## 3. Findings

**The RPC server inside FreeCAD (good).** Port 9875 on `127.0.0.1` only, unless you tick Remote Connections
in FreeCAD. Requests from web pages are refused (any `Origin` header, 403), and a loopback server refuses
requests not addressed to localhost (DNS rebinding). Remote mode binds `0.0.0.0` but accepts only the allowed
IPs, warns in FreeCAD's console when there's no token, and compares tokens in constant time. Off by default.

**No token by default (low on a one-person PC).** With the server started and no token, any program running on
the computer, under any Windows account, can call `execute_code` and run code as you. On a shared or
multi-user machine, set a token in FreeCAD (Set Auth Token). The bundle can't pass one today (recommendation
1).

**Headless tool on Windows (doesn't work without a setting).** `execute_code_headless` looks for
`freecadcmd`/`FreeCADCmd.exe` on PATH, then Flatpak (`headless.py`). FreeCAD's Windows installer doesn't
document adding its `bin` folder to PATH, and upstream's own Windows example passes `--freecadcmd
"C:\Program Files\FreeCAD 1.1\bin\FreeCADCmd.exe"` (`docs/execution.md`). So in this bundle the tool most
likely reports that it can't find FreeCAD. The other tools are unaffected (recommendation 2).

**Paths.** `insert_part_from_library` refuses anything outside FreeCAD's `Mod/parts_library` (absolute paths
and `..` both checked). The other file access is through Python, so section 2 applies.

**Network.** The server talks only to the FreeCAD RPC server (`http.client` to `--host`). The add-on reads a
local parts library. No downloads, telemetry or update checks beyond comparing the add-on and server versions
over the same RPC link.

**Code quality (good).** 43 test files, covering auth, the browser guard, concurrency, timeouts, recovery,
FEM loads and headless runs. CI runs them on Python 3.12 and 3.13, with a Windows job for the headless and FEM
parts. Failed edits roll back their transaction. Project: created 2023-11, 3,428 stars, last push 2026-11-16,
51 open issues; mostly one maintainer (neka-nat, 197 commits; the next contributor has 12).

**Not checked.** No FreeCAD here, so no tool has run against FreeCAD. A live check is still owed: add-on
copied, RPC server started, `create_object`, `get_view`, `execute_code`, and `run_fem_analysis` on
`examples/cantilever_fem.py`.

## 4. The listing (tresca `data/listings/neka-nat-freecad-mcp.yaml`)

Already says, under limitations: "Code execution runs arbitrary Python with your user's permissions; remote
connections are off by default and should use the auth token or an SSH tunnel." `access: read_write`. That
matches the code. If recommendation 2 isn't taken, add a limitation that `execute_code_headless` needs
FreeCAD's `bin` folder on PATH on Windows.

## 5. Decisions for the owner

1. Keep the bundle as it is: yes / no.
2. Add the optional RPC token setting: yes / no.
3. Add the optional FreeCADCmd.exe setting (after a live test of an empty optional setting): yes / no;
   otherwise add the PATH limitation to the listing.
