# =============================================================================
# lib_hw.tcl — Round 3 硬件调试 TCL 公共库（T1 所有）
#
# 契约见 tools/vivado-mcp/SPEC_debug.md §2：
#   * 参数全部由环境变量传入（VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR /
#     VMCP_JSON_OUT / VMCP_HW_SERVER_URL / VMCP_BIT_FILE / VMCP_HW_DEVICE /
#     VMCP_VERIFY / VMCP_DCP_FILE；另支持 T2 core 传入的 VMCP_INCLUDE_NETS）
#   * 结构化结果一律写入 VMCP_JSON_OUT（UTF-8；Tcl 2018.3 无 JSON 库，手写转义）
#   * 失败也写 {"ok":false,"errors":[...]} 并 exit 1
#   * 机器标记（每行一个，T2 parseHwMarkers 解析）：
#       VMCP_HW_DONE targets=<n> devices=<n>
#       VMCP_PROGRAM_DONE programmed=1/0
#       VMCP_DEBUG_DONE cores=<n>
#       VMCP_RESULT_JSON <绝对路径>
#       VMCP_ERROR <一句话>
#       VMCP_FINISH ok|fail
#
# 重要实测事实（Vivado 2018.3）：
#   * 2018.3 用 `open_hw` 初始化硬件管理器（`open_hw_manager` 在 2018.3 不存在）；
#   * `connect_hw_server` 的 2018.3 语法没有 `-allow_non_jtag`（传了会报 Unknown option）；
#   * 本机连接 localhost:3121 时，若 hw_server 未运行，Vivado 会**自动拉起**本地
#     hw_server（实测进程出现、连接约 3s 成功）——因此“server 未启动”并不是连接失败；
#     真正的连接失败路径用不可达 URL（如 localhost:3199）验证，错误在 Vivado 日志中为
#     `ERROR: [Labtools 27-2223] Unable to connect to hw_server with URL "TCP:localhost:3199".`
#   * 无 JTAG 板卡时 `get_hw_targets` 会**报错**（`Labtoolstcl 44-199 No matching targets`），
#     按 SPEC“无设备 ok:true、数组为空”处理：捕获该错误并视为空列表。
# =============================================================================

namespace eval ::hw {
    variable lib_dir     [file normalize [file dirname [info script]]]
    variable project_dir ""
    variable xpr         ""
    variable report_dir  ""
    variable json_out    ""
    variable hw_url      "localhost:3121"
    variable include_nets 0
    variable verify      1
    variable t_start     [clock seconds]
    variable targets     [list]
    variable devices     [list]
    variable ilas        [list]
    variable vios        [list]
}

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
proc ::hw::env_or {name default} {
    if {[info exists ::env($name)]} {
        set v [string trim $::env($name)]
        if {$v ne ""} { return $v }
    }
    return $default
}

proc ::hw::log {msg} {
    puts "INFO: \[HW\] $msg"
    flush stdout
}

proc ::hw::oneline {s} {
    return [string map {"\r" " " "\n" " | "} $s]
}

proc ::hw::timestamp {} {
    return [clock format [clock seconds] -format "%Y%m%d-%H%M%S"]
}

proc ::hw::elapsed {} {
    variable t_start
    return [expr {[clock seconds] - $t_start}]
}

proc ::hw::try_prop {prop obj {default ""}} {
    if {[catch {set v [get_property $prop $obj]} err]} { return $default }
    if {$v eq ""} { return $default }
    return $v
}

# ---------------------------------------------------------------------------
# JSON 手写转义（保证 JSON.parse 可解析）
# ---------------------------------------------------------------------------
proc ::hw::json_escape {s} {
    set out ""
    foreach ch [split $s ""] {
        switch -- $ch {
            "\\" { append out "\\\\" }
            "\"" { append out "\\\"" }
            "\n" { append out "\\n" }
            "\r" { append out "\\r" }
            "\t" { append out "\\t" }
            default {
                if {[scan $ch %c code] == 1 && $code < 32} {
                    append out [format "\\u%04x" $code]
                } else {
                    append out $ch
                }
            }
        }
    }
    return $out
}

