# dsh-vivado-plugin

A **native DeepSeek Harness (DSH) plugin** that drives [Xilinx Vivado](https://www.xilinx.com/products/design-tools/vivado.html) from an agent session:
simulation, synthesis, implementation/bitstream generation, timing/resource/power reports, and basic JTAG hardware debugging
(device scan, explicit bitstream programming, debug-core inspection). It is self-contained, has **zero npm dependencies**, and also
ships an optional MCP stdio server and a CLI for non-plugin workflows.

> Tested with **Vivado 2018.3 on Windows**. The TCL flow is version-agnostic where possible, but report-parsing and
> hardware-manager commands follow the 2018.3 formats; other versions may need small adaptations.

## Features

- 14 model-facing tools under the `vivado_*` namespace:
  - build/sim: `vivado_doctor`, `vivado_project_info`, `vivado_list_testbenches`, `vivado_sim_start`, `vivado_build_start`
  - jobs: `vivado_job_status`, `vivado_job_wait`, `vivado_job_output`, `vivado_job_cancel`, `vivado_job_list`
  - reports: `vivado_reports` (timing incl. hold/bus-skew where available, utilization, power, bit metadata)
  - hardware: `vivado_hw_scan`, `vivado_hw_program`, `vivado_debug_cores`
- Asynchronous job model: long Vivado runs return a `job_id` immediately, with status/wait/output/cancel tools.
- Strict success semantics: exit code, completion markers and artifacts must all agree; simulation requires `[PASS]` lines and no errors;
  build requires the expected reports and (for bitstream stages) a non-empty `.bit`.
- Timing verdicts are scoped: `setup+pw` for `-delay_type max` reports, `setup+hold+pw` for `min_max` reports; bus-skew results are
  reported separately and empty bus-skew reports do not fail a build.
- Builds back up and restore the Vivado project file (`.xpr`) around each run, and keep per-job logs/reports under
  `<project>/.vivado-mcp/`.
- Optional MCP stdio mode and a CLI are thin wrappers around the same core.

## Requirements

| Component | Requirement |
|---|---|
| DeepSeek Harness | A profile with Cordis plugin support and `plugin_manager` |
| Node.js | **20 or newer** (background jobs are launched with a real `node`, not the desktop host executable) |
| Xilinx Vivado | Installed locally; `vivado.bat`/`vivado` discoverable from `VIVADO_BIN` or common install paths |
| Project | A Vivado project directory containing exactly one `*.xpr` |
| Hardware (optional) | JTAG cable/driver and a connected board for the `vivado_hw_*` write paths |

## Install

```powershell
git clone https://github.com/zhangyq1831/dsh_plusin_vivado.git
# In a DSH session:
plugin_manager install_bundle target="<ABSOLUTE_PATH_TO_CLONED_REPO>"
```

Then provide the default project (and optionally the Vivado and Node paths) before launching/reloading DSH:

```powershell
$env:VIVADO_PROJECT_ROOT = "<PROJECT_DIR>"          # directory containing the .xpr
$env:VIVADO_BIN          = "<VIVADO_BIN>\vivado.bat" # optional; auto-detected otherwise
$env:VIVADO_MCP_NODE     = "<NODE_EXE>"              # optional; PATH discovery otherwise
```

After the profile reloads, the 14 bare-name `vivado_*` tools are available. Every tool also accepts an explicit
`project_dir`, so `VIVADO_PROJECT_ROOT` is only a default.

The bundle patch (`cordis.patch.yml`) is configuration-only and contains no machine-specific paths. To configure
paths inside the profile instead of the environment, edit the row's `config` after installation:

```yaml
- id: vivado-plugin
  name: dsh-vivado-plugin
  config:
    projectDir: /path/to/vivado/project
    vivadoBin: /path/to/vivado/bin/vivado.bat
    nodeBin: /path/to/node
```

## Quick start

```text
vivado_doctor              {}                                      # environment check
vivado_project_info        {}                                      # part/top/runs, no Vivado launch
vivado_list_testbenches    {}
vivado_sim_start           {"testbench": "<TB_MODULE>"}
vivado_job_wait            {"job_id": "<job_id>", "timeout_sec": 240}
vivado_reports             {"job_id": "<job_id>"}
vivado_build_start         {"stage": "full"}                        # synth + impl + bitstream
vivado_job_wait            {"job_id": "<build_job>"}
vivado_reports             {"job_id": "<build_job>"}
```

Useful build options: `stage` = `synth` | `impl` | `bitstream` | `full`; `top`; `jobs`; `extra_xdc` (an optional
extra `.xdc` injected in-memory for build smoke tests — it does not modify the project file).

Hardware tools (no board attached is a valid negative path):

```text
vivado_hw_scan      {}                       # targets/devices/ILAs/VIOs; starts hw_server on demand
vivado_debug_cores  {}                       # inspect ILA/VIO cores in the current routed .dcp
vivado_hw_program   {"bit_file": "<PROJECT_DIR>/<RUN_DIR>/<TOP>.bit"}
```

`vivado_hw_program` never chooses a bitstream automatically: pass the absolute `.bit` path explicitly.

## Optional MCP mode

The same core can be exposed through the harness MCP client if you prefer MCP tools (`mcp__vivado__*`) instead of the
native plugin. Add a row such as:

```yaml
- id: vivado-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: vivado
    transport: stdio
    command: <NODE_EXE>
    args: ['<ABSOLUTE_PATH_TO_REPO>/src/server.mjs']
    cwd: '<PROJECT_DIR>'
    env:
      VIVADO_PROJECT_ROOT: '<PROJECT_DIR>'
      VIVADO_BIN: '<VIVADO_BIN>/vivado.bat'
    toolCallTimeoutMs: 300000
```

Only one of the native plugin and the MCP row should be enabled at a time to avoid duplicate tools.

## CLI

```powershell
node bin/vivado-cli.mjs doctor --project "<PROJECT_DIR>"
node bin/vivado-cli.mjs info --json --project "<PROJECT_DIR>"
node bin/vivado-cli.mjs synth --project "<PROJECT_DIR>"
node bin/vivado-cli.mjs full --project "<PROJECT_DIR>" --json
node bin/vivado-cli.mjs reports <job_id> --project "<PROJECT_DIR>" --json
```

There are also `bin/vivado.bat` (Windows) and `bin/vivado.sh` (POSIX) wrappers.
Exit codes: `0` success, `1` environment/tool error, `2` invalid arguments, `3` job failed.

## Reports and verdicts

`vivado_reports` returns:

- `timing.designSummary`: WNS/TNS/WHS/THS/WPWS/TPWS and failing/total endpoints where present;
- `timing.intraClock`, `timing.interClock`, `timing.otherPathGroups` (kept separate; the "other path groups" table never
  overwrites the design summary);
- `timing.checks` / `verdict`: `timingScope` is `setup+pw` for max-only reports and `setup+hold+pw` for `min_max` reports;
  bus skew is reported separately and `applicable=false` when the report contains no bus-skew constraints;
- `utilization`, `power`, `bitstream`, and the report file list with modification time / staleness info.

The implementation reports are generated with `-delay_type min_max`, so hold checks are available after an implementation
build. Synthesis-stage reports remain max-only.

## Safety and side effects

- Runs locally installed Vivado in batch mode; it starts background processes for long jobs.
- Creates `<project>/.vivado-mcp/` for jobs, logs, reports, and `.xpr` backups. Builds restore the `.xpr` after completion.
- Does not modify RTL/source files. `extra_xdc` is injected in memory only.
- Only `vivado_hw_program` writes to hardware, and only when you pass an explicit bitstream path.

## Testing

```powershell
node test/run-tests.mjs      # parsers, MCP protocol, fake-job lifecycle, CLI (no Vivado needed)
node test/plugin-tests.mjs   # native plugin registration/execute path (no Vivado needed)
```

Both suites use synthetic fixtures and fake Vivado launchers. Optional real-project/Vivado and MCP-SDK probes are
documented in [`test/README.md`](test/README.md).

## Repository layout

```
index.mjs            native Cordis plugin entry
src/mcp/             tool definitions, MCP protocol, instructions
src/core/            project/env discovery, jobs, sim/build, report parsing
src/server.mjs       optional MCP stdio server
bin/                 CLI entry + platform wrappers
tcl/                 Vivado batch TCL (synth/build/bitgen/hw/debug)
test/                offline tests and synthetic fixtures
docs/                architecture and usage notes
skill/               optional agent skill template
cordis.patch.yml     native plugin bundle row
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/USAGE.md](docs/USAGE.md)
- [skill/vivado-mcp/SKILL.md](skill/vivado-mcp/SKILL.md) — copy to `~/.dsh/skills/vivado-mcp/SKILL.md` if you want a
  ready-made agent playbook.

## Limitations

- Windows + Vivado 2018.3 is the primary tested combination; other Vivado versions may change report text or TCL commands.
- Hardware positive paths (real device enumeration, successful programming/verify, non-empty ILA/VIO ports) require a board
  and are not covered by the offline tests.
- There is no UI panel; tools are model-facing. The plugin runs in the Harness host process.
- Timing conclusions are limited to what the generated report contains; always check `timingScope` before treating a result
  as a sign-off.

## License

[MIT](LICENSE). Contributions and issue reports are welcome.
