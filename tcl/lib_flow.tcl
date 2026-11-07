# =============================================================================
# lib_flow.tcl — Vivado MCP 构建流程公共库（T1 所有）
#
# 设计原则（见 tools/vivado-mcp/SPEC.md §3）：
#   * 所有逻辑在 TCL 侧；MCP server 只做参数校验 / spawn / 日志解析
#   * 路径一律由 [info script] 推导绝对路径，禁止写死工程地址
#   * 每个 stage 都 reset_run 后重跑，避免复用旧结果造成“假通过”
#   * 不单独建 bitstream run，用 launch_runs impl -to_step write_bitstream
#   * 完成判定 = PROGRESS 100% + STATUS 含 Complete + 产物存在
#   * 不改用户工程：只有显式 VMCP_TOP / VMCP_ALLOW_MISSING_INCR 才修改内存中的工程设置，
#     不做 save_project；xpr 的备份/恢复由调用方（server 或 T1 实测脚本）负责
#
# 入参（环境变量，见 SPEC §3.1）：
#   VMCP_PROJECT_DIR / VMCP_XPR / VMCP_REPORT_DIR / VMCP_JOBS / VMCP_TOP /
#   VMCP_SYNTH_RUN / VMCP_IMPL_RUN / VMCP_STAGE / VMCP_ALLOW_MISSING_INCR
#
# 机器可读标记（server 只解析这些前缀，正常日志用 "INFO: [VMCP]" 前缀）：
#   VMCP_SYNTH_DONE progress=<p> status=<s> run=<r> elapsed_sec=<n>
#   VMCP_IMPL_DONE  progress=<p> status=<s> run=<r> elapsed_sec=<n>
#   VMCP_BITSTREAM_OK <绝对路径>
#   VMCP_REPORT <绝对路径>
#   VMCP_ERROR <单行原因>
#   VMCP_FINISH ok|fail
# =============================================================================

namespace eval ::vmcp {
    variable lib_dir     [file normalize [file dirname [info script]]]
    variable project_dir ""
    variable xpr         ""
    variable report_dir  ""
    variable jobs        4
    variable top_override ""
    variable extra_xdc   ""
    variable synth_run   ""
    variable impl_run    ""
    variable stage       "full"
    variable allow_missing_incr 1
    variable reports     [list]
    variable t_start     [clock seconds]
}

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
proc ::vmcp::env_or {name default} {
    if {[info exists ::env($name)]} {
        set v [string trim $::env($name)]
        if {$v ne ""} { return $v }
    }
    return $default
}

proc ::vmcp::log {msg} {
    puts "INFO: \[VMCP\] $msg"
    flush stdout
}

proc ::vmcp::timestamp {} {
    return [clock format [clock seconds] -format "%Y%m%d-%H%M%S"]
}

proc ::vmcp::elapsed {} {
    variable t_start
    return [expr {[clock seconds] - $t_start}]
}

# 安全读取属性：属性对某些对象类型无效时返回 default 而不是抛错
proc ::vmcp::try_prop {prop obj {default ""}} {
    if {[catch {set v [get_property $prop $obj]} err]} {
        return $default
    }
    return $v
}

# 单行化：marker 必须是一行，便于 server 逐行解析
proc ::vmcp::oneline {s} {
    return [string map {"\r" " " "\n" " | "} $s]
}

