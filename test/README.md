# Tests

All default tests are **offline**: they use a synthetic Vivado project fixture and
fake `vivado`/`xvlog`/`xelab`/`xsim` launchers, so no Vivado installation, board,
or real project is required.

```powershell
# from the repository root
node test/run-tests.mjs      # core parsers + MCP protocol + fake job lifecycle + CLI
node test/plugin-tests.mjs   # native Cordis plugin registration and execute path
```

## Optional real-project integration

A few assertions can exercise a real project and a real Vivado installation when
explicitly enabled:

```powershell
$env:VIVADO_PROJECT_ROOT = "<PROJECT_DIR>"   # directory containing exactly one *.xpr
$env:VIVADO_BIN = "<VIVADO_BIN>/vivado.bat"  # optional; enables real-Vivado probes
node test/run-tests.mjs
```

Without those variables the real-installation probes are skipped.

## Optional MCP SDK handshake

If `@modelcontextprotocol/client` is available (or `MCP_CLIENT_SDK_PATH` points to
its `dist/index.mjs`), one extra handshake test runs; otherwise it is skipped.

## Layout

| Path | Purpose |
|---|---|
| `run-tests.mjs` | Main offline suite (fake Vivado jobs, parsers, CLI). |
| `plugin-tests.mjs` | Native plugin tests with a fake Cordis context. |
| `probe-client.mjs` | Minimal newline-delimited JSON-RPC MCP client used by the suite. |
| `fixtures/fake-project/` | Synthetic Vivado project (`fake_dut` + `fake_tb`). |
| `fixtures/fake-vivado/` | Fake `vivado`/`xvlog`/`xelab`/`xsim` launchers. |
| `fixtures/logs/` | Synthetic timing/utilization/power/DRC/simulation logs. |
| `fixtures/hw/` | Synthetic JTAG scan/program/debug-core JSON results. |

Temporary projects are created under the system temp directory and removed on success.