proc ::hw::jstr {s} {
    return "\"[json_escape $s]\""
}

proc ::hw::jbool {v} {
    if {$v} { return "true" }
    return "false"
}

proc ::hw::json_obj {pairs} {
    set parts [list]
    foreach {k v} $pairs {
        lappend parts "\"[json_escape $k]\":$v"
    }
    return "\{[join $parts ,]\}"
}

proc ::hw::json_named_list {names} {
    set items [list]
    foreach n $names { lappend items "{\"name\":[jstr $n]}" }
    return "\[[join $items ,]\]"
}

# ---------------------------------------------------------------------------
# 初始化 / 结构化输出 / 失败出口
# ---------------------------------------------------------------------------
proc ::hw::init {} {
    variable lib_dir
    variable project_dir
    variable xpr
    variable report_dir
    variable json_out
    variable hw_url
    variable include_nets
    variable verify
    variable t_start

    set t_start [clock seconds]
    set project_dir [env_or VMCP_PROJECT_DIR [file normalize [file join $lib_dir .. .. ..]]]
    set project_dir [file normalize $project_dir]
    if {![file isdirectory $project_dir]} {
        puts "VMCP_ERROR project directory not found: $project_dir"
        puts "VMCP_FINISH fail"
        flush stdout
        exit 1
    }
    set env_xpr [env_or VMCP_XPR ""]
    set xpr ""
    if {$env_xpr ne ""} {
        set xpr [file normalize $env_xpr]
    } else {
        set found [glob -nocomplain -directory $project_dir *.xpr]
        if {[llength $found] == 1} { set xpr [file normalize [lindex $found 0]] }
    }
    set report_dir [env_or VMCP_REPORT_DIR [file join $project_dir .vivado-mcp hw [timestamp]]]
    set report_dir [file normalize $report_dir]
    file mkdir $report_dir
    set json_out [env_or VMCP_JSON_OUT ""]
    if {$json_out eq ""} {
        puts "VMCP_ERROR missing required environment variable VMCP_JSON_OUT (structured result output path)"
        puts "VMCP_FINISH fail"
        flush stdout
        exit 1
    }
    set json_out [file normalize $json_out]
    file mkdir [file dirname $json_out]
    set hw_url [env_or VMCP_HW_SERVER_URL "localhost:3121"]
    set include_nets [expr {[env_or VMCP_INCLUDE_NETS 0] ? 1 : 0}]
    set verify [expr {[env_or VMCP_VERIFY 1] ? 1 : 0}]

    log "project_dir=$project_dir"
    log "xpr=$xpr"
    log "report_dir=$report_dir"
    log "json_out=$json_out"
    log "hw_server_url=$hw_url include_nets=$include_nets verify=$verify"
    log "vivado=[version -short]"
}

proc ::hw::write_json {text} {
    variable json_out
    set fh [open $json_out w]
    fconfigure $fh -encoding utf-8 -translation lf
    puts -nonewline $fh $text
    close $fh
    return [file normalize $json_out]
}

proc ::hw::emit_result {text} {
    variable json_out
    set p [write_json $text]
    puts "VMCP_RESULT_JSON $p"
    flush stdout
    return $p
}

proc ::hw::close_all {} {
    catch { disconnect_hw_server }
    catch { close_hw }
    catch { close_design }
}

proc ::hw::finish_ok {} {
    puts "VMCP_FINISH ok"
    flush stdout
    exit 0
}