# ---------------------------------------------------------------------------
# 初始化参数
# ---------------------------------------------------------------------------
proc ::vmcp::init {} {
    variable lib_dir
    variable project_dir
    variable xpr
    variable report_dir
    variable jobs
    variable top_override
    variable extra_xdc
    variable synth_run
    variable impl_run
    variable stage
    variable allow_missing_incr
    variable t_start

    set t_start [clock seconds]
    set project_dir [env_or VMCP_PROJECT_DIR [file normalize [file join $lib_dir .. .. ..]]]
    set project_dir [file normalize $project_dir]
    if {![file isdirectory $project_dir]} {
        error "工程根目录不存在: $project_dir"
    }

    set env_xpr [env_or VMCP_XPR ""]
    if {$env_xpr ne ""} {
        set xpr [file normalize $env_xpr]
    } else {
        set found [glob -nocomplain -directory $project_dir *.xpr]
        if {[llength $found] != 1} {
            error "在 $project_dir 下应恰好有 1 个 *.xpr，实际 [llength $found] 个: $found（可用 VMCP_XPR 显式指定）"
        }
        set xpr [lindex $found 0]
    }
    if {![file exists $xpr]} {
        error "工程文件不存在: $xpr"
    }

    set report_dir [env_or VMCP_REPORT_DIR [file join $project_dir .vivado-mcp reports [timestamp]]]
    set report_dir [file normalize $report_dir]
    file mkdir $report_dir

    set jobs [env_or VMCP_JOBS 4]
    if {![string is integer -strict $jobs] || $jobs < 1 || $jobs > 64} {
        error "VMCP_JOBS 必须是 1..64 的整数，实际: $jobs"
    }
    set top_override [env_or VMCP_TOP ""]
    set extra_xdc    [env_or VMCP_EXTRA_XDC ""]
    set synth_run   [env_or VMCP_SYNTH_RUN ""]
    set impl_run    [env_or VMCP_IMPL_RUN ""]
    set stage       [string tolower [env_or VMCP_STAGE full]]
    set allow_missing_incr [env_or VMCP_ALLOW_MISSING_INCR 1]
    if {![string is boolean -strict $allow_missing_incr]} {
        error "VMCP_ALLOW_MISSING_INCR 必须是布尔值(1/0/true/false)，实际: $allow_missing_incr"
    }
    set allow_missing_incr [expr {$allow_missing_incr ? 1 : 0}]

    log "lib_dir=$lib_dir"
    log "project_dir=$project_dir"
    log "xpr=$xpr"
    log "report_dir=$report_dir"
    log "jobs=$jobs top_override='$top_override' extra_xdc='$extra_xdc' synth_run='$synth_run' impl_run='$impl_run' stage=$stage allow_missing_incr=$allow_missing_incr"
    log "vivado=[version -short]"
}

# ---------------------------------------------------------------------------
# 打开工程（含 GUI/锁检测；不改工程、不 save_project）
# ---------------------------------------------------------------------------
proc ::vmcp::open_project_checked {} {
    variable project_dir
    variable xpr

    # 工程锁：GUI 会话占用时 batch open_project 会失败，提前给出可读报错
    set lock_files [list]
    foreach pat [list [file join $project_dir "*.lck"] [file join $project_dir ".Xil" "*.lck"]] {
        foreach f [glob -nocomplain $pat] { lappend lock_files $f }
    }
    if {[llength $lock_files] > 0} {
        error "工程疑似被其它 Vivado 会话锁定（发现锁文件: $lock_files），请关闭 GUI/其它构建进程后重试"
    }

    set old_pwd [pwd]
    cd $project_dir
    if {[catch { open_project $xpr } err]} {
        cd $old_pwd
        error "open_project 失败: [oneline $err]"
    }
    cd $old_pwd

    log "open_project ok xpr=$xpr"
    log "part=[get_property PART [current_project]]"
    log "constraints_files=[get_files -of_objects [get_filesets constrs_1]]"
    log "source_files=[llength [get_files -of_objects [get_filesets sources_1]]]"
}

# ---------------------------------------------------------------------------
# top 覆盖（VMCP_TOP；为空则用工程现有 top）
# ---------------------------------------------------------------------------
proc ::vmcp::apply_top_override {} {
    variable top_override
    set fs [current_fileset]
    set old_top [get_property top $fs]
    if {$top_override eq ""} {
        log "top=$old_top（工程现有 top，未覆盖）"
        return
    }
    if {[catch { set_property top $top_override $fs } err]} {
        error "设置 top=$top_override 失败: [oneline $err]"
    }
    catch { update_compile_order -fileset $fs }
    set new_top [get_property top $fs]
    log "top_override old=$old_top new=$new_top fileset=[current_fileset]"
    if {$new_top ne $top_override} {
        error "top 覆盖未生效：期望 $top_override，实际 $new_top"
    }
}

