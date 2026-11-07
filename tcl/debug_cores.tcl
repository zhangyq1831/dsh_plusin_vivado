# =============================================================================
# debug_cores.tcl — 分析 routed dcp 里的 ILA/VIO debug core（只读）
#
# 重要：**不 open_project**（不占工程锁、不改 xpr），直接 open_checkpoint。
# 调用（SPEC_debug §2）：
#   vivado.bat -mode batch -notrace -nojournal -log <job>/vivado.log -source debug_cores.tcl
# 环境变量：VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JSON_OUT /
#           VMCP_DCP_FILE（可选；空则按 xpr→current impl run→<top>_routed.dcp 推导）/
#           VMCP_INCLUDE_NETS（T2 core 传入；1 时 ports[] 带 net）
# 成功标记：VMCP_DEBUG_DONE cores=<n>；失败：{"ok":false,"errors":[...]} + exit 1
# =============================================================================
source [file join [file dirname [info script]] lib_hw.tcl]
::hw::init

set dcp [::hw::derive_dcp]
set dcp [file normalize $dcp]
::hw::log "dcp=$dcp"
if {![file exists $dcp]} {
    ::hw::fail DCP_NOT_FOUND "dcp file not found: $dcp" "\"dcp\":[::hw::jstr $dcp]"
}

if {[catch { open_checkpoint $dcp } err]} {
    ::hw::fail DCP_OPEN_FAILED "open_checkpoint failed: [::hw::oneline $err]" "\"dcp\":[::hw::jstr $dcp]"
}
::hw::log "open_checkpoint ok"

if {[catch { set cores [get_debug_cores] } err]} {
    catch { close_design }
    ::hw::fail DEBUG_CORE_QUERY_FAILED "get_debug_cores failed: [::hw::oneline $err]" "\"dcp\":[::hw::jstr $dcp]"
}
if {$cores eq ""} { set cores [list] }

proc ::hw::_core_type {c} {
    foreach p {CORE_TYPE TYPE CORE CORE_TYPE_NAME} {
        set v [::hw::try_prop $p $c]
        if {$v ne ""} { return $v }
    }
    set n [string tolower [::hw::try_prop NAME $c $c]]
    if {[string match *ila* $n]} { return "ila" }
    if {[string match *vio* $n]} { return "vio" }
    if {[string match *dbg_hub* $n] || [string match *debug_hub* $n]} { return "dbg_hub" }
    return "unknown"
}

proc ::hw::_core_cell {c} {
    foreach p {CELL_NAME CELL CELL_NAME_FULL} {
        set v [::hw::try_prop $p $c]
        if {$v ne ""} { return $v }
    }
    return ""
}

proc ::hw::_ports_json {c include_nets} {
    set ports [list]
    if {[catch { set plist [get_debug_ports $c] } err]} {
        if {[catch { set plist [get_debug_ports -of_objects $c] } err2]} {
            return "\[\]"
        }
    }
    foreach p $plist {
        set parts [list]
        lappend parts "\"name\":[::hw::jstr [::hw::try_prop NAME $p $p]]"
        set dir [::hw::try_prop DIRECTION $p]
        if {$dir ne ""} { lappend parts "\"direction\":[::hw::jstr $dir]" }
        set width [::hw::try_prop WIDTH $p]
        if {$width ne ""} { lappend parts "\"width\":[expr {[string is integer -strict $width] ? $width : 1}]" }
        if {$include_nets} {
            set net [::hw::try_prop NET $p]
            if {$net eq ""} {
                if {[catch { set n [get_nets -quiet -of_objects $p] } err3]} { set n "" }
                if {$n ne ""} { set net [::hw::try_prop NAME [lindex $n 0] $n] }
            }
            lappend parts "\"net\":[::hw::jstr $net]"
        }
        lappend ports "\{[join $parts ,]\}"
    }
    return "\[[join $ports ,]\]"
}

set include_nets $::hw::include_nets
set cores_json_items [list]
foreach c $cores {
    set cname [::hw::try_prop NAME $c $c]
    set ctype [::hw::_core_type $c]
    set cell  [::hw::_core_cell $c]
    set item "\{\"name\":[::hw::jstr $cname],\"type\":[::hw::jstr $ctype]"
    if {$cell ne ""} { append item ",\"cellName\":[::hw::jstr $cell]" }
    append item ",\"ports\":[::hw::_ports_json $c $include_nets]\}"
    lappend cores_json_items $item
}
set n_cores [llength $cores]

catch { close_design }
::hw::log "close_design done"

set body "{\"ok\":true,\"dcp\":[::hw::jstr $dcp],\"includeNets\":[::hw::jbool $include_nets],\"cores\":\[[join $cores_json_items ,]\],\"errors\":\[\]}"
::hw::emit_result $body
::hw::log "debug_cores ok dcp=$dcp cores=$n_cores elapsed=[::hw::elapsed]s"
puts "VMCP_DEBUG_DONE cores=$n_cores"
::hw::finish_ok