# 失败出口：写 {"ok":false, ["<extra fields>",] "errors":[{code,message}]} + 标记 + exit 1
proc ::hw::fail {code message {extra_json ""}} {
    variable json_out
    close_all
    set err "{\"code\":[jstr $code],\"message\":[jstr $message]}"
    set body "{\"ok\":false"
    if {[string trim $extra_json] ne ""} {
        append body ",[string trim $extra_json]"
    }
    append body ",\"errors\":\[$err\]}"
    catch { write_json $body }
    log "ERROR $code: $message"
    puts "VMCP_ERROR $code: [oneline $message]"
    if {[file exists $json_out]} { puts "VMCP_RESULT_JSON [file normalize $json_out]" }
    puts "VMCP_FINISH fail"
    flush stdout
    exit 1
}

# ---------------------------------------------------------------------------
# hw_server / hardware manager
# ---------------------------------------------------------------------------
proc ::hw::open_manager {} {
    if {[catch { open_hw } err]} {
        fail HW_INIT_FAILED "open_hw failed to initialize hardware manager: [oneline $err]"
    }
    log "open_hw ok"
}

proc ::hw::connect {} {
    variable hw_url
    if {[catch { connect_hw_server -url $hw_url } err]} {
        # catch 只给 Common 17-39 的通用文本；具体原因在 vivado.log（如 Labtools 27-2223）
        fail HW_CONNECT_FAILED "connect_hw_server failed (url=$hw_url): [oneline $err]. Verify hw_server is running and the port is reachable (see Labtools 27-2223/27-2285 lines in vivado.log)."
    }
    log "connect_hw_server ok url=$hw_url"
}

proc ::hw::get_targets_safe {} {
    if {[catch { set tg [get_hw_targets] } err]} {
        # 2018.3 实测：没有 JTAG target/板卡时 get_hw_targets 报
        #   ERROR: [Labtoolstcl 44-199] No matching targets found on connected servers
        # 但 Tcl catch 只能拿到通用文本 'Common 17-39'；通过“hw_server 已连接”判定为空列表。
        set servers [list]
        catch { set servers [get_hw_servers] }
        if {[llength $servers] > 0} {
            log "get_hw_targets errored but hw_server is connected ([llength $servers]); treat as no target/no board: [oneline $err]"
            return [list]
        }
        error "get_hw_targets failed: [oneline $err]"
    }
    return $tg
}

proc ::hw::device_props {dev} {
    set name [try_prop NAME $dev $dev]
    set part [try_prop PART $dev]
    set jtag [try_prop JTAG_IDCODE $dev]
    set prog_raw [try_prop PROGRAMMABLE $dev]
    set programmable 0
    if {$prog_raw ne ""} {
        if {[catch { set programmable [expr {$prog_raw ? 1 : 0}] }]} { set programmable 0 }
    }
    set dna ""
    foreach p {DNA REGISTER.DNA DEVICE.DNA} {
        set dna [try_prop $p $dev]
        if {$dna ne ""} { break }
    }
    return [dict create name $name part $part jtagIdcode $jtag programmable $programmable dna $dna obj $dev]
}

# 打开所有 target 并枚举 devices/ilas/vios；target 保持打开，调用方负责 close_targets/close_all
proc ::hw::enumerate_open {} {
    variable targets
    variable devices
    variable ilas
    variable vios
    set targets [list]
    set devices [list]
    set ilas [list]
    set vios [list]

    set tg [get_targets_safe]
    set opened 0
    set open_errors [list]
    foreach t $tg {
        set tname [try_prop NAME $t $t]
        if {[catch { open_hw_target $t } err]} {
            lappend open_errors "$tname: [oneline $err]"
            log "open_hw_target failed target=$tname: [oneline $err]"
            continue
        }
        incr opened
        lappend targets $t
        log "open_hw_target ok target=$tname"
        if {[catch { set devs [get_hw_devices] } err]} {
            log "get_hw_devices failed target=$tname: [oneline $err]"
        } else {
            foreach d $devs {
                set info [device_props $d]
                dict set info target $t
                lappend devices $info
                log "device name=[dict get $info name] part=[dict get $info part] programmable=[dict get $info programmable]"
            }
        }
        if {[catch { set il [get_hw_ilas] } err]} { set il [list] }
        foreach i $il { lappend ilas [try_prop NAME $i $i] }
        if {[catch { set vi [get_hw_vios] } err]} { set vi [list] }
        foreach v $vi { lappend vios [try_prop NAME $v $v] }
    }
    if {[llength $tg] > 0 && $opened == 0} {
        error "all targets failed to open: [join $open_errors {; }]"
    }
    log "enumerate targets=[llength $targets] devices=[llength $devices] ilas=[llength $ilas] vios=[llength $vios]"
}