# ---------------------------------------------------------------------------
# 追加临时约束文件（VMCP_EXTRA_XDC；只在内存工程里 add_files，不 save_project）
# 用途：当工程自带 XDC 与当前 top 端口不匹配、导致 write_bitstream 的
# NSTD-1/UCIO-1 DRC 阻塞时，用一个“与当前 top 匹配”的临时 XDC 完成可解释的流程验证。
# ---------------------------------------------------------------------------
proc ::vmcp::apply_extra_xdc {} {
    variable extra_xdc
    if {$extra_xdc eq ""} {
        log "extra_xdc=''（不追加临时约束）"
        return
    }
    set path [file normalize $extra_xdc]
    if {![file exists $path]} {
        error "VMCP_EXTRA_XDC 指定的文件不存在: $path"
    }
    # Vivado 12-172：add_files 对含空格路径的分词不可靠，切到目录后用相对文件名添加
    set xdir [file dirname $path]
    set xname [file tail $path]
    set old_pwd [pwd]
    cd $xdir
    if {[catch { add_files -fileset constrs_1 -norecurse $xname } err]} {
        cd $old_pwd
        error "add_files 追加临时 XDC 失败: [oneline $err]"
    }
    cd $old_pwd
    # 找到刚加入的文件对象（按 basename 匹配），设置 USED_IN（内存中修改，不 save_project）
    set added ""
    foreach f [get_files -of_objects [get_filesets constrs_1]] {
        if {[file tail $f] eq $xname} { set added $f; break }
    }
    if {$added ne ""} {
        catch { set_property USED_IN {synthesis implementation} $added }
    }
    log "已注入 extra xdc: $path（仅内存，不写工程；不 save_project）"
    log "constraints_files=[get_files -of_objects [get_filesets constrs_1]]"
}

# ---------------------------------------------------------------------------
# 从 xpr 文本中解析 State="current" 的 run（只读，不修改 xpr）
# 这是 Vivado 工程里“当前 run”的权威标记，lib 里用作 env 未指定时的兜底。
# ---------------------------------------------------------------------------
proc ::vmcp::current_run_from_xpr {impl_expected} {
    variable xpr
    set fh [open $xpr r]
    set data [read $fh]
    close $fh
    if {$impl_expected} {
        set type "Ft2:EntireDesign"
    } else {
        set type "Ft3:Synth"
    }
    set re "<Run Id=\"(\[^\"\]+)\" Type=\"$type\"\[^>\]*State=\"current\""
    if {[regexp $re $data -> run]} {
        return $run
    }
    return ""
}

proc ::vmcp::runs_by_kind {impl_expected} {
    variable project_dir
    set part [get_property PART [current_project]]
    set matches [list]
    foreach r [get_runs] {
        if {$impl_expected} {
            if {[try_prop IS_IMPLEMENTATION [get_runs $r] 0] ne "1"} { continue }
        } else {
            if {[try_prop IS_SYNTHESIS [get_runs $r] 0] ne "1"} { continue }
        }
        set rpart [try_prop PART [get_runs $r] ""]
        if {$rpart ne "" && $rpart ne $part} { continue }
        lappend matches $r
    }
    return $matches
}

# ---------------------------------------------------------------------------
# 解析 synth run / impl run
# ---------------------------------------------------------------------------
proc ::vmcp::resolve_runs {} {
    variable synth_run
    variable impl_run

    # ---- impl run ----
    if {$impl_run eq ""} {
        set impl_run [current_run_from_xpr 1]
        if {$impl_run ne ""} {
            log "impl_run 由 xpr State=\"current\" 解析: $impl_run"
        } else {
            set cands [runs_by_kind 1]
            if {[llength $cands] == 0} {
                error "工程中没有当前器件([get_property PART [current_project]])的 impl run，可用 VMCP_IMPL_RUN 指定"
            }
            set impl_run [lindex [lsort $cands] end]
            log "impl_run 由 run 列表兜底选择: $impl_run（候选 $cands）"
        }
    }
    if {[llength [get_runs $impl_run]] == 0} {
        error "指定的 impl run 不存在: $impl_run"
    }
    if {[try_prop IS_IMPLEMENTATION [get_runs $impl_run] 0] ne "1"} {
        error "$impl_run 不是 impl run"
    }
    log "impl_run=$impl_run dir=[try_prop DIRECTORY [get_runs $impl_run]]"

    # ---- synth run ----
    if {$synth_run eq ""} {
        set synth_run [current_run_from_xpr 0]
        if {$synth_run ne ""} {
            log "synth_run 由 xpr State=\"current\" 解析: $synth_run"
        } else {
            set cands [runs_by_kind 0]
            if {[llength $cands] == 0} {
                error "工程中没有当前器件的 synth run，可用 VMCP_SYNTH_RUN 指定"
            }
            set synth_run [lindex [lsort $cands] end]
            log "synth_run 由 run 列表兜底选择: $synth_run（候选 $cands）"
        }
    }
    if {[llength [get_runs $synth_run]] == 0} {
        error "指定的 synth run 不存在: $synth_run"
    }
    log "synth_run=$synth_run dir=[try_prop DIRECTORY [get_runs $synth_run]]"
}

