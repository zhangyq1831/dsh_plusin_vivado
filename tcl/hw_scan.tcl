# =============================================================================
# hw_scan.tcl — 扫描 JTAG targets / devices / ILA / VIO（只读，无硬件也必须 ok:true）
#
# 调用（SPEC_debug §2）：
#   vivado.bat -mode batch -notrace -nojournal -log <job>/vivado.log -source hw_scan.tcl
# 环境变量：VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JSON_OUT /
#           VMCP_HW_SERVER_URL（默认 localhost:3121）
# 成功标记：VMCP_HW_DONE targets=<n> devices=<n>；失败：{"ok":false,...} + exit 1
#
# 2018.3 实测：`open_hw`（不是 open_hw_manager）；connect_hw_server 无 -allow_non_jtag；
# 无板卡时 get_hw_targets 报 Labtoolstcl 44-199 → 视为空 device 列表、ok:true。
# =============================================================================
source [file join [file dirname [info script]] lib_hw.tcl]
::hw::init
::hw::open_manager
::hw::connect

if {[catch { ::hw::enumerate_open } err]} {
    ::hw::fail HW_SCAN_FAILED "failed to enumerate JTAG targets/devices: [::hw::oneline $err]"
}

# 组装 JSON（必须在 close 之前取名字）
set targets_json "\["
set items [list]
foreach t $::hw::targets {
    set nm [::hw::try_prop NAME $t $t]
    lappend items "{\"name\":[::hw::jstr $nm]}"
}
append targets_json "[join $items ,]\]"

set devices_json "\[[join [::hw::json_device_list] ,]\]"
set ilas_json [::hw::json_named_list $::hw::ilas]
set vios_json [::hw::json_named_list $::hw::vios]

set n_targets [llength $::hw::targets]
set n_devices [llength $::hw::devices]
set n_ilas [llength $::hw::ilas]
set n_vios [llength $::hw::vios]

::hw::close_targets
::hw::close_all

set body "{\"ok\":true,\"hwServer\":{\"url\":[::hw::jstr $::hw::hw_url],\"connected\":true},\"targets\":$targets_json,\"devices\":$devices_json,\"ilas\":$ilas_json,\"vios\":$vios_json,\"errors\":\[\]}"
::hw::emit_result $body
::hw::log "scan ok targets=$n_targets devices=$n_devices ilas=$n_ilas vios=$n_vios elapsed=[::hw::elapsed]s"
puts "VMCP_HW_DONE targets=$n_targets devices=$n_devices"
::hw::finish_ok