proc ::hw::close_targets {} {
    variable targets
    foreach t $targets { catch { close_hw_target $t } }
    set targets [list]
}

# 合并两段 "k":v 形式的 JSON 片段（空串自动省略）
proc ::hw::_merge_extra {base add} {
    set b [string trim $base]
    set a [string trim $add]
    if {$b eq ""} { return $a }
    if {$a eq ""} { return $b }
    return "$b,$a"
}

# 设备选择：selector 为空则 1 个设备自动选；>1 报 AMBIGUOUS_DEVICE；否则数字索引或 PART 匹配
proc ::hw::select_device {selector {extra_json ""}} {
    variable devices
    set n [llength $devices]
    if {$n == 0} {
        fail NO_HW_DEVICE "No JTAG device detected (available device list is empty). Check JTAG cable/board connection and power, then retry." \
            [_merge_extra $extra_json "\"availableDevices\":\[\]"]
    }
    if {$selector eq ""} {
        if {$n > 1} {
            fail AMBIGUOUS_DEVICE "Detected $n JTAG devices; cannot choose automatically. Pass a device index or PART (see availableDevices)." \
                [_merge_extra $extra_json "\"availableDevices\":\[[join [json_device_list] ,]\]"]
        }
        return [lindex $devices 0]
    }
    if {[string is integer -strict $selector]} {
        set idx [expr {int($selector)}]
        if {$idx < 0 || $idx >= $n} {
            fail DEVICE_NOT_FOUND "device index out of range: $selector (total $n devices, valid index 0..[expr {$n-1}])" \
                [_merge_extra $extra_json "\"availableDevices\":\[[join [json_device_list] ,]\]"]
        }
        return [lindex $devices $idx]
    }
    set matches [list]
    foreach d $devices {
        set part [dict get $d part]
        if {[string equal -nocase $part $selector] || [string match -nocase "*$selector*" $part]} {
            lappend matches $d
        }
    }
    if {[llength $matches] == 0} {
        fail DEVICE_NOT_FOUND "no JTAG device matches PART/name '$selector'" \
            [_merge_extra $extra_json "\"availableDevices\":\[[join [json_device_list] ,]\]"]
    }
    if {[llength $matches] > 1} {
        fail AMBIGUOUS_DEVICE "PART '$selector' matches multiple devices; use an index instead" \
            [_merge_extra $extra_json "\"availableDevices\":\[[join [json_device_list] ,]\]"]
    }
    return [lindex $matches 0]
}

proc ::hw::json_device_list {} {
    variable devices
    set out [list]
    foreach d $devices {
        lappend out "{\"name\":[jstr [dict get $d name]],\"part\":[jstr [dict get $d part]]}"
    }
    return $out
}

proc ::hw::device_json {d} {
    set parts [list]
    lappend parts "\"name\":[jstr [dict get $d name]]"
    lappend parts "\"part\":[jstr [dict get $d part]]"
    lappend parts "\"jtagIdcode\":[jstr [dict get $d jtagIdcode]]"
    lappend parts "\"programmable\":[jbool [dict get $d programmable]]"
    set dna [dict get $d dna]
    if {$dna ne ""} { lappend parts "\"dna\":[jstr $dna]" }
    return "\{[join $parts ,]\}"
}