# ---------------------------------------------------------------------------
# 增量 checkpoint 缺失处置（SPEC §7）
#   * 取 INCREMENTAL_CHECKPOINT；为空表示未启用增量
#   * 路径不存在且 VMCP_ALLOW_MISSING_INCR=1 → set_property ... "" 后继续（日志留痕）
#   * 路径存在 → 原样保留（真实增量流程）
# ---------------------------------------------------------------------------
proc ::vmcp::fix_incremental_checkpoint {} {
    variable impl_run
    variable allow_missing_incr
    set run_obj [get_runs $impl_run]
    set incr [try_prop INCREMENTAL_CHECKPOINT $run_obj]
    if {$incr eq ""} {
        log "incremental_checkpoint run=$impl_run value=''（未启用增量）"
        return
    }
    set norm [file normalize $incr]
    set exists [expr {[file exists $norm] || [file isdirectory $norm]}]
    log "incremental_checkpoint run=$impl_run raw=$incr path=$norm exists=$exists isdir=[file isdirectory $norm]"
    if {$exists} {
        log "增量 checkpoint 存在，保留真实增量流程"
        return
    }
    if {!$allow_missing_incr} {
        error "增量 checkpoint 不存在: $norm（VMCP_ALLOW_MISSING_INCR=0，拒绝自动清空）"
    }
    # Vivado 12-7043：AUTO_INCREMENTAL_CHECKPOINT=true 时不允许手工改 INCREMENTAL_CHECKPOINT，
    # 必须先关闭自动增量，再清空缺失的 checkpoint 路径。
    set auto [try_prop AUTO_INCREMENTAL_CHECKPOINT $run_obj]
    log "incremental_checkpoint auto=$auto（清空前需置 false）"
    if {[catch { set_property AUTO_INCREMENTAL_CHECKPOINT 0 $run_obj } err]} {
        if {[catch { set_property AUTO_INCREMENTAL_CHECKPOINT false $run_obj } err2]} {
            error "关闭 AUTO_INCREMENTAL_CHECKPOINT 失败: [oneline $err] / [oneline $err2]"
        }
    }
    if {[catch { set_property INCREMENTAL_CHECKPOINT "" $run_obj } err]} {
        error "清空增量 checkpoint 失败: [oneline $err]"
    }
    set now [try_prop INCREMENTAL_CHECKPOINT $run_obj]
    set auto_now [try_prop AUTO_INCREMENTAL_CHECKPOINT $run_obj]
    log "incremental_checkpoint 已清空（原路径不存在，允许继续）: now='$now' auto=$auto_now"
}

# ---------------------------------------------------------------------------
# run 状态 / 日志统计
# ---------------------------------------------------------------------------
proc ::vmcp::run_log_path {run} {
    set dir [try_prop DIRECTORY [get_runs $run]]
    if {$dir eq ""} { return "" }
    if {[file pathtype $dir] ne "absolute"} {
        variable project_dir
        set dir [file join $project_dir $dir]
    }
    return [file join [file normalize $dir] runme.log]
}

proc ::vmcp::count_lines {path pattern} {
    if {$path eq "" || ![file exists $path]} { return -1 }
    set fh [open $path r]
    set data [read $fh]
    close $fh
    set n 0
    foreach line [split $data "\n"] {
        if {[regexp $pattern $line]} { incr n }
    }
    return $n
}

proc ::vmcp::report_run_stats {run} {
    set log [run_log_path $run]
    set errors [count_lines $log {^ERROR:}]
    set crit   [count_lines $log {^CRITICAL WARNING:}]
    set warns  [count_lines $log {^WARNING:}]
    log "run=$run runme_log=$log errors=$errors critical_warnings=$crit warnings=$warns"
}

