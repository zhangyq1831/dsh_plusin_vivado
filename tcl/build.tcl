# =============================================================================
# build.tcl — 综合 -> 实现 -> write_bitstream 全流程（同源 proc 顺序执行）
#
# 调用方式（SPEC §3.1）：
#   vivado.bat -mode batch -notrace -nojournal -log <job>/vivado.log -source <本文件>
# 参数全部由环境变量传入：
#   VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JOBS / VMCP_TOP /
#   VMCP_SYNTH_RUN / VMCP_IMPL_RUN / VMCP_STAGE / VMCP_ALLOW_MISSING_INCR
#   VMCP_STAGE 默认 full；可为 synth（只综合）/ impl、bitstream（只实现+比特流）
# 成功标记：VMCP_SYNTH_DONE / VMCP_IMPL_DONE / VMCP_BITSTREAM_OK / VMCP_FINISH ok
# =============================================================================
source [file join [file dirname [info script]] lib_flow.tcl]
::vmcp::run_script full
