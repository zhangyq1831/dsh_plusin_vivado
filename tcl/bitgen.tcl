# =============================================================================
# bitgen.tcl — 假定综合已完成，执行实现 + write_bitstream
#   流程：reset_run impl -> launch_runs impl -to_step write_bitstream -> wait
#         -> 校验 PROGRESS=100%/Complete -> 校验 .bit 存在 -> 生成实现报告
#
# 调用方式（SPEC §3.1）：
#   vivado.bat -mode batch -notrace -nojournal -log <job>/vivado.log -source <本文件>
# 参数全部由环境变量传入：
#   VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JOBS /
#   VMCP_TOP / VMCP_SYNTH_RUN / VMCP_IMPL_RUN / VMCP_ALLOW_MISSING_INCR
# 成功标记：VMCP_IMPL_DONE ... / VMCP_BITSTREAM_OK <绝对路径>
# =============================================================================
source [file join [file dirname [info script]] lib_flow.tcl]
::vmcp::run_script impl
