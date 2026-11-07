# Usage

All examples use `<PROJECT_DIR>` for the Vivado project directory (the directory containing exactly one `*.xpr`) and
`<job_id>` for the identifier returned by asynchronous tools.

## Environment setup

```powershell
$env:VIVADO_PROJECT_ROOT = "<PROJECT_DIR>"          # default project (tools also accept project_dir)
$env:VIVADO_BIN          = "<VIVADO_BIN>\vivado.bat" # optional; auto-detected otherwise
$env:VIVADO_MCP_NODE     = "<NODE_EXE>"              # optional; real node used for background jobs
```

Then in the DSH session:

```text
vivado_doctor {}
```

A healthy result reports the Vivado executable, `xvlog`/`xelab`/`xsim`, project discovery, lock/GUI checks, and the TCL
scripts shipped with the package.

## Read the project without starting Vivado

```text
vivado_project_info      {"project_dir": "<PROJECT_DIR>"}
vivado_list_testbenches  {"project_dir": "<PROJECT_DIR>"}
```

`vivado_project_info` parses the `.xpr` directly: part, filesets, design top, simulation top, current runs, source and
constraint files, recent artifacts. `vivado_list_testbenches` flags testbenches whose module dependencies are missing.

## Simulation

```text
vivado_sim_start {"testbench": "<TB_MODULE>", "timeout_sec": 900}
vivado_job_wait  {"job_id": "<job_id>", "timeout_sec": 240}
vivado_job_output{"job_id": "<job_id>", "lines": 80}
```

Simulation runs `xvlog → xelab → xsim` in an isolated working directory and does not open the project. Success requires:

- job status `done` and exit code `0`;
- at least one `[PASS]` line and zero simulation errors;
- a normal end-of-simulation marker.

A zero xsim exit code is **not** sufficient: `$error` in a testbench does not change the exit code.

## Synthesis / implementation / bitstream

```text
vivado_build_start {"stage": "synth"}
vivado_build_start {"stage": "impl"}
vivado_build_start {"stage": "bitstream"}
vivado_build_start {"stage": "full", "jobs": 4, "extra_xdc": "<PROJECT_DIR>/extra.xdc"}
```

- `stage=full` runs synthesis, implementation, and `write_bitstream`; `bitstream` skips synthesis and uses the existing
  synthesis result.
- `top`, `run`, `synth_run` override the project settings when needed.
- `extra_xdc` is an absolute path to an extra constraints file injected into the in-memory project for build smoke tests.
  It is never saved into the `.xpr`.
- One build job per project may run at a time. Progress, logs, and reports are exposed via the job tools.

Success requires exit code `0`, the expected completion markers, and (for bitstream stages) a non-empty `.bit` file.

## Jobs

```text
vivado_job_status {"job_id": "<job_id>"}
vivado_job_wait   {"job_id": "<job_id>", "timeout_sec": 120}
vivado_job_output {"job_id": "<job_id>", "lines": 100}
vivado_job_cancel {"job_id": "<job_id>"}
vivado_job_list   {"limit": 10}
```

Jobs are written to disk, so their status survives a plugin/server restart. `job_wait` returns `ok:null` while a job is
still running and a final `ok:true|false` only after completion.

## Reports and timing verdicts

```text
vivado_reports {"job_id": "<build_job>"}
```

The summary contains:

- `timing.designSummary` — WNS/TNS, failing/total endpoints, WPWS/TPWS, and WHS/THS when the report is `min_max`;
- `timing.intraClock`, `timing.interClock`, `timing.otherPathGroups` — per-clock and path-group tables, kept separate;
- `timing.checks` and `verdict` — setup / hold / pulse-width and bus-skew conclusions;
- `timingScope` — `setup+pw` (max report) or `setup+hold+pw` (min_max report);
- `utilization`, `power`, `bitstream`, and report file metadata.

Interpretation rules:

| Situation | Meaning |
|---|---|
| `timingScope=setup+pw` | Hold was not analyzed (synthesis-stage or older max-only report) |
| `timingScope=setup+hold+pw` | Setup and hold were analyzed; check `WHS/THS` and failing endpoints |
| `busSkew.applicable=false` | No `set_bus_skew` constraints (or no bus-skew results); not a failure |
| `verdict.timingMet=true` | All analyzed timing checks passed; always read the scope |

Reports generated before a rebuild may be stale; pass the job id to analyze that job's own reports.

## Hardware debugging

```text
vivado_hw_scan      {"hw_server_url": "localhost:3121"}
vivado_debug_cores  {"include_nets": true}
vivado_hw_program   {"bit_file": "<PROJECT_DIR>/<RUN_DIR>/<TOP>.bit", "verify": true}
```

- `hw_scan` starts a local `hw_server` if none is listening (existing servers are not killed) and returns
  targets/devices/ILAs/VIOs. No board is a valid result: `ok:true` with empty arrays.
- `hw_program` never chooses the bitstream itself; pass an absolute `.bit` path. The result includes the bitstream SHA-256.
- `debug_cores` opens the routed `.dcp` directly (no project lock) and lists ILA/VIO cores and ports. Missing `.dcp` can be
  fixed by running an implementation/bitstream build or by passing `dcp_file`.
- A `hw_server` started by the tool is intentionally left running for reuse; stop it with `taskkill /IM hw_server.exe /F`
  if you do not need it.

Hardware positive paths (real device enumeration, programming/verify success, non-empty ILA/VIO ports) require a board;
without one these tools exercise only the negative path.

## Troubleshooting

| Symptom | Action |
|---|---|
| `VIVADO_PROCESS_RUNNING` | Close the Vivado GUI/other batch instance, or set `VIVADO_MCP_ALLOW_EXTERNAL_VIVADO=1` when the other instance does not use this project |
| `PROJECT_LOCKED` | Remove stale `.lck` files after closing the owning Vivado instance |
| Build fails in `write_bitstream` with DRC `NSTD-1`/`UCIO-1` | The design lacks I/O standard/location constraints; fix the XDC (for smoke tests only, pass `extra_xdc`) |
| `incremental_checkpoint` missing | The core clears a missing incremental checkpoint automatically and logs it |
| `node` not found / background job cannot start | Set `VIVADO_MCP_NODE` (or plugin config `nodeBin`) to a real Node.js executable |
| Job log contains errors from an older run | The core clears the run's `runme.log` before launching and downgrades historical replay errors to notices |
| Job times out | Increase `timeout_sec`, inspect `job_output`, and use `job_cancel` to stop the process tree |
| Reports are missing | Run a later stage (`impl`/`bitstream`/`full`) or pass the job id that produced them |

## CLI examples

```powershell
node bin/vivado-cli.mjs doctor --project "<PROJECT_DIR>"
node bin/vivado-cli.mjs info --json --project "<PROJECT_DIR>"
node bin/vivado-cli.mjs sim --tb "<TB_MODULE>" --project "<PROJECT_DIR>"
node bin/vivado-cli.mjs full --project "<PROJECT_DIR>" --json
node bin/vivado-cli.mjs reports <job_id> --project "<PROJECT_DIR>" --json
node bin/vivado-cli.mjs hw-scan --project "<PROJECT_DIR>" --json
```

Exit codes: `0` success, `1` environment/tool error, `2` invalid arguments, `3` job failed.