# 完成校验：PROGRESS=100% 且 STATUS 含 Complete
proc ::vmcp::check_run_complete {run stage_name} {
    set progress [try_prop PROGRESS [get_runs $run]]
    set status   [try_prop STATUS [get_runs $run]]
    set needs    [try_prop NEEDS_REFRESH [get_runs $run]]
    log "$stage_name run=$run progress=$progress status='$status' needs_refresh=$needs"
    if {[string trim $progress] ne "100%"} {
        error "$stage_name 未完成: run=$run PROGRESS=$progress STATUS='$status'"
    }
    if {![regexp -nocase {complete} $status]} {
        error "$stage_name 状态异常: run=$run PROGRESS=$progress STATUS='$status'（未含 Complete）"
    }
    report_run_stats $run
}

# ---------------------------------------------------------------------------
# reset / launch / wait
# ---------------------------------------------------------------------------
proc ::vmcp::reset_run_checked {run} {
    set old_status [try_prop STATUS [get_runs $run]]
    set old_progress [try_prop PROGRESS [get_runs $run]]
    log "reset_run run=$run previous_progress=$old_progress previous_status='$old_status'"
    if {[catch { reset_run $run } err]} {
        error "reset_run $run 失败: [oneline $err]"
    }
    # 日志卫生：Vivado 的 <run>/runme.log 跨 reset/多次构建只会追加、不会清空；
    # launch_runs/wait_on_run 会把整段 runme.log 回放到本 job 的 run.log/vivado.log，
    # 于是历史运行（尤其上一次失败 job）的 ERROR 会被判定器当成本次失败。
    # 在 reset_run 成功后删除当前 run 的 runme.log，确保本次 job 只看到本次运行的日志。
    set rlog [run_log_path $run]
    if {$rlog ne "" && [file exists $rlog]} {
        if {[catch { file delete -force -- $rlog } err]} {
            log "WARNING: 清理 runme.log 失败（降级为 warning，不影响构建）: $rlog : [oneline $err]"
        } else {
            log "runme.log 已清空（避免历史日志污染当前 job 判定）: $rlog"
        }
    } else {
        log "runme.log 不存在（reset 后无需清理）: '$rlog'"
    }
}

# 注意：Vivado 2018.3 的 launch_runs 是 C++ 实现，对 Tcl {*} 展开的参数列表行为异常
# （实测 `launch_runs $run {*}[list -jobs 4]` 会报 Unknown option '-jobs 4'），
# 因此这里用显式参数写死，不做动态展开。
proc ::vmcp::launch_synth {run jobs} {
    log "launch_runs $run -jobs $jobs"
    if {[catch { launch_runs $run -jobs $jobs } err]} {
        error "launch_runs $run 失败: [oneline $err]"
    }
    if {[catch { wait_on_run $run } err]} {
        error "wait_on_run $run 失败: [oneline $err]"
    }
}

proc ::vmcp::launch_impl_bitstream {run jobs} {
    log "launch_runs $run -to_step write_bitstream -jobs $jobs"
    if {[catch { launch_runs $run -to_step write_bitstream -jobs $jobs } err]} {
        error "launch_runs $run 失败: [oneline $err]"
    }
    if {[catch { wait_on_run $run } err]} {
        error "wait_on_run $run 失败: [oneline $err]"
    }
}

# ---------------------------------------------------------------------------
# 报告生成
# ---------------------------------------------------------------------------
proc ::vmcp::emit_report {path} {
    variable reports
    set path [file normalize $path]
    lappend reports $path
    puts "VMCP_REPORT $path"
    flush stdout
}

proc ::vmcp::write_synth_reports {} {
    variable synth_run
    variable report_dir
    set base [file join $report_dir "synth"]
    log "open_run $synth_run（生成综合报告）"
    if {[catch { open_run $synth_run } err]} {
        error "open_run $synth_run 失败: [oneline $err]"
    }
    set rc 0
    if {[catch { report_utilization -file ${base}_utilization.rpt } err]} {
        log "report_utilization 失败: [oneline $err]"; incr rc
    } else {
        emit_report ${base}_utilization.rpt
    }
    # 综合报告保持 -delay_type max：post-synth 没有真实的 hold 时序数据（insert_* 之前），
    # 生成 min_max 只会给出无意义的 hold 列；解析器会把 synth 报告判定为 timingScope=setup+pw。
    if {[catch { report_timing_summary -delay_type max -max_paths 3 -file ${base}_timing_summary.rpt } err]} {
        log "report_timing_summary 失败: [oneline $err]"; incr rc
    } else {
        emit_report ${base}_timing_summary.rpt
    }
    catch { close_design }
    if {$rc > 0} {
        error "综合报告生成有 $rc 项失败（见上方日志）"
    }
}

