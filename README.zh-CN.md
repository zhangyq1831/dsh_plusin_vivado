# dsh-vivado-plugin（中文说明）

一个 **DeepSeek Harness（DSH）原生 Cordis 插件**：让 Agent 通过 `vivado_*` 工具操作本机 Xilinx Vivado，
完成仿真、综合、实现/比特流生成、时序/资源/功耗报告读取，以及基础的 JTAG 硬件调试（设备扫描、显式 bit 烧写、
debug core 检查）。单包、**零 npm 依赖**，同时附带可选的 MCP stdio server 与 CLI。

> 主要测试环境：**Windows + Vivado 2018.3**。TCL 流程尽量与版本无关，但报告解析和硬件管理器命令按 2018.3
> 文本/命令实现，其他 Vivado 版本可能需要少量适配。

## 功能

- 14 个模型可调用的 `vivado_*` 工具（构建/仿真、job、报告、硬件调试，详见 [README.md](README.md)）。
- 长任务异步 job：`vivado_build_start`/`vivado_sim_start` 立即返回 `job_id`，用 status/wait/output/cancel 查询。
- 严格判定：退出码 + 完成标记 + 产物三者一致；仿真需 `[PASS]` 且无 Error；bitstream/full 需存在非空 `.bit`。
- 时序判定带范围：max 报告为 `setup+pw`，impl 阶段 `min_max` 报告为 `setup+hold+pw`；bus skew 单独判定，
  无 bus-skew 约束的空报告不判失败。
- 构建前后自动备份/恢复 `.xpr`；job 日志与报告写入 `<工程>/.vivado-mcp/`。
- 同一 core 可切换为 MCP stdio 模式或 CLI。

## 要求

- DSH profile（支持 Cordis 插件与 `plugin_manager`）
- Node.js **20+**（后台 job 由一个真实的 `node` 启动，不是桌面宿主进程）
- 本机安装 Xilinx Vivado（`VIVADO_BIN` 或常见安装路径可发现）
- 一个包含唯一 `*.xpr` 的 Vivado 工程目录
- 可选：JTAG 下载器与板卡（`vivado_hw_program` 正路径）

## 安装

```powershell
git clone https://github.com/zhangyq1831/dsh_plusin_vivado.git
# 在 DSH 会话中：
plugin_manager install_bundle target="<克隆目录的绝对路径>"
```

设置默认工程（可选设置 Vivado/Node 路径），然后重载 DSH：

```powershell
$env:VIVADO_PROJECT_ROOT = "<PROJECT_DIR>"
$env:VIVADO_BIN          = "<VIVADO_BIN>\vivado.bat"
$env:VIVADO_MCP_NODE     = "<NODE_EXE>"
```

重载后即可看到 14 个裸名 `vivado_*` 工具。所有工具也接受显式 `project_dir` 参数，`VIVADO_PROJECT_ROOT` 只是默认值。
bundle 的 `cordis.patch.yml` 不含任何本机路径；如需在 profile 内配置，可编辑该行 `config`（projectDir/vivadoBin/nodeBin）。

## 快速开始

```text
vivado_doctor            {}
vivado_project_info      {}
vivado_sim_start         {"testbench": "<TB_MODULE>"}
vivado_job_wait          {"job_id": "<job_id>", "timeout_sec": 240}
vivado_reports           {"job_id": "<job_id>"}
vivado_build_start       {"stage": "full"}
vivado_job_wait          {"job_id": "<build_job>"}
vivado_reports           {"job_id": "<build_job>"}
```

硬件调试（无板卡时也是合法负路径）：

```text
vivado_hw_scan      {}
vivado_debug_cores  {}
vivado_hw_program   {"bit_file": "<PROJECT_DIR>/<RUN_DIR>/<TOP>.bit"}
```

`vivado_hw_program` 绝不自动选择最新 bit，必须显式传入 `.bit` 绝对路径。

## MCP / CLI

- 可选 MCP 模式：向 profile 插入一行 `@deepseek-ai/dsh-mcp-client` 指向 `src/server.mjs`，工具名变为 `mcp__vivado__*`。
  不要与原生插件同时启用，避免工具重复。
- CLI：`node bin/vivado-cli.mjs <doctor|info|sim|synth|impl|bitstream|full|status|wait|output|cancel|jobs|reports|hw-scan|hw-program|debug-cores> ...`
  也有 `bin/vivado.bat` / `bin/vivado.sh` 包装。退出码：0 成功、1 环境错误、2 参数错误、3 job 失败。

## 安全与副作用

- 在本机以 batch 模式运行 Vivado，并启动后台进程。
- 在 `<工程>/.vivado-mcp/` 写 job/日志/报告/xpr 备份；构建结束恢复 `.xpr`。
- 不修改 RTL/源码；`extra_xdc` 仅在内存注入。
- 只有 `vivado_hw_program` 会写硬件，且必须显式给 bit 路径。

## 测试

```powershell
node test/run-tests.mjs      # 解析器 / MCP 协议 / fake job / CLI（无需 Vivado）
node test/plugin-tests.mjs   # 原生插件注册与执行路径（无需 Vivado）
```

两套测试均使用合成工程与 fake Vivado；可选真实工程/真实 Vivado 与 MCP SDK 检测见 [test/README.md](test/README.md)。

## 已知限制

- 主要验证 Windows + Vivado 2018.3；其他版本的报告文本/TCL 命令可能不同。
- 硬件正路径（真实设备枚举、成功烧写/校验、ILA/VIO 非空）需要板卡，离线测试不覆盖。
- 无 UI 面板；插件运行在 Harness Host 进程内。
- 时序结论取决于报告内容，请先看 `timingScope` 再作为签核依据。

## 许可证

[MIT](LICENSE)。
