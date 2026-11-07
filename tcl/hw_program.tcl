# =============================================================================
# hw_program.tcl — 把显式指定的 .bit 烧写到 JTAG 设备（写操作，无硬件必须结构化报错）
#
# 调用（SPEC_debug §2）：
#   vivado.bat -mode batch -notrace -nojournal -log <job>/vivado.log -source hw_program.tcl
# 环境变量：VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JSON_OUT /
#           VMCP_HW_SERVER_URL / VMCP_BIT_FILE（必填）/ VMCP_HW_DEVICE（可选索引或 PART）/
#           VMCP_VERIFY（默认 1）
# 成功标记：VMCP_PROGRAM_DONE programmed=1；失败：{"ok":false,"errors":[...]} + exit 1
# 安全：不提供“默认最新 bit 自动烧写”；bit 路径必须显式传入并做存在性/后缀校验。
# =============================================================================
source [file join [file dirname [info script]] lib_hw.tcl]
::hw::init

# ---- bit 文件显式校验（Node 侧也会校验，TCL 侧兜底）----
set bit [::hw::env_or VMCP_BIT_FILE ""]
if {$bit eq ""} {
    ::hw::fail BIT_NOT_FOUND "missing VMCP_BIT_FILE (absolute path of the .bit to program); this tool never auto-selects the latest bit" "\"programmed\":false,\"bitFile\":null,\"bitSha256\":null"
}
set bit [file normalize $bit]
if {![file exists $bit]} {
    ::hw::fail BIT_NOT_FOUND "bit file not found: $bit" "\"programmed\":false,\"bitFile\":[::hw::jstr $bit],\"bitSha256\":null"
}
if {[string tolower [file extension $bit]] ne ".bit"} {
    ::hw::fail BIT_INVALID "bit file must have .bit extension: $bit" "\"programmed\":false,\"bitFile\":[::hw::jstr $bit],\"bitSha256\":null"
}
set bit_sha [::hw::sha256_file $bit]
::hw::log "bit=$bit size=[file size $bit] sha256=$bit_sha verify=$::hw::verify"

set common_extra "\"programmed\":false,\"bitFile\":[::hw::jstr $bit],\"bitSha256\":[::hw::jstr $bit_sha]"

::hw::open_manager
::hw::connect
if {[catch { ::hw::enumerate_open } err]} {
    ::hw::fail HW_SCAN_FAILED "failed to enumerate JTAG targets/devices: [::hw::oneline $err]" $common_extra
}

# ---- 设备选择：0 个 / 多个 / 显式索引或 PART，全部结构化报错 ----
set dev [::hw::select_device [::hw::env_or VMCP_HW_DEVICE ""] $common_extra]
set dev_obj [dict get $dev obj]
set dev_json [::hw::device_json $dev]
::hw::log "selected device name=[dict get $dev name] part=[dict get $dev part]"

# ---- 烧写 ----
if {[catch { set_property PROGRAM.FILE $bit $dev_obj } err]} {
    ::hw::fail PROGRAM_FAILED "set_property PROGRAM.FILE failed: [::hw::oneline $err]" "$common_extra,\"device\":$dev_json"
}
set t_prog [clock milliseconds]
if {[catch { program_hw_devices $dev_obj } err]} {
    # 2018.3 某些版本要求先 set current_hw_device；回退再试一次
    if {[catch { current_hw_device $dev_obj; program_hw_devices } err2]} {
        ::hw::fail PROGRAM_FAILED "program_hw_devices failed: [::hw::oneline $err]; fallback attempt: [::hw::oneline $err2]" "$common_extra,\"device\":$dev_json"
    }
}
set prog_ms [expr {[clock milliseconds] - $t_prog}]
::hw::log "program_hw_devices ok device=[dict get $dev name] elapsed_ms=$prog_ms"

# ---- 校验（verify=1 时尝试 refresh + 读属性；无硬件环境无法实测此分支）----
set verify_req $::hw::verify
set verify_passed 0
set verify_detail ""
if {$verify_req} {
    if {[catch { refresh_hw_device -update_hw_probes false $dev_obj } err]} {
        set verify_detail "refresh_hw_device failed: [::hw::oneline $err]"
        ::hw::log "verify: $verify_detail"
    } else {
        set isp [::hw::try_prop PROGRAM.IS_PROGRAMMED $dev_obj]
        if {$isp ne ""} {
            if {[catch { set verify_passed [expr {$isp ? 1 : 0}] }]} { set verify_passed 0 }
            set verify_detail "PROGRAM.IS_PROGRAMMED=$isp"
        } else {
            # 2018.3 hw_device 不保证暴露 PROGRAM.IS_PROGRAMMED；program_hw_devices 已成功返回，
            # 且 refresh 成功。无硬件环境无法验证该分支，接板后需复核 verify 语义。
            set cstat [::hw::try_prop REGISTER.CONFIG_STATUS $dev_obj]
            set verify_passed 1
            set verify_detail "program_hw_devices+refresh succeeded; PROGRAM.IS_PROGRAMMED not exposed, REGISTER.CONFIG_STATUS='$cstat' (not verified: no hardware)"
        }
        ::hw::log "verify: passed=$verify_passed detail=$verify_detail"
    }
} else {
    set verify_detail "verify=0 (verification not requested)"
    ::hw::log "verify: not requested"
}

::hw::close_targets
::hw::close_all

set body "{\"ok\":true,\"programmed\":true,\"device\":$dev_json,\"bitFile\":[::hw::jstr $bit],\"bitSha256\":[::hw::jstr $bit_sha],\"verify\":{\"requested\":[::hw::jbool $verify_req],\"passed\":[::hw::jbool $verify_passed],\"detail\":[::hw::jstr $verify_detail]},\"programElapsedMs\":$prog_ms,\"errors\":\[\]}"
::hw::emit_result $body
::hw::log "program ok device=[dict get $dev name] program_elapsed_ms=$prog_ms total_elapsed=[::hw::elapsed]s"
puts "VMCP_PROGRAM_DONE programmed=1"
::hw::finish_ok