proc ::vmcp::write_impl_reports {} {
    variable impl_run
    variable report_dir
    set base [file join $report_dir "impl"]
    log "open_run $impl_run（生成实现报告）"
    if {[catch { open_run $impl_run } err]} {
        error "open_run $impl_run 失败: [oneline $err]"
    }
    set rc 0
    # 实现报告必须用 min_max：同时分析 setup(max) 与 hold(min)，报告 Table 才含 WHS/THS 列。
    # 报告解析侧据此判定 timingScope=setup+hold+pw（max 时 hold 未分析）。
    if {[catch { report_timing_summary -delay_type min_max -max_paths 3 -file ${base}_timing_summary.rpt } err]} {
        log "report_timing_summary(min_max) 失败: [oneline $err]"; incr rc
    } else {
        emit_report ${base}_timing_summary.rpt
    }
    if {[catch { report_utilization -file ${base}_utilization.rpt } err]} {
        log "report_utilization 失败: [oneline $err]"; incr rc
    } else {
        emit_report ${base}_utilization.rpt
    }
    if {[catch { report_power -file ${base}_power.rpt } err]} {
        log "report_power 失败: [oneline $err]"; incr rc
    } else {
        emit_report ${base}_power.rpt
    }
    if {[catch { report_drc -file ${base}_drc.rpt } err]} {
        log "report_drc 失败: [oneline $err]"; incr rc
    } else {
        emit_report ${base}_drc.rpt
    }
    # bus skew：catch 兜底、失败不致命（不计入 rc）。
    # 2018.3 实测（无 set_bus_skew 约束的工程）：命令成功并生成仅含表头 +
    #   "Bus Skew Report" + "No bus skew constraints" 的小报告，不会报错；有约束时
    #   生成 "Bus Skew Report Summary"（Id/Position/From/To/Corner/Requirement/Actual/Slack）。
    # 解析器以“是否存在 Summary 表 / 是否出现 No bus skew constraints”判定 applicable=false。
    if {[catch { report_bus_skew -warn_on_violation -file ${base}_bus_skew.rpt } err]} {
        log "report_bus_skew 失败（非致命，不影响构建）: [oneline $err]"
    } else {
        if {[file exists ${base}_bus_skew.rpt]} {
            emit_report ${base}_bus_skew.rpt
        } else {
            log "report_bus_skew 返回成功但未找到报告文件: ${base}_bus_skew.rpt"
        }
    }
    catch { close_design }
    if {$rc > 0} {
        error "实现报告生成有 $rc 项失败（见上方日志）"
    }
}

# ---------------------------------------------------------------------------
# 阶段：综合
# ---------------------------------------------------------------------------
proc ::vmcp::run_synth {} {
    variable synth_run
    variable jobs
    set t0 [clock seconds]
    fix_incremental_checkpoint
    reset_run_checked $synth_run
    launch_synth $synth_run $jobs
    check_run_complete $synth_run "综合"
    write_synth_reports
    set progress [try_prop PROGRESS [get_runs $synth_run]]
    set status   [try_prop STATUS [get_runs $synth_run]]
    puts "VMCP_SYNTH_DONE progress=$progress status=\"$status\" run=$synth_run elapsed_sec=[expr {[clock seconds]-$t0}]"
    flush stdout
}

# ---------------------------------------------------------------------------
# 阶段：实现 + 比特流
# ---------------------------------------------------------------------------
proc ::vmcp::verify_synth_ready {} {
    variable synth_run
    set progress [try_prop PROGRESS [get_runs $synth_run]]
    set status   [try_prop STATUS [get_runs $synth_run]]
    log "检查综合 run=$synth_run progress=$progress status='$status'"
    if {[string trim $progress] ne "100%" || ![regexp -nocase {complete} $status]} {
        error "综合尚未完成（run=$synth_run PROGRESS=$progress STATUS='$status'），请先执行 synth/build"
    }
}

