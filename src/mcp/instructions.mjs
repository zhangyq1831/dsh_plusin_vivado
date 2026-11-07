// MCP initialize 返回的中文操作手册（≤8KB，供 Agent 直接阅读）。
import { PACKAGE_ROOT } from '../core/config.mjs';

export const SERVER_NAME = 'vivado-mcp';

export const INSTRUCTIONS = `本 MCP 服务器封装本地 Vivado 工程（零 npm 依赖，Node 内置模块实现；已在 Vivado 2018.3 上验证），用于仿真、综合、实现与比特流生成，并解析时序/资源/功耗报告。

## 环境与默认值
- 默认工程根来自环境变量 VIVADO_PROJECT_ROOT；工具参数 project_dir 可覆盖（目录或 .xpr 路径）。
- Vivado 由环境变量 VIVADO_BIN 指定（目录或 vivado.bat），同目录下需有 xvlog.bat / xelab.bat / xsim.bat。
- 工程根必须包含唯一 *.xpr；工具不绑定具体工程，由 project_dir 参数或 VIVADO_PROJECT_ROOT 指定。
- 工具包位置：${PACKAGE_ROOT}。

## 工具清单
1. vivado_doctor(project_dir?, include_version?)
   环境体检：Vivado 路径/版本、xvlog/xelab/xsim、工程发现、GUI/工程锁、目录可写、TCL 就绪度、已知环境噪音。
2. vivado_project_info(project_dir?)
   只读解析 .xpr（不启动 Vivado）：器件、design top、sim set/top、runs（current/SynthRun/进度/产物）、源文件与约束、最近产物。
3. vivado_list_testbenches(project_dir?)
   列出 sim 文件集里的 testbench，标注依赖是否齐全、能否直接仿真（sim_1 里有历史 TB 引用不存在模块，禁止盲选）。
4. vivado_sim_start(testbench?, project_dir?, timeout_sec?)
   异步启动 xvlog→xelab→xsim（独立目录，不打开工程、不占工程锁），立即返回 job_id。默认 testbench 取 sim_1 的 TopModule。
5. vivado_build_start(stage, project_dir?, top?, run?, synth_run?, impl_run?, jobs?, extra_xdc?)
   异步启动构建，立即返回 job_id。stage=synth|impl|bitstream|full。启动前自动备份 *.xpr 到 .vivado-mcp/backup/，结束后恢复；同工程同时只允许一个构建 job。extra_xdc 为可选 .xdc 绝对路径（构建冒烟用：运行期注入内存工程，不修改、不保存工程文件）。
6. vivado_job_status(job_id, project_dir?)
   查询状态：running/done/failed/cancelled、进度百分比、耗时、失败原因、产物。server 重启后仍可查。
7. vivado_job_wait(job_id, timeout_sec?) 默认 120s、上限 240s；超时返回 running + 当前进度。
8. vivado_job_output(job_id, lines?) 返回日志尾部（lines 默认 80、上限 400）。
9. vivado_job_cancel(job_id) 取消并杀整棵进程树（Windows taskkill /T /F）。
10. vivado_job_list(project_dir?, limit?) 最近 job 列表。
11. vivado_reports(job_id? 或 project_dir?) 解析时序（setup WNS/TNS + 端点；报告为 -delay_type min_max 时含 hold WHS/THS；另有 Intra/Inter Clock 与 Other Path Groups 分表）、资源（LUT/FF/BRAM/DSP/IOB 及百分比）、功耗、bit 文件信息、bus skew，并给出顶层 verdict（timingScope + setup/hold/pulseWidth 判定）。
12. vivado_hw_scan(project_dir?, hw_server_url?, timeout_sec?) 同步只读 JTAG 扫描：必要时自动启动本地 hw_server（已有不杀，最多等 15s），返回 targets/devices/ilas/vios。无板卡时 ok:true + devices:[]。
13. vivado_hw_program(bit_file, device?, verify?, project_dir?, hw_server_url?, timeout_sec?) 同步写操作：把显式指定的 .bit 绝对路径烧写到 JTAG 设备，verify 默认 true；结果含 bit SHA256。绝不自动选择最新 bit；无设备/设备不匹配时 ok:false + 结构化 failures（NO_HW_DEVICE/DEVICE_NOT_FOUND/AMBIGUOUS_DEVICE/PROGRAM_FAILED）。
14. vivado_debug_cores(project_dir?, dcp_file?, include_nets?) 同步只读：open_checkpoint 分析 dcp 中的 ILA/VIO 与端口，不打开工程、不占工程锁；默认从 current impl run + design top 推导 <top>_routed.dcp，无 core 时 ok:true + cores:[]。

## 硬件调试（无板卡时的行为）
- 若当前主机**没有 JTAG 板卡**：hw_scan 可返回 ok:true + devices:[]（hw_server 由工具按需启动），hw_program 返回 ok:false + NO_HW_DEVICE，debug_cores 只读可正常返回 cores（无 ILA/VIO 的设计预期为空）。这是正常负路径，不是工具故障。
- hw_program 是唯一写操作：必须显式 bit 绝对路径（存在性 + .bit 校验），结果含 SHA256 对账；接板后正路径再验证。
- debug_cores 对 dcp 只读分析，不改工程、不占锁；dcp 不存在时先跑 impl/bitstream 构建或显式传 dcp_file。

## 推荐流程
- 只读了解工程：vivado_doctor → vivado_project_info → vivado_list_testbenches。
- 仿真：vivado_sim_start（默认当前 TB）→ vivado_job_wait → 若失败用 vivado_job_output 看日志。
- 构建：vivado_build_start({stage:"synth"}) → job_wait → job_status/reports；再做 impl/bitstream/full。先 synth 再 bitstream/full 便于定位问题。
- 报告：vivado_reports({job_id}) 取该 job 的报告；不传 job_id 则取工程最新报告目录。

## 结果判定（重要）
- 仿真 ok=true 必须同时满足：job 状态 done、退出码 0、日志中 [PASS] 数量 > 0、Error 数为 0、检测到正常结束标记。xsim 退出码 0 不代表测试通过（运行期 $error 不改变退出码），必须以日志标记为准。
- 构建 ok=true 必须同时满足：job 状态 done、退出码 0、TCL 打印对应完成标记（VMCP_SYNTH_DONE/VMCP_IMPL_DONE/VMCP_BITSTREAM_OK/VMCP_FINISH ok）、bitstream/full 阶段 .bit 文件存在且大小 > 0。
- 时序判定看 reports.verdict：timingScope=setup+pw（报告为 -delay_type max，hold 未分析，不能声称含 hold）或 setup+hold+pw（报告为 -delay_type min_max，含 WHS/THS）。reports.timing.designSummary 为 WNS/TNS/WHS/THS/WPWS/TPWS 数值；Other Path Groups 单独归类、绝不覆盖 Design Summary；Inter Clock 表为跨时钟路径；bus skew 单独给 busSkewAnalyzed/busSkewMet。
- 构建失败时 structuredContent 里会给出 failedStage 与结构化 errors[]（如 write_bitstream 阶段被 DRC NSTD-1/UCIO-1 拒绝）；按错误码与 Resolution 建议处理，不要只看退出码。
- 失败时 structuredContent.failures[] 给出结构化原因；warning 不会被说成 error，critical warning 与已知环境噪音（旧机器路径、缺失 wcfg、缺失 IP Output Repository）只作为提示。

## 常见问题与处置
- 构建失败时先看 structuredContent.failedStage 与 errors[]（如 write_bitstream 阶段被 DRC NSTD-1/UCIO-1 拒绝），再决定处置，不要只看退出码。
- 默认 XDC 与当前 top 不匹配导致 DRC 拒绝比特流时，用 vivado_build_start 的 extra_xdc 参数注入构建冒烟约束（运行期 add_files 到内存工程，不修改、不保存工程文件）；这是验证过的处置方式。
- 其它 XDC/run 状态问题看日志第一条 ERROR 的上下文；增量 checkpoint 路径不存在时 TCL 会自动清空后继续（VMCP_ALLOW_MISSING_INCR=1）。

## 错误语义
- 工具参数/环境错误 → isError:true，文本含原因与修复建议；job 自身失败 → 正常 text + structuredContent.ok=false（便于读日志，不当作协议错误）。
- job 运行中（running/starting）查询：ok=null，只报进度与阶段，不输出失败清单；终态才有 ok=true/false。
- 未知工具/协议级非法参数由 JSON-RPC 错误码返回（-32602 等）。

## CLI 兜底
node tools/vivado-mcp/bin/vivado-cli.mjs <doctor|info|tbs|sim|synth|impl|bitstream|build|status|wait|output|cancel|jobs|reports|hw-scan|hw-program|debug-cores> [--project DIR] [--tb NAME] [--top NAME] [--run NAME] [--synth-run NAME] [--impl-run NAME] [--jobs N] [--extra-xdc PATH] [--bit PATH] [--device NAME] [--no-verify] [--hw-server URL] [--dcp PATH] [--include-nets] [--timeout SEC] [--lines N] [--limit N] [--no-wait] [--json]
退出码：0 成功、1 工具/环境错误、2 参数错误、3 job 失败。
`;

// 计算 instructions 的 UTF-8 字节数（初始化响应校验用）
export function instructionsByteLength() {
  return Buffer.byteLength(INSTRUCTIONS, 'utf8');
}
