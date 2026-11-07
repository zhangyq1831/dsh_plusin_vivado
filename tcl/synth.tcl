# =============================================================================
# synth.tcl — 只执行综合（reset_run + launch_runs synth + wait_on_run）
#
# 调用方式（SPEC §3.1）：
#   vivado.bat -mode batch -notrace -nojournal -log <job>/vivado.log -source <本文件>
# 参数全部由环境变量传入：
#   VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JOBS /
#   VMCP_TOP / VMCP_SYNTH_RUN / VMCP_ALLOW_MISSING_INCR
# 成功标记：VMCP_SYNTH_DONE progress=100% status="..." run=<synth_run> ...
# =============================================================================
source [file join [file dirname [info script]] lib_flow.tcl]
::vmcp::run_script synth