proc ::vmcp::bit_file_path {} {
    variable impl_run
    variable project_dir
    set dir [try_prop DIRECTORY [get_runs $impl_run]]
    if {$dir eq ""} { return "" }
    if {[file pathtype $dir] ne "absolute"} { set dir [file join $project_dir $dir] }
    set dir [file normalize $dir]
    set top [try_prop TOP [get_runs $impl_run]]
    if {$top eq ""} { set top [get_property top [current_fileset]] }
    if {$top ne ""} {
        set expected [file join $dir "$top.bit"]
        if {[file exists $expected]} { return $expected }
    }
    set found [lsort [glob -nocomplain -directory $dir *.bit]]
    if {[llength $found] > 0} { return [lindex $found end] }
    return ""
}

proc ::vmcp::run_impl_bitstream {} {
    variable impl_run
    variable jobs
    set t0 [clock seconds]
    verify_synth_ready
    fix_incremental_checkpoint
    reset_run_checked $impl_run
    launch_impl_bitstream $impl_run $jobs
    check_run_complete $impl_run "实现(write_bitstream)"
    set progress [try_prop PROGRESS [get_runs $impl_run]]
    set status   [try_prop STATUS [get_runs $impl_run]]
    puts "VMCP_IMPL_DONE progress=$progress status=\"$status\" run=$impl_run elapsed_sec=[expr {[clock seconds]-$t0}]"
    flush stdout

    set bit [bit_file_path]
    if {$bit eq "" || ![file exists $bit]} {
        error "实现 run 完成但未找到 .bit 文件（run=$impl_run dir=[try_prop DIRECTORY [get_runs $impl_run]]）"
    }
    if {[file size $bit] <= 0} {
        error ".bit 文件存在但大小为 0: $bit"
    }
    log "bit=$bit size=[file size $bit] mtime=[clock format [file mtime $bit] -format {%Y-%m-%d %H:%M:%S}]"
    write_impl_reports
    puts "VMCP_BITSTREAM_OK $bit"
    flush stdout
}

# ---------------------------------------------------------------------------
# 主流程 / 失败出口
# ---------------------------------------------------------------------------
proc ::vmcp::main {mode} {
    variable stage
    init
    open_project_checked
    apply_top_override
    apply_extra_xdc
    resolve_runs

    set do_synth 0
    set do_impl 0
    switch -- $mode {
        synth { set do_synth 1 }
        impl  { set do_impl 1 }
        full  {
            switch -- $stage {
                synth     { set do_synth 1 }
                impl      { set do_impl 1 }
                bitstream { set do_impl 1 }
                full      { set do_synth 1; set do_impl 1 }
                default   { error "非法 VMCP_STAGE='$stage'（允许 synth/impl/bitstream/full）" }
            }
        }
        default { error "内部错误：未知 mode '$mode'" }
    }

    if {$do_synth} { run_synth }
    if {$do_impl}  { run_impl_bitstream }
    finish ok
}

proc ::vmcp::finish {result} {
    variable report_dir
    variable reports
    variable t_start
    set secs [expr {[clock seconds] - $t_start}]
    log "result=$result elapsed_sec=$secs report_dir=$report_dir reports=[llength $reports]"
    puts "VMCP_FINISH $result elapsed_sec=$secs"
    flush stdout
    if {$result eq "ok"} { exit 0 } else { exit 1 }
}

proc ::vmcp::fail {err {errorinfo ""}} {
    variable report_dir
    variable t_start
    set one [oneline $err]
    log "ERROR: $one"
    if {$errorinfo ne ""} {
        foreach line [split [oneline $errorinfo] "|"] {
            log "errorinfo:$line"
        }
    }
    puts "VMCP_ERROR $one"
    puts "VMCP_FINISH fail elapsed_sec=[expr {[clock seconds]-$t_start}] report_dir=$report_dir"
    flush stdout
    exit 1
}

# 供各脚本使用的统一入口：捕获所有 TCL 异常并输出 VMCP_ERROR / VMCP_FINISH fail
proc ::vmcp::run_script {mode} {
    if {[catch { main $mode } err opts]} {
        set info ""
        if {[dict exists $opts -errorinfo]} { set info [dict get $opts -errorinfo] }
        fail $err $info
    }
}
