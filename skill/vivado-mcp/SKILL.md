---
name: vivado-toolchain
description: Run a local Xilinx Vivado project through the dsh-vivado-plugin tools: environment checks, xsim simulation, synthesis, implementation/bitstream builds, timing/resource/power reports, and JTAG hardware debugging. Use when a task involves Vivado builds, job status/logs, report interpretation, or FPGA programming/debug-core inspection.
whenToUse: When the user asks to simulate, synthesize, implement, generate a bitstream, inspect Vivado timing/utilization reports, debug a Vivado job, or scan/program a JTAG device using the vivado_* tools.
---

# Vivado toolchain (agent playbook)

`dsh-vivado-plugin` exposes 14 model-facing tools in the `vivado_*` namespace. Each tool accepts `project_dir`
(a directory containing one `*.xpr`, or a direct `.xpr` path); when omitted, the plugin uses
`VIVADO_PROJECT_ROOT`.

## Standard sequence

1. **Environment first**
   - `vivado_doctor` — confirm Vivado, `xvlog/xelab/xsim`, project discovery, GUI/lock status.
   - `vivado_project_info` — part, design top, simulation top, current runs, sources, constraints.
   - `vivado_list_testbenches` — pick a testbench whose module dependencies are present.
2. **Simulation**
   - `vivado_sim_start {testbench}`
   - `vivado_job_wait {job_id, timeout_sec}` (repeat while running)
   - `vivado_job_output {job_id}` on failure
   - `vivado_reports {job_id}` for any generated report artifacts
3. **Build**
   - `vivado_build_start {stage: "synth"}` → `vivado_job_wait` → `vivado_reports`
   - then `stage: "impl"`, `"bitstream"`, or `"full"` as needed.
   - Use `extra_xdc` only for a temporary build-smoke constraint file; it is not saved into the project.
4. **Hardware** (optional)
   - `vivado_debug_cores` — inspect ILA/VIO cores in the routed `.dcp` without a board.
   - `vivado_hw_scan` — list JTAG targets/devices; starts a local `hw_server` if needed.
   - `vivado_hw_program {bit_file}` — explicit absolute bitstream path only.

## Success rules

- **Simulation**: job `done`, exit code `0`, at least one `[PASS]`, zero errors, normal end marker. A zero exit code alone
  is not success.
- **Build**: job `done`, exit code `0`, expected `VMCP_*` completion markers, and a non-empty `.bit` for bitstream stages.
- **Reports**: read `verdict.timingScope` before treating a result as timing sign-off:
  - `setup+pw` — max-only report; hold was not analyzed.
  - `setup+hold+pw` — implementation `min_max` report; check WHS/THS and failing endpoints.
  - `busSkew.applicable=false` — no bus-skew constraints/results; not a failure.

## Job model

Start tools return immediately with a `job_id`. Use `vivado_job_wait` (bounded timeout), `vivado_job_status`,
`vivado_job_output`, `vivado_job_cancel`, and `vivado_job_list`. Jobs are persisted under
`<project>/.vivado-mcp/jobs/`; long builds should be polled rather than assumed finished.

## Common pitfalls

- Close a Vivado GUI that owns the same project before building; otherwise the build is refused as conflicting.
- `write_bitstream` DRC `NSTD-1`/`UCIO-1` means missing I/O standard/location constraints in the project XDC — fix the
  constraints or use `extra_xdc` for a smoke build; do not claim a sign-off bitstream.
- Report text formats are Vivado-version dependent (this package is tested with 2018.3); if parsing looks wrong, inspect
  the `.rpt` under `<project>/.vivado-mcp/reports/<job>/`.
- Hardware positive paths require a board; without one, `hw_scan` returning empty devices and `hw_program` returning
  `NO_HW_DEVICE` are expected results, not tool failures.
- The bitstream must be passed explicitly to `vivado_hw_program`; there is no implicit "latest bit" selection.

## Installation

See the repository [README](../README.md) for `plugin_manager install_bundle`, environment variables, optional MCP mode,
and CLI usage.