# ---------------------------------------------------------------------------
# debug_cores 的 dcp 推导（不打开工程：只读 xpr 文本 + runs 目录）
#   VMCP_DCP_FILE 优先；否则 current impl run 的 <top>_routed.dcp，
#   再兜底 impl_* 目录下最新的 *_routed.dcp
# ---------------------------------------------------------------------------
proc ::hw::derive_dcp {} {
    variable project_dir
    variable xpr

    set env_dcp [env_or VMCP_DCP_FILE ""]
    if {$env_dcp ne ""} {
        set dcp [file normalize $env_dcp]
        if {![file exists $dcp]} {
            fail DCP_NOT_FOUND "VMCP_DCP_FILE dcp not found: $dcp" "\"dcp\":[jstr $dcp]"
        }
        return $dcp
    }

    set xpr_data ""
    if {$xpr ne "" && [file exists $xpr]} {
        set fh [open $xpr r]
        set xpr_data [read $fh]
        close $fh
    }
    set runs ""
    if {$xpr ne ""} { set runs "[file rootname $xpr].runs" }
    if {$runs eq "" || ![file isdirectory $runs]} {
        set cands [glob -nocomplain -type d -directory $project_dir *.runs]
        if {[llength $cands] > 0} { set runs [lindex $cands 0] }
    }
    if {$runs eq "" || ![file isdirectory $runs]} {
        fail DCP_NOT_FOUND "project runs directory not found; cannot derive default dcp; pass dcp_file explicitly" ""
    }

    set impl ""
    if {$xpr_data ne ""} {
        if {[regexp {<Run Id="([^"]+)" Type="Ft2:EntireDesign"[^>]*State="current"} $xpr_data -> r]} {
            set impl $r
        }
    }
    set run_dirs [list]
    if {$impl ne ""} {
        set d [file join $runs $impl]
        if {[file isdirectory $d]} { lappend run_dirs $d }
    }
    if {[llength $run_dirs] == 0} {
        foreach d [glob -nocomplain -type d -directory $runs impl_*] { lappend run_dirs $d }
    }

    set top ""
    if {$xpr_data ne ""} {
        if {[regexp {<Option Name="TopModule" Val="([^"]+)"} $xpr_data -> t]} { set top $t }
    }

    set candidates [list]
    foreach d $run_dirs {
        if {$top ne ""} {
            set p [file join $d "${top}_routed.dcp"]
            if {[file exists $p]} { lappend candidates $p }
        }
        foreach p [glob -nocomplain -directory $d *_routed.dcp] { lappend candidates $p }
    }
    if {[llength $candidates] == 0} {
        fail DCP_NOT_FOUND "cannot derive default dcp: runs=$runs impl=$impl top=$top has no *_routed.dcp; run impl/bitstream/full first or pass dcp_file explicitly" ""
    }
    set best [lindex $candidates 0]
    set best_mtime 0
    foreach p $candidates {
        set m [file mtime $p]
        if {$m > $best_mtime} { set best_mtime $m; set best $p }
    }
    log "derive_dcp: $best (candidates=[llength $candidates], picked newest mtime)"
    return [file normalize $best]
}

# ---------------------------------------------------------------------------
# bit 文件 SHA256（Windows certutil；用于烧写结果对账）
# ---------------------------------------------------------------------------
proc ::hw::sha256_file {path} {
    if {[catch { set out [exec certutil -hashfile $path SHA256] } err]} {
        log "certutil SHA256 failed: [oneline $err]"
        return ""
    }
    foreach line [split $out "\n"] {
        set clean [string map {" " "" "\r" "" "\t" ""} [string trim $line]]
        if {[regexp {^[0-9a-fA-F]{64}$} $clean]} {
            return [string toupper $clean]
        }
    }
    log "no SHA256 hex line found in certutil output"
    return ""
}
