# Architecture

`dsh-vivado-plugin` is a self-contained DSH Cordis plugin package. One core exposes three interchangeable front ends:

```
                 +---------------------------+
                 |  DSH native plugin        |
                 |  index.mjs (ctx.tools)    |
                 +-------------+-------------+
                               |
+-------------------+  +-------v--------+  +---------------------+
| MCP stdio server  |  |   src/mcp/     |  |  CLI (bin/)         |
| src/server.mjs    |  | tools.mjs      |  | vivado-cli.mjs      |
+---------+---------+  +-------+--------+  +----------+----------+
          |                    |                      |
          +--------------------+----------------------+
                               |
                       +-------v--------+
                       |   src/core/    |
                       | project, jobs, |
                       | sim, build,    |
                       | reports, hw    |
                       +-------+--------+
                               |
                 +-------------+-------------+
                 |  job runner (detached)    |
                 |  src/job-runner.mjs       |
                 +-------------+-------------+
                               |
                 +-------------v-------------+
                 | Vivado batch + tcl/*.tcl  |
                 +---------------------------+
```

## Tool registration

- **Native plugin** (`index.mjs`): exports `inject = ['tools']` and `apply(ctx, config)`. It converts the shared tool
  definitions in `src/mcp/tools.mjs` into raw Cordis `ToolDefinition` objects and registers them on `ctx.tools`. The
  definitions use lossless JSON Schema for `parameters`, an annotation-only output schema, and an `execute` function that
  delegates to the same dispatcher as MCP/CLI.
- **MCP server** (`src/server.mjs`): newline-delimited JSON-RPC 2.0 over stdio, no npm dependencies. It exposes the
  same 14 tools as `mcp__<serverName>__<tool>` when connected through the harness MCP client.
- **CLI** (`bin/vivado-cli.mjs`): maps commands to the same dispatcher and formats human-readable or `--json` output.

## Core modules

| Module | Responsibility |
|---|---|
| `src/core/config.mjs` | Package root, project discovery, environment names (`VIVADO_PROJECT_ROOT`, `VIVADO_BIN`, `VIVADO_MCP_NODE`, `VIVADO_MCP_TCL_DIR`), runtime directory conventions |
| `src/core/project.mjs` | Parse `.xpr` XML: part, filesets, design/sim tops, runs (`current`, `SynthRun`, progress), source and constraint lists, module/instantiation scan for testbench dependency checks |
| `src/core/vivado.mjs` | Locate `vivado.bat`/`vivado`, probe version, detect Vivado GUI processes and project lock indicators, companion sim tools |
| `src/core/jobs.mjs` | Durable job store under `<project>/.vivado-mcp/jobs/`; start detached runner, status/output/wait/cancel/list, concurrency guard for builds |
| `src/job-runner.mjs` | Detached child that runs command steps, merges logs, writes runner state, restores the `.xpr` backup on exit |
| `src/core/sim.mjs` | xvlog → xelab → xsim job, isolated simulator working directory, PASS/Error statistics |
| `src/core/build.mjs` | stage=synth/impl/bitstream/full, TCL invocation, completion markers, DRC/error extraction, success evaluation, xpr backup |
| `src/core/parse.mjs` | Markers, progress, errors, timing/other-path-groups/inter-clock parsing, bus skew, utilization, power, simulation results |
| `src/core/reports.mjs` | Collect reports per job/latest directory, prefer impl-stage reports, produce timing/verdict/utilization/power/bit summary |
| `src/core/hw.mjs` | hw_server reachability/auto-start, JTAG scan, explicit bit programming, debug-core inspection |
| `src/core/doctor.mjs` | Environment health check |
| `src/mcp/tools.mjs` | Tool schemas, validation, dispatch, Chinese text rendering |

## Job lifecycle

1. A start tool resolves the project, takes an `.xpr` backup when applicable, creates a unique job directory, and writes
   `job.json`.
2. A detached runner (`src/job-runner.mjs`) is spawned with the real Node.js executable. Long Vivado work never depends on
   the plugin process staying alive.
3. The runner executes steps (Vivado batch, xvlog/xelab/xsim), appends stdout/stderr to `run.log`, and writes
   `runner.json` state. TCL scripts print machine-readable markers such as `VMCP_SYNTH_DONE`, `VMCP_IMPL_DONE`,
   `VMCP_BITSTREAM_OK`, `VMCP_REPORT`, `VMCP_ERROR`, and `VMCP_FINISH`.
4. On exit the runner restores the `.xpr` backup and records the restore result.
5. Status tools combine `job.json`, `runner.json`, live process state, and log tails. Terminal evaluation requires the
   expected markers, the exit code, and the artifacts (non-empty `.bit` for bitstream stages).

Job directory layout:

```
<project>/.vivado-mcp/
  jobs/<UTC>-<stage>-<hex>/
    job.json          request, command, env, timing, failures, markers
    runner.json       detached runner state
    run.log           merged stdout/stderr
    vivado.log        Vivado batch log (when applicable)
    hw_result.json    hardware tool result JSON
  reports/<job>/      generated timing/utilization/power/DRC/bus-skew reports
  backup/<UTC>-<hex>/ .xpr backups
```

## Build TCL flow

`tcl/lib_flow.tcl` resolves the project, optional top/run overrides, extra constraints, and incremental checkpoints, then:

- `synth.tcl`: reset + launch + wait for the synthesis run, open the run, write synthesis reports.
- `bitgen.tcl`: reset + launch implementation to `write_bitstream`, wait, verify the `.bit`, write implementation reports.
- `build.tcl`: synthesis followed by implementation + bitstream in one session.
- Report generation uses `report_timing_summary -delay_type min_max` for implementation (hold included) and `-delay_type max`
  for synthesis; it also collects `report_bus_skew` (when available) and utilization/power/DRC reports.

Each job's `runme.log` is removed before a new run so historical Vivado output cannot be mistaken for the current run's errors.

## Hardware flow

- `tcl/hw_scan.tcl`: `open_hw`, connect to a local/remote `hw_server`, enumerate targets/devices/ILAs/VIOs. No device is a
  valid result (`ok:true` with empty arrays).
- `tcl/hw_program.tcl`: connect, select a device by index or part, set `PROGRAM.FILE`, program and optionally verify.
  The bitstream path is always explicit and a SHA-256 is returned.
- `tcl/debug_cores.tcl`: `open_checkpoint` the routed `.dcp` (no project lock) and enumerate debug cores/ports.

## Environment and project resolution

1. Tool argument `project_dir` (directory or `.xpr`), then
2. `VIVADO_PROJECT_ROOT`, then
3. upward search from the process working directory for a unique `*.xpr`.

The plugin never falls back to its own package directory as a Vivado project. `VIVADO_BIN` is optional; the core probes
common install locations and PATH. Background jobs need a real Node.js executable: config `nodeBin` →
`VIVADO_MCP_NODE` → current process (only if it is `node`) → PATH → known install locations.

## Safety model

- Long jobs are isolated in a detached process; cancelling terminates the process tree.
- The `.xpr` is backed up and restored around builds; source files are never edited.
- `extra_xdc` is applied in memory only.
- `vivado_hw_program` is the only hardware write operation and requires an explicit bitstream path.
- Hardware/filesystem access follows the DSH plugin's in-process permissions; no network services are started other than a
  local `hw_server` when requested.

## Extension points

- Add a tool: define it in `src/mcp/tools.mjs` (schema + handler + renderer) and it automatically becomes available in the
  plugin, MCP server, and CLI.
- Add a Vivado step: add a TCL script under `tcl/` and reference it from `src/core/build.mjs` (or a new core module).
- Parse a new report: extend `src/core/parse.mjs` and `src/core/reports.mjs` with fixture-driven tests.
