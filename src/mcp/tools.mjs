// MCP 工具注册表：工具定义（中文 description + JSON Schema）+ tools/call 分发 + 中文文本渲染。
// 工具名/参数与 SPEC §4.2 一一对应；错误语义：协议层非法参数 -32602，工具参数/环境错误 → isError:true。
import { BUILD_STAGES, evaluateBuildJob, startBuildJob } from '../core/build.mjs';
import { runDoctor } from '../core/doctor.mjs';
import { McpError, toMcpError } from '../core/errors.mjs';
import { cancelJob, getJobOutput, getJobStatus, listJobs, waitJob } from '../core/jobs.mjs';
import { formatDurationMs, humanBytes, truncateText } from '../core/util.mjs';
import { getProjectInfo, listTestbenches } from '../core/project.mjs';
import { collectReports } from '../core/reports.mjs';
import { evaluateSimJob, startSimJob, SIM_TIMEOUT_DEFAULT_SEC, SIM_TIMEOUT_MAX_SEC } from '../core/sim.mjs';
import {
  DEFAULT_HW_SERVER_URL,
  evaluateHwJob,
  runDebugCores,
  runHwProgram,
  runHwScan,
  HW_TIMEOUT_DEFAULT,
  HW_TIMEOUT_RANGE,
} from '../core/hw.mjs';
import { RPC_ERROR, RpcError } from './protocol.mjs';

const PROJECT_DIR_PROP = {
  type: 'string',
  description: 'Vivado 工程根目录（含唯一 *.xpr）或 .xpr 文件路径；默认取环境变量 VIVADO_PROJECT_ROOT。',
};
const JOB_ID_PROP = { type: 'string', description: 'vivado_build_start / vivado_sim_start 返回的 job_id。' };

const TOOL_DEFINITIONS = [
  {
    name: 'vivado_doctor',
    description:
      'Vivado 环境体检（只读）：返回 Vivado 路径与版本、xvlog/xelab/xsim 是否齐全、工程发现（xpr/器件/顶层）、Vivado GUI 进程与工程锁、运行期目录可写性、TCL 构建脚本就绪度、最近 job、以及已知环境噪音提示。排查环境问题时先调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: PROJECT_DIR_PROP,
        include_version: { type: 'boolean', description: '是否执行 vivado -version 探测版本（默认 true；已有缓存时很快）。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_project_info',
    description:
      '读取工程信息（只读，不启动 Vivado）：直接解析 .xpr，返回工程路径、器件、design top、当前 sim set/top、当前 synth/impl run（含 SynthRun、current、进度、产物）、源文件与约束清单、最近产物与 xpr 备份。',
    inputSchema: {
      type: 'object',
      properties: { project_dir: PROJECT_DIR_PROP },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_list_testbenches',
    description:
      '列出 sim 文件集中的 testbench：module 名、文件、是否当前 sim top、依赖的模块与源文件、缺少哪些依赖、能否直接仿真。sim_1 里可能混有历史 TB（依赖不存在模块），启动仿真前应先用本工具确认。',
    inputSchema: {
      type: 'object',
      properties: { project_dir: PROJECT_DIR_PROP },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_sim_start',
    description:
      '异步启动一次仿真 job（xvlog → xelab → xsim，独立工作目录，不打开工程、不占工程锁），立即返回 job_id。之后用 vivado_job_wait/status/output 查询；判定通过需日志有 [PASS] 且无 Error（xsim 退出码 0 不代表通过）。',
    inputSchema: {
      type: 'object',
      properties: {
        testbench: { type: 'string', description: 'testbench 的 module 名或文件名；默认用 sim_1 的 TopModule。' },
        project_dir: PROJECT_DIR_PROP,
        timeout_sec: {
          type: 'number',
          description: `job 硬超时秒数（默认 ${SIM_TIMEOUT_DEFAULT_SEC}，范围 30~${SIM_TIMEOUT_MAX_SEC}），超时会杀进程树。`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_build_start',
    description:
      '异步启动一次构建 job（立即返回 job_id）。stage=synth（只综合）|impl（实现）|bitstream（实现+比特流）|full（综合+实现+比特流）。可覆盖 top / impl run / synth run / 并行度；可选 extra_xdc 注入构建冒烟约束（运行期 add_files 到内存工程，不修改、不保存工程文件）。启动前自动备份 *.xpr 到 .vivado-mcp/backup/，job 结束后恢复；同一工程同时只允许一个构建 job。失败时（如默认 XDC 下 write_bitstream 被 DRC NSTD-1/UCIO-1 拒绝）返回 ok=false，并在 failures[] 里给出错误码与失败阶段。',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: BUILD_STAGES, description: '构建阶段：synth | impl | bitstream | full（必填）。' },
        project_dir: PROJECT_DIR_PROP,
        top: { type: 'string', description: '覆盖 design top（可选；默认用工程现有 top）。' },
        run: { type: 'string', description: '覆盖实现 run 名（如 impl_2，可选）。' },
        synth_run: { type: 'string', description: '覆盖综合 run 名（如 synth_2，可选）。' },
        impl_run: { type: 'string', description: '同 run，覆盖实现 run 名的显式写法（可选）。' },
        jobs: { type: 'number', description: 'launch_runs 并行度（默认 4，范围 1~32）。' },
        extra_xdc: {
          type: 'string',
          description:
            '可选：额外约束 .xdc 的绝对路径（存在性校验）。仅用于构建冒烟（例如让无引脚约束的 top 能出 bit），由 TCL 运行期 add_files 注入内存工程，不修改、不保存工程文件。留空=不注入。',
        },
      },
      required: ['stage'],
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_job_status',
    description:
      '查询 job 状态（从磁盘恢复，MCP server 重启后仍可用）：running/done/failed/cancelled、阶段、进度百分比、耗时、结构化 failures[]、产物（日志/bit/报告）。对于已结束的 job 会给出最终判定 ok。',
    inputSchema: {
      type: 'object',
      properties: { job_id: JOB_ID_PROP, project_dir: PROJECT_DIR_PROP },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_job_wait',
    description:
      '等待 job 结束（轮询），默认 120 秒、上限 240 秒。超时返回 running + 当前进度（不会杀 job）；可后续继续 wait 或 status。job 结束后返回最终判定 ok 与 failures。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: JOB_ID_PROP,
        timeout_sec: { type: 'number', description: '最长等待秒数（默认 120，上限 240）。' },
        project_dir: PROJECT_DIR_PROP,
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_job_output',
    description: '读取 job 日志尾部（run.log；构建 job 另有 vivado.log 路径给出）。lines 默认 80、上限 400，超限会截断并说明。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: JOB_ID_PROP,
        lines: { type: 'number', description: '返回最后多少行（默认 80，上限 400）。' },
        project_dir: PROJECT_DIR_PROP,
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_job_cancel',
    description: '取消 job：杀整棵进程树（Windows taskkill /PID <pid> /T /F），并把状态落盘为 cancelled。对已结束的 job 返回 alreadyTerminal=true。',
    inputSchema: {
      type: 'object',
      properties: { job_id: JOB_ID_PROP, project_dir: PROJECT_DIR_PROP },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_job_list',
    description: '列出该工程最近的 jobs（倒序），含 stage/status/进度/判定摘要。默认 10 条、上限 50。',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: PROJECT_DIR_PROP,
        limit: { type: 'number', description: '返回条数（默认 10，上限 50）。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_reports',
    description:
      '解析构建报告并返回结构化数据：时序（Design Summary 的 setup WNS/TNS 与违例端点、pulse-width WPWS/TPWS；报告为 -delay_type min_max 时另含 hold WHS/THS，max 报告不含 hold；另有 Intra/Inter Clock 与 Other Path Groups 分表）、顶层 verdict（timingScope=setup+pw 或 setup+hold+pw 的 setup/hold/pulseWidth 判定，以及 bus skew 判定）、资源利用率（LUT/FF/BRAM/DSP/IOB 及百分比）、功耗（总功耗/动态/静态/结温/置信度）、bit 文件（路径/大小/时间）与 job 判定。可传 job_id 指定某次构建；不传则取工程最新报告目录。注意：max 报告的“约束满足”只覆盖 setup+pulseWidth。',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '指定构建 job 的报告（可选）。' },
        project_dir: PROJECT_DIR_PROP,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_hw_scan',
    description:
      '同步只读扫描 JTAG 硬件：确保 hw_server 可连（本地不可达时自动 detached 启动 hw_server.bat，已有实例不杀，最多等 15s），返回 targets/devices/ilas/vios。无 JTAG 板卡时 ok:true + devices:[]；hw_server 起不来或连接失败时 isError 并给修复建议。本机当前无板卡。',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: PROJECT_DIR_PROP,
        hw_server_url: { type: 'string', description: 'hw_server 地址，默认 localhost:3121（非本地地址不会自动启动 hw_server）。' },
        timeout_sec: { type: 'number', description: '等待上限秒数（默认 120，范围 30~300）。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_hw_program',
    description:
      '同步写操作：把显式指定的 .bit 烧写到 JTAG 设备（program_hw_devices），可选 verify。安全约定：bit_file 必须显式绝对路径且存在，不会自动选择最新 bit；结果含 bit SHA256 便于对账。无设备/设备不匹配/烧写失败时 ok:false + 结构化 failures（NO_HW_DEVICE/DEVICE_NOT_FOUND/AMBIGUOUS_DEVICE/PROGRAM_FAILED）。本机当前无板卡。',
    inputSchema: {
      type: 'object',
      properties: {
        bit_file: { type: 'string', description: '要烧写的 .bit 文件绝对路径（必填；存在性 + .bit 后缀校验；不会自动挑最新 bit）。' },
        device: { type: 'string', description: '目标设备：设备索引或 PART 片段（可选；不传时按 PART 自动匹配，多设备会报错要求指定）。' },
        verify: { type: 'boolean', description: '烧写后是否校验（默认 true）。' },
        project_dir: PROJECT_DIR_PROP,
        hw_server_url: { type: 'string', description: 'hw_server 地址，默认 localhost:3121。' },
        timeout_sec: { type: 'number', description: '等待上限秒数（默认 180，范围 60~300）。' },
      },
      required: ['bit_file'],
      additionalProperties: false,
    },
  },
  {
    name: 'vivado_debug_cores',
    description:
      '同步只读：open_checkpoint 分析 dcp 中的 debug cores（ILA/VIO 及其端口），不打开工程、不占工程锁、不改 xpr。dcp_file 可选；默认从工程 current impl run + design top 推导 <top>_routed.dcp。无 debug core 时 ok:true + cores:[]（本工程预期为空）。dcp 缺失时报 DCP_NOT_FOUND。',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: PROJECT_DIR_PROP,
        dcp_file: { type: 'string', description: '要分析的 .dcp 绝对路径（可选；不传则从 current impl run 推导 <top>_routed.dcp）。' },
        include_nets: { type: 'boolean', description: '是否在端口信息里包含 net 名（默认 false）。' },
      },
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

// ---------------------------------------------------------------------------
// 参数校验小工具
// ---------------------------------------------------------------------------

function textResult(text, structuredContent = undefined, isError = false) {
  const result = { content: [{ type: 'text', text: truncateText(text, 20000) }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  if (isError) result.isError = true;
  return result;
}

function errorResult(err) {
  const message = err && err.message ? err.message : String(err);
  const hint = err && err.hint ? err.hint : '';
  const code = err && err.code ? err.code : 'INTERNAL';
  const body = [`失败：${message}`];
  if (hint) body.push(`修复建议：${hint}`);
  body.push(`错误码：${code}`);
  return textResult(
    body.join('\n'),
    {
      ok: false,
      error: { code, message, hint, kind: err && err.kind ? err.kind : 'internal' },
    },
    true,
  );
}

function normalizeArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'tools/call 的 arguments 必须是 JSON 对象');
  }
  return args;
}

function assertKnownKeys(args, allowed, toolName) {
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new McpError(`参数不支持：${unknown.join(', ')}（工具 ${toolName}）`, {
      code: 'INVALID_ARGUMENT',
      kind: 'invalid_params',
      hint: `可用参数：${allowed.join(', ') || '（无）'}`,
    });
  }
}

function readString(args, name, toolName) {
  if (args[name] === undefined || args[name] === null) return undefined;
  if (typeof args[name] !== 'string') {
    throw new McpError(`参数 ${name} 必须是字符串（工具 ${toolName}）`, { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
  }
  const v = args[name].trim();
  return v === '' ? undefined : v;
}

function readBool(args, name, toolName) {
  if (args[name] === undefined || args[name] === null) return undefined;
  if (typeof args[name] !== 'boolean') {
    throw new McpError(`参数 ${name} 必须是布尔值（工具 ${toolName}）`, { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
  }
  return args[name];
}

function readNumber(args, name, toolName) {
  if (args[name] === undefined || args[name] === null) return undefined;
  const n = Number(args[name]);
  if (!Number.isFinite(n)) {
    throw new McpError(`参数 ${name} 必须是数字（工具 ${toolName}）`, { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
  }
  return n;
}

function clampInt(value, name, { min, max, def, toolName }) {
  if (value === undefined) return { value: def, clamped: false, note: '' };
  const rounded = Math.round(value);
  const clampedValue = Math.max(min, Math.min(max, rounded));
  const clamped = clampedValue !== rounded;
  return {
    value: clampedValue,
    clamped,
    note: clamped ? `${name} 超出范围 [${min}, ${max}]，已截断为 ${clampedValue}` : '',
  };
}

// ---------------------------------------------------------------------------
// 文本渲染
// ---------------------------------------------------------------------------

function renderDoctor(report) {
  const lines = [];
  lines.push(`Vivado 环境体检：${report.ok ? '通过 ✅' : '存在问题 ❌'}`);
  if (report.vivado?.found) {
    const v = report.vivado.version ? `v${report.vivado.version.version}` : '版本未知';
    lines.push(`- Vivado：${v}（${report.vivado.bin}，来源 ${report.vivado.source}）`);
    const comp = report.vivado.companions;
    lines.push(`- 仿真工具：${comp && comp.allPresent ? 'xvlog/xelab/xsim 齐全' : `缺少 ${comp ? (comp.missing || []).join(', ') : 'xvlog/xelab/xsim'}`}`);
  } else {
    lines.push(`- Vivado：未找到`);
  }
  if (report.project?.found) {
    lines.push(
      `- 工程：${report.project.xpr.name}（器件 ${report.project.part}）design top=${report.project.design.top}，sim set=${report.project.sim.set} top=${report.project.sim.top}`,
    );
    lines.push(`- 数据来源：${report.project.dataSource}`);
    lines.push(
      `- 当前 run：synth=${report.project.currentRun.synth || '无'}，impl=${report.project.currentRun.impl || '无'}`,
    );
  } else {
    lines.push(`- 工程：未找到（${report.project?.error || report.project?.projectDir || '未知'}）`);
  }
  lines.push(`- GUI/锁：${report.access.ok ? '无阻塞（无 GUI 进程/工程锁）' : report.access.blockers.map((b) => b.message).join('；')}`);
  if (report.writable) lines.push(`- 运行期目录：${report.writable.writable ? '可写' : `不可写（${report.writable.error}）`}`);
  lines.push(`- TCL 构建脚本：${report.tcl.complete ? '齐全' : `未就绪（缺 ${report.tcl.missing.join(', ')}）`}`);
  const runningJobs = report.jobs.running || [];
  lines.push(`- 最近 jobs：共 ${report.jobs.count} 个${runningJobs.length ? `，运行中 ${runningJobs.length} 个（${runningJobs.map((j) => j.id).join(', ')}）` : ''}`);
  if (report.knownNoise?.length) {
    lines.push(`- 已知环境噪音（不是工具链错误）：`);
    for (const n of report.knownNoise) lines.push(`  · [${n.code}] ${n.message}`);
  }
  if (report.checks?.length) {
    const failed = report.checks.filter((c) => !c.ok);
    if (failed.length) lines.push(`- 未通过的检查：${failed.map((c) => `${c.name}（${c.message}）`).join('；')}`);
  }
  if (report.warnings?.length) {
    lines.push(`- 警告：`);
    for (const w of report.warnings) lines.push(`  · ${w}`);
  }
  if (report.hints?.length) {
    lines.push(`- 建议：`);
    for (const h of report.hints) lines.push(`  · ${h}`);
  }
  return lines.join('\n');
}

function renderProjectInfo(info) {
  const lines = [];
  lines.push(`工程：${info.projectDir}`);
  lines.push(`- xpr：${info.xpr.name}（${humanBytes(info.xpr.size)}，修改于 ${info.xpr.mtime || '未知'}）`);
  lines.push(`- 器件：${info.part}${info.boardPart ? `，board=${info.boardPart}` : ''}`);
  lines.push(`- design：${info.design.fileset} top=${info.design.top}，源文件 ${info.design.sourceCount} 个${info.design.missing.length ? `（缺失 ${info.design.missing.length}）` : ''}`);
  lines.push(
    `- 约束：${info.constraints.fileset} ${info.constraints.count} 个（${info.constraints.files.map((f) => f.relative).join(', ') || '无'}）`,
  );
  lines.push(`- 仿真：set=${info.sim.set} top=${info.sim.top}，文件 ${info.sim.fileCount} 个（mode=${info.sim.mode || '未知'}）`);
  lines.push(`- 当前 run：synth=${info.currentRun.synth || '无'}，impl=${info.currentRun.impl || '无'}${info.currentRun.implSynthRun ? `（SynthRun=${info.currentRun.implSynthRun}）` : ''}`);
  if (info.runs.length) {
    lines.push(`- runs：`);
    for (const r of info.runs) {
      const flags = [r.current ? 'current' : null, `status=${r.status}`, r.progress != null ? `${r.progress}%` : null].filter(Boolean).join(', ');
      lines.push(`  · ${r.id}（${r.kind}, ${r.part || 'part未知'}）：${flags}`);
    }
  }
  if (info.artifacts?.latestBit) {
    lines.push(`- 最新 bit：${info.artifacts.latestBit.path}（${info.artifacts.latestBit.sizeHuman}，${info.artifacts.latestBit.mtime}）`);
  } else {
    lines.push(`- 最新 bit：无`);
  }
  if (info.artifacts?.recent?.length) {
    lines.push(`- 最近产物（前 ${Math.min(5, info.artifacts.recent.length)} 个）：`);
    for (const a of info.artifacts.recent.slice(0, 5)) lines.push(`  · ${a.relative}（${a.sizeHuman}，${a.mtime}）`);
  }
  if (info.xpr.latestBackup) lines.push(`- xpr 最近备份：${info.xpr.latestBackup.dir}`);
  lines.push(`（数据来源：直接解析 .xpr，不启动 Vivado）`);
  return lines.join('\n');
}

function renderTestbenches(report) {
  const lines = [];
  lines.push(`仿真集 ${report.simSet}：当前 top=${report.activeTop || '未设置'}，共 ${report.count} 个 testbench 文件`);
  const usable = report.testbenches.filter((t) => t.simulatable);
  lines.push(`- 可仿真：${usable.length} 个${usable.length ? `（${usable.map((t) => t.module).join(', ')}）` : ''}`);
  for (const tb of report.testbenches) {
    const flags = [tb.active ? '当前 sim top' : null, tb.simulatable ? '依赖齐全' : '依赖缺失'].filter(Boolean).join('，');
    lines.push(`  · ${tb.module || '(未识别 module)'} — ${tb.relative}（${flags}）`);
    if (tb.dependencies?.length) lines.push(`      依赖：${tb.dependencies.join(', ')}`);
    if (tb.missingDependencies?.length) lines.push(`      缺少：${tb.missingDependencies.join(', ')}（不可直接仿真）`);
    for (const w of tb.warnings || []) lines.push(`      注意：${w}`);
  }
  return lines.join('\n');
}

function renderJob(status, { title = null } = {}) {
  const lines = [];
  const head = title || `job ${status.id}`;
  const progress = status.progress?.percent != null ? `${status.progress.percent}%` : '未知';
  lines.push(`${head}：kind=${status.kind} stage=${status.stage} status=${status.status}${status.ok === true ? ' ✅ ok=true' : status.ok === false ? ' ❌ ok=false' : ''}`);
  lines.push(`- 进度：${progress}${status.progress?.stage ? `（${status.progress.stage}${status.progress.note ? `，${status.progress.note}` : ''}）` : ''}，耗时 ${formatDurationMs(status.elapsedMs || 0)}${status.exitCode != null ? `，退出码 ${status.exitCode}` : ''}`);
  if (status.failedStage) lines.push(`- 失败阶段：${status.failedStage}`);
  if (status.summary) lines.push(`- 摘要：${status.summary}`);
  if (status.testbench || status.meta?.testbench) lines.push(`- testbench：${status.testbench || status.meta.testbench}`);
  if (status.meta?.extraXdc || status.extraXdc) lines.push(`- 额外约束：已注入 extra xdc：${status.meta?.extraXdc || status.extraXdc}（仅内存注入，未修改工程文件）`);
  if (status.markers) {
    const m = [];
    if (status.markers.synthDone) m.push(`SYNTH_DONE(${status.markers.synthDone.progress ?? '?'}%)`);
    if (status.markers.implDone) m.push(`IMPL_DONE(${status.markers.implDone.progress ?? '?'}%)`);
    if (status.markers.bitstreamOk) m.push(`BITSTREAM_OK`);
    if (status.markers.lastFinish) m.push(`FINISH ${status.markers.lastFinish.ok ? 'ok' : 'fail'}`);
    if (m.length) lines.push(`- 完成标记：${m.join(', ')}`);
  }
  if (status.drcErrors?.length) {
    lines.push(`- DRC 错误（${status.drcErrors.length}）：`);
    for (const e of status.drcErrors.slice(0, 8)) lines.push(`  · [${e.code}] ${e.message}`);
  }
  if (status.failures?.length) {
    lines.push(`- 失败原因（${status.failures.length}）：`);
    for (const f of status.failures.slice(0, 8)) {
      const extra = [f.errorId ? `错误码 ${f.errorId}` : null, f.stage ? `阶段 ${f.stage}` : null, f.resolve ? `建议 ${f.resolve}` : null].filter(Boolean).join('，');
      lines.push(`  · [${f.code}] ${f.message}${extra ? `（${extra}）` : ''}`);
    }
  }
  if (status.checks?.length) {
    const failed = status.checks.filter((c) => !c.ok);
    if (failed.length) lines.push(`- 未通过检查：${failed.map((c) => c.name).join(', ')}`);
  }
  if (status.staleLogErrorCount > 0) {
    lines.push(`- 日志提示：检测到 ${status.staleLogErrorCount} 条历史回放 ERROR（发生在当前 flow 的 VMCP 标记之前，已降级为提示、不影响判定）`);
  }
  if (status.sim) {
    lines.push(`- 仿真统计：PASS=${status.sim.passCount}，Error=${status.sim.errorCount}，FAIL=${status.sim.failCount}，正常结束=${status.sim.finished}`);
    if (status.sim.passLabels?.length) lines.push(`  PASS 用例：${status.sim.passLabels.slice(0, 12).join('；')}`);
    if (status.sim.errorLabels?.length) lines.push(`  Error 用例：${status.sim.errorLabels.slice(0, 12).join('；')}`);
  }
  const artifacts = [];
  if (status.artifacts?.bitstream) artifacts.push(`bit=${status.artifacts.bitstream.path}（${status.artifacts.bitstream.exists ? status.artifacts.bitstream.sizeHuman : '不存在'}）`);
  if (status.bitstream && !status.artifacts?.bitstream) artifacts.push(`bit=${status.bitstream.path}（${status.bitstream.sizeHuman}）`);
  if (status.artifacts?.reports?.length) artifacts.push(`报告 ${status.artifacts.reports.length} 个 @ ${status.artifacts.reportDir}`);
  if (status.artifacts?.vivadoLog) artifacts.push(`vivado.log=${status.artifacts.vivadoLog}`);
  artifacts.push(`run.log=${status.logFile}`);
  lines.push(`- 产物：`);
  for (const a of artifacts) lines.push(`  · ${a}`);
  if (status.restoreXpr?.backupPath) lines.push(`- xpr 备份：${status.restoreXpr.backupPath}${status.xprRestored?.restoredAt ? '（job 结束已恢复）' : ''}`);
  lines.push(`- job 目录：${status.jobDir}`);
  return lines.join('\n');
}

function renderJobList(list) {
  const header = `工程 ${list.projectDir} 的最近 jobs（共 ${list.count} 个${list.truncated ? `，显示最近 ${list.returned} 个` : ''}）：`;
  const lines = [header];
  for (const j of list.jobs) {
    const progress = j.progressPercent != null ? ` ${j.progressPercent}%` : '';
    const simInfo = j.simPassCount != null ? `，PASS=${j.simPassCount}` : '';
    lines.push(`  · ${j.id}  kind=${j.kind} stage=${j.stage} status=${j.status}${progress}${simInfo}，耗时 ${formatDurationMs(j.elapsedMs || 0)}`);
  }
  if (list.note) lines.push(`- 说明：${list.note}`);
  return lines.join('\n');
}

function renderReports(report) {
  const dash = '—';
  const fmt = (v, unit = '') => (v === null || v === undefined ? dash : `${v}${unit}`);
  const usedOf = (entry) => {
    if (!entry) return dash;
    if (entry.utilPercent === null || entry.utilPercent === undefined) return `${entry.used}`;
    return `${entry.used} (${entry.utilPercent}%)`;
  };
  const scopeText = (scope) =>
    scope === 'setup+hold+pw' ? 'setup+hold+pulseWidth' : scope === 'setup+pw' ? 'setup+pulseWidth（不含 hold）' : '未知范围';
  const lines = [];
  lines.push(`报告汇总（来源：${report.source}${report.jobId ? `，job=${report.jobId}` : ''}）`);
  if (report.job) lines.push(`- job 判定：status=${report.job.status}${report.job.ok === true ? ' ✅' : report.job.ok === false ? ' ❌' : ''}${report.job.summary ? `，${report.job.summary}` : ''}`);
  const t = report.timing;
  if (t?.hasReport) {
    const ds = t.designSummary;
    const verdict = report.verdict;
    if (ds) {
      const parts = [
        `WNS=${fmt(ds.wns, 'ns')}`,
        `TNS=${fmt(ds.tns, 'ns')}`,
        `TNS 违例端点=${fmt(ds.tnsFailingEndpoints)}/${fmt(ds.tnsTotalEndpoints)}`,
      ];
      // 只有 min_max 报告才有 WHS/THS；max 报告不伪造 hold 数据
      if (ds.whs !== null && ds.whs !== undefined) parts.push(`WHS=${fmt(ds.whs, 'ns')}`);
      if (ds.ths !== null && ds.ths !== undefined) parts.push(`THS=${fmt(ds.ths, 'ns')}`);
      if (ds.thsFailingEndpoints !== null && ds.thsFailingEndpoints !== undefined) parts.push(`THS 违例端点=${fmt(ds.thsFailingEndpoints)}/${fmt(ds.thsTotalEndpoints)}`);
      parts.push(`WPWS=${fmt(ds.wpws, 'ns')}`, `TPWS=${fmt(ds.tpws, 'ns')}`);
      lines.push(`- 时序（Design Summary，${t.reportKind === 'min_max' ? 'min_max' : 'max'} 报告）：${parts.join(' ')}`);
    }
    if (verdict) {
      const metText = verdict.timingMet === null ? '未知' : verdict.timingMet ? '满足 ✅' : '不满足 ❌';
      lines.push(`- 时序判定（${scopeText(verdict.timingScope)}）：${metText}`);
      if (verdict.holdAnalyzed) lines.push(`  · hold：${verdict.holdMet === null ? '未知' : verdict.holdMet ? '满足' : '不满足'}（WHS/THS 已分析）`);
      if (verdict.busSkewAnalyzed) lines.push(`- bus skew 判定：${verdict.busSkewMet === null ? '未知' : verdict.busSkewMet ? '满足 ✅' : '不满足 ❌'}（${t.busSkew?.constraints ?? '?'} 条约束，最差 slack=${fmt(t.busSkew?.worstSlackNs, 'ns')}）`);
      else if (t.busSkew?.hasReport) lines.push(`- bus skew：报告存在但无约束（applicable=false）`);
    }
    if (t.constraintsMet !== null && t.constraintsMet !== undefined) {
      lines.push(`  约束满足（报告文本，范围=${scopeText(t.timingScope)}）：${t.constraintsMet ? '是' : '否'}`);
    }
    for (const c of (t.intraClock || []).slice(0, 6)) {
      const clockParts = [
        `WNS=${fmt(c.wns, 'ns')}`,
        `TNS=${fmt(c.tns, 'ns')}`,
        `违例端点=${fmt(c.tnsFailingEndpoints)}/${fmt(c.tnsTotalEndpoints)}`,
        `WPWS=${fmt(c.wpws, 'ns')}`,
      ];
      if (c.whs !== null && c.whs !== undefined) clockParts.push(`WHS=${fmt(c.whs, 'ns')}`);
      lines.push(`  · 时钟 ${c.clock || '?'}：${clockParts.join(' ')}`);
    }
    if ((t.interClock || []).length > 0) {
      const values = t.interClock.map((row) => row.wns).filter((v) => v !== null && v !== undefined);
      const worst = values.length > 0 ? Math.min(...values) : null;
      lines.push(`- 跨时钟路径（Inter Clock Table）：${t.interClock.length} 组，最差 WNS=${fmt(worst, 'ns')}`);
    }
    if ((t.otherPathGroups || []).length > 0) {
      const values = t.otherPathGroups.map((row) => row.wns).filter((v) => v !== null && v !== undefined);
      const worst = values.length > 0 ? Math.min(...values) : null;
      lines.push(`- Other Path Groups：${t.otherPathGroups.length} 行，最差 WNS=${fmt(worst, 'ns')}（独立归类，不覆盖 Design Summary）`);
    }
    for (const note of (t.notes || []).filter((n) => !/^报告为 -delay_type/.test(n))) lines.push(`  · 说明：${note}`);
  } else if (report.missing?.some((m) => /时序/.test(m))) lines.push('- 时序：未找到报告');
  const u = report.utilization;
  if (u?.hasReport) {
    const s = u.summary || {};
    const part = [];
    if (s.lut) part.push(`LUT=${usedOf(s.lut)}`);
    if (s.ff) part.push(`FF=${usedOf(s.ff)}`);
    if (s.bram) part.push(`BRAM=${usedOf(s.bram)}`);
    if (s.dsp) part.push(`DSP=${usedOf(s.dsp)}`);
    if (s.iob) part.push(`IOB=${usedOf(s.iob)}`);
    lines.push(`- 资源：${part.join('，') || '未解析到 LUT/FF/BRAM/DSP/IOB'}`);
  } else if (report.missing?.some((m) => /资源/.test(m))) lines.push('- 资源：未找到报告');
  const p = report.power;
  if (p?.hasReport) lines.push(`- 功耗：总 ${p.totalOnChipW ?? '?'}W（动态 ${p.dynamicW ?? '?'}W / 静态 ${p.deviceStaticW ?? '?'}W），置信度 ${p.confidence ?? '未知'}，结温 ${p.junctionTempC ?? '?'}C`);
  else if (report.missing?.some((m) => /功耗/.test(m))) lines.push('- 功耗：未找到报告');
  if (report.bitstream) lines.push(`- bit 文件：${report.bitstream.path}（${report.bitstream.sizeHuman || humanBytes(report.bitstream.size)}，${report.bitstream.mtime || '时间未知'}）`);
  else if (report.missing?.some((m) => /bit/.test(m))) lines.push('- bit 文件：无（需要 stage=bitstream/full 构建）');
  if (report.files?.length) lines.push(`- 报告文件（${report.files.length}）：${report.files.map((f) => f.name).join(', ')}`);
  for (const n of report.notes || []) lines.push(`- 说明：${n}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 硬件调试工具渲染（Round 3）
// ---------------------------------------------------------------------------

function renderHwServerInfo(info) {
  if (!info) return '未使用 hw_server';
  const flags = [];
  if (info.connected) flags.push('已连接');
  else if (info.skipped) flags.push('已跳过探测');
  else flags.push('未连接');
  if (info.launchedByTool) flags.push('本工具启动');
  if (info.pid) flags.push(`pid=${info.pid}`);
  return `${info.url}（${flags.join('，')}）${info.note ? `；${info.note}` : ''}`;
}

function renderHwScan(result) {
  const lines = [];
  lines.push(`硬件扫描（vivado_hw_scan，只读）：${result.ok ? '✅ ok=true' : '❌ ok=false'}，耗时 ${formatDurationMs(result.elapsedMs || 0)}，job=${result.jobId}`);
  lines.push(`- hw_server：${renderHwServerInfo(result.hwServer)}`);
  const targets = result.targets || [];
  const devices = result.devices || [];
  lines.push(`- targets：${targets.length} 个`);
  for (const target of targets.slice(0, 10)) lines.push(`  · ${typeof target === 'string' ? target : target.name || JSON.stringify(target)}`);
  lines.push(`- devices：${devices.length} 个${devices.length === 0 ? '（本机当前无 JTAG 板卡，属正常结果）' : ''}`);
  for (const device of devices.slice(0, 10)) {
    const bits = [device.name, device.part, device.jtagIdcode ? `idcode=${device.jtagIdcode}` : null, device.programmable === false ? '不可编程' : '可编程', device.dna ? `dna=${device.dna}` : null].filter(Boolean);
    lines.push(`  · ${bits.join(' / ')}`);
  }
  lines.push(`- ILA：${(result.ilas || []).length} 个；VIO：${(result.vios || []).length} 个`);
  for (const ila of (result.ilas || []).slice(0, 10)) lines.push(`  · ILA ${typeof ila === 'string' ? ila : ila.name || JSON.stringify(ila)}`);
  for (const vio of (result.vios || []).slice(0, 10)) lines.push(`  · VIO ${typeof vio === 'string' ? vio : vio.name || JSON.stringify(vio)}`);
  if (result.failures?.length) {
    lines.push(`- 失败原因（${result.failures.length}）：`);
    for (const failure of result.failures.slice(0, 8)) lines.push(`  · [${failure.code}] ${failure.message}`);
  }
  lines.push(`- 日志：${result.logFile}`);
  lines.push(`- 结果 JSON：${result.jsonPath}`);
  return lines.join('\n');
}

function renderHwProgram(result) {
  const lines = [];
  lines.push(`硬件烧写（vivado_hw_program，写操作）：${result.ok ? '✅ ok=true' : '❌ ok=false'}，耗时 ${formatDurationMs(result.elapsedMs || 0)}，job=${result.jobId}`);
  lines.push(`- bit：${result.bitFile}（${result.bitSizeHuman}）`);
  lines.push(`- SHA256：${result.bitSha256 || '（未计算）'}`);
  if (result.tclBitSha256) {
    lines.push(`- TCL SHA256：${result.tclBitSha256}（${result.bitSha256Matched ? '与本机文件一致' : '⚠ 与本机文件不一致'}）`);
  }
  if (result.availableDevices?.length) {
    lines.push(`- 可用设备：${result.availableDevices.map((d) => (typeof d === 'string' ? d : d.name || d.part || JSON.stringify(d))).join(', ')}`);
  } else if (result.ok === false && result.failures?.some((f) => f.code === 'NO_HW_DEVICE')) {
    lines.push('- 可用设备：无（本机无 JTAG 板卡）');
  }
  if (result.device) {
    const device = result.device;
    lines.push(`- device：${device.name || '?'}${device.part ? ` / ${device.part}` : ''}`);
  } else {
    lines.push('- device：未确认');
  }
  const verify = result.verify || {};
  lines.push(`- verify：requested=${verify.requested}，passed=${verify.passed === null || verify.passed === undefined ? '未知' : verify.passed}${verify.detail ? `（${verify.detail}）` : ''}`);
  if (result.programElapsedMs != null) lines.push(`- TCL 计时：programElapsedMs=${result.programElapsedMs}`);
  if (result.warnings?.length) {
    for (const warning of result.warnings) lines.push(`- 警告：${warning}`);
  }
  lines.push(`- hw_server：${renderHwServerInfo(result.hwServer)}`);
  if (result.concurrentBuild) lines.push(`- 注意：同工程有 build job 在运行（${result.concurrentBuild.jobId}，stage=${result.concurrentBuild.stage}）`);
  if (result.failures?.length) {
    lines.push(`- 失败原因（${result.failures.length}）：`);
    for (const failure of result.failures.slice(0, 8)) lines.push(`  · [${failure.code}] ${failure.message}`);
  }
  lines.push(`- 日志：${result.logFile}`);
  lines.push(`- 结果 JSON：${result.jsonPath}`);
  return lines.join('\n');
}

function renderDebugCores(result) {
  const lines = [];
  lines.push(`debug core 分析（vivado_debug_cores，只读，不打开工程）：${result.ok ? '✅ ok=true' : '❌ ok=false'}，耗时 ${formatDurationMs(result.elapsedMs || 0)}，job=${result.jobId}`);
  lines.push(`- dcp：${result.dcp}（来源：${result.dcpSource}${result.implRun ? `，impl run=${result.implRun}` : ''}${result.top ? `，top=${result.top}` : ''}）`);
  lines.push(`- include_nets：${result.includeNets}`);
  const cores = result.cores || [];
  lines.push(`- debug cores：${cores.length} 个${cores.length === 0 ? '（当前工程无 ILA/VIO，属正常结果）' : ''}`);
  for (const core of cores.slice(0, 10)) {
    lines.push(`  · ${core.name || '?'}（${core.type || 'unknown'}）${core.cellName ? ` cell=${core.cellName}` : ''}`);
    for (const port of (core.ports || []).slice(0, 12)) {
      lines.push(`      - ${port.name}：${port.direction || '?'}，width=${port.width ?? '?'}${port.net ? `，net=${port.net}` : ''}`);
    }
  }
  if (result.note) lines.push(`- 说明：${result.note}`);
  if (result.failures?.length) {
    lines.push(`- 失败原因（${result.failures.length}）：`);
    for (const failure of result.failures.slice(0, 8)) lines.push(`  · [${failure.code}] ${failure.message}`);
  }
  lines.push(`- 日志：${result.logFile}`);
  lines.push(`- 结果 JSON：${result.jsonPath}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 各工具 handler
// ---------------------------------------------------------------------------

async function evalTerminalJob(status) {
  if (status.kind === 'sim') return await evaluateSimJob(status);
  if (status.kind === 'build') return await evaluateBuildJob(status);
  if (status.kind === 'hw' || status.kind === 'debug') return await evaluateHwJob(status);
  return { ...status, ok: status.status === 'done' };
}

const HANDLERS = {
  async vivado_doctor(args) {
    assertKnownKeys(args, ['project_dir', 'include_version'], 'vivado_doctor');
    const projectDir = readString(args, 'project_dir', 'vivado_doctor');
    const includeVersion = readBool(args, 'include_version', 'vivado_doctor');
    const report = await runDoctor({ projectDir, includeVersion: includeVersion !== false });
    return textResult(renderDoctor(report), report);
  },

  async vivado_project_info(args) {
    assertKnownKeys(args, ['project_dir'], 'vivado_project_info');
    const projectDir = readString(args, 'project_dir', 'vivado_project_info');
    const info = await getProjectInfo({ projectDir });
    return textResult(renderProjectInfo(info), info);
  },

  async vivado_list_testbenches(args) {
    assertKnownKeys(args, ['project_dir'], 'vivado_list_testbenches');
    const projectDir = readString(args, 'project_dir', 'vivado_list_testbenches');
    const report = await listTestbenches({ projectDir });
    return textResult(renderTestbenches(report), report);
  },

  async vivado_sim_start(args) {
    assertKnownKeys(args, ['testbench', 'project_dir', 'timeout_sec'], 'vivado_sim_start');
    const testbench = readString(args, 'testbench', 'vivado_sim_start');
    const projectDir = readString(args, 'project_dir', 'vivado_sim_start');
    const timeoutRaw = readNumber(args, 'timeout_sec', 'vivado_sim_start');
    const timeout = clampInt(timeoutRaw, 'timeout_sec', { min: 30, max: SIM_TIMEOUT_MAX_SEC, def: SIM_TIMEOUT_DEFAULT_SEC, toolName: 'vivado_sim_start' });
    const started = await startSimJob({ projectDir, testbench, timeoutSec: timeout.value });
    const lines = [
      `已启动仿真 job：${started.job.id}`,
      `- testbench：${started.testbench.module}（${started.testbench.relative || started.testbench.file}）`,
      `- 工作目录：${started.workDir}`,
      `- 命令：`,
      `  · xvlog ${started.commands.xvlog.args.join(' ')}`,
      `  · xelab ${started.commands.xelab.args.join(' ')}`,
      `  · xsim ${started.commands.xsim.args.join(' ')}`,
      `- 下一步：vivado_job_wait({job_id:"${started.job.id}"}) 等待结果；再用 vivado_job_output 看日志。`,
      `- 判定标准：status=done、退出码 0、日志 [PASS]>0 且 Error=0；xsim 退出码 0 不代表测试通过。`,
    ];
    if (timeout.note) lines.push(`- 注意：${timeout.note}`);
    return textResult(lines.join('\n'), {
      ok: true,
      job_id: started.job.id,
      kind: 'sim',
      testbench: started.testbench.module,
      testbenchFile: started.testbench.relative || started.testbench.file,
      workDir: started.workDir,
      snapshot: started.snapshot,
      commands: {
        xvlog: { file: started.commands.xvlog.file, args: started.commands.xvlog.args },
        xelab: { file: started.commands.xelab.file, args: started.commands.xelab.args },
        xsim: { file: started.commands.xsim.file, args: started.commands.xsim.args },
      },
      timeoutSec: timeout.value,
      note: timeout.note || undefined,
      logFile: started.job.logFile,
      hint: '用 vivado_job_wait / vivado_job_status 查询进度与判定。',
    });
  },

  async vivado_build_start(args) {
    assertKnownKeys(args, ['stage', 'project_dir', 'top', 'run', 'synth_run', 'impl_run', 'jobs', 'extra_xdc'], 'vivado_build_start');
    const stage = readString(args, 'stage', 'vivado_build_start');
    if (!stage) throw new McpError('缺少必填参数 stage（synth|impl|bitstream|full）', { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
    const projectDir = readString(args, 'project_dir', 'vivado_build_start');
    const top = readString(args, 'top', 'vivado_build_start');
    const run = readString(args, 'run', 'vivado_build_start');
    const synthRun = readString(args, 'synth_run', 'vivado_build_start');
    const implRun = readString(args, 'impl_run', 'vivado_build_start');
    const extraXdc = readString(args, 'extra_xdc', 'vivado_build_start');
    const jobsRaw = readNumber(args, 'jobs', 'vivado_build_start');
    const jobs = clampInt(jobsRaw, 'jobs', { min: 1, max: 32, def: 4, toolName: 'vivado_build_start' });
    const started = await startBuildJob({ projectDir, stage, top, run, synthRun, implRun, jobs: jobs.value, extraXdc });
    const lines = [
      `已启动构建 job：${started.job.id}`,
      `- stage：${started.job.stage}（TCL：${started.tcl}）`,
      `- 工程：${started.ctx.projectDir}`,
      `- xpr 备份：${started.backup.backupPath}`,
      `- 覆盖参数：top=${top || '默认'}，synth_run=${started.runs.synth || '默认'}，impl_run=${started.runs.impl || '默认'}，jobs=${jobs.value}`,
      `- 报告目录：${started.reportDir}`,
      `- 额外约束：${started.extraXdc ? `已注入 extra xdc：${started.extraXdc}（仅内存注入，不改工程文件）` : '未注入（extra_xdc 为空）'}`,
      `- 下一步：vivado_job_wait({job_id:"${started.job.id}"})；构建分钟级，建议 wait 超时 240s 后继续轮询。`,
      `- 判定标准：退出码 0 + VMCP 完成标记 + bit 产物（bitstream/full）齐全；DRC ERROR 会结构化返回。`,
    ];
    if (jobs.note) lines.push(`- 注意：${jobs.note}`);
    for (const w of started.warnings) lines.push(`- 警告：${w}`);
    return textResult(lines.join('\n'), {
      ok: true,
      job_id: started.job.id,
      kind: 'build',
      stage: started.job.stage,
      projectDir: started.ctx.projectDir,
      xpr: started.ctx.xprPath,
      tcl: started.tcl,
      backup: started.backup,
      reportDir: started.reportDir,
      runs: started.runs,
      jobs: jobs.value,
      top: top || null,
      extra_xdc: started.extraXdc || null,
      warnings: started.warnings,
      timeoutSec: started.job.timeoutSec,
      logFile: started.job.logFile,
      hint: '用 vivado_job_wait / vivado_job_status 查询进度与判定；完成后用 vivado_reports 看报告。',
    });
  },

  async vivado_job_status(args) {
    assertKnownKeys(args, ['job_id', 'project_dir'], 'vivado_job_status');
    const jobId = readString(args, 'job_id', 'vivado_job_status');
    if (!jobId) throw new McpError('缺少必填参数 job_id', { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
    const projectDir = readString(args, 'project_dir', 'vivado_job_status');
    const status = await getJobStatus({ projectDir, jobId });
    const running = status.status === 'running' || status.status === 'starting';
    const evaluated = running ? status : await evalTerminalJob(status);
    return textResult(renderJob(evaluated, { title: `job ${evaluated.id}` }), { ok: running ? null : evaluated.ok, ...evaluated });
  },

  async vivado_job_wait(args, ctx) {
    assertKnownKeys(args, ['job_id', 'timeout_sec', 'project_dir'], 'vivado_job_wait');
    const jobId = readString(args, 'job_id', 'vivado_job_wait');
    if (!jobId) throw new McpError('缺少必填参数 job_id', { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
    const projectDir = readString(args, 'project_dir', 'vivado_job_wait');
    const timeoutRaw = readNumber(args, 'timeout_sec', 'vivado_job_wait');
    const timeout = clampInt(timeoutRaw, 'timeout_sec', { min: 1, max: 240, def: 120, toolName: 'vivado_job_wait' });
    const waited = await waitJob({
      projectDir,
      jobId,
      timeoutMs: timeout.value * 1000,
      shouldAbort: ctx && ctx.isCancelled ? () => ctx.isCancelled() : null,
    });
    const active = waited.status === 'running' || waited.status === 'starting';
    const evaluated = active ? waited : await evalTerminalJob(waited);
    const lines = [];
    if (evaluated.aborted) lines.push(`请求已被客户端取消（job 仍在后台运行，可稍后 vivado_job_status 查询）。`);
    else if (active && evaluated.timedOut) lines.push(`等待超时（${timeout.value}s）：job 仍在运行，进度 ${evaluated.progress?.percent ?? '未知'}%。可继续 vivado_job_wait 或 vivado_job_status。`);
    lines.push(renderJob(evaluated, { title: `job ${evaluated.id}` }));
    if (timeout.note) lines.push(`- 注意：${timeout.note}`);
    return textResult(lines.join('\n'), {
      ok: active ? null : evaluated.ok,
      timedOut: !!evaluated.timedOut,
      aborted: !!evaluated.aborted,
      waitedMs: evaluated.waitedMs,
      ...evaluated,
    });
  },

  async vivado_job_output(args) {
    assertKnownKeys(args, ['job_id', 'lines', 'project_dir'], 'vivado_job_output');
    const jobId = readString(args, 'job_id', 'vivado_job_output');
    if (!jobId) throw new McpError('缺少必填参数 job_id', { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
    const projectDir = readString(args, 'project_dir', 'vivado_job_output');
    const linesRaw = readNumber(args, 'lines', 'vivado_job_output');
    const lines = clampInt(linesRaw, 'lines', { min: 1, max: 400, def: 80, toolName: 'vivado_job_output' });
    const output = await getJobOutput({ projectDir, jobId, lines: lines.value });
    const body = output.lines.join('\n');
    const header = `job ${output.id} 日志尾部（${output.lines.length} 行；文件 ${output.logSizeHuman}）${output.note ? `：${output.note}` : ''}`;
    return textResult(`${header}\nlog: ${output.logFile}\n----\n${body}`, {
      ok: true,
      job_id: output.id,
      logFile: output.logFile,
      logSize: output.logSize,
      lines: output.lines,
      requested: output.linesRequested,
      truncated: output.truncated,
      note: output.note || (lines.note || ''),
    });
  },

  async vivado_job_cancel(args) {
    assertKnownKeys(args, ['job_id', 'project_dir'], 'vivado_job_cancel');
    const jobId = readString(args, 'job_id', 'vivado_job_cancel');
    if (!jobId) throw new McpError('缺少必填参数 job_id', { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
    const projectDir = readString(args, 'project_dir', 'vivado_job_cancel');
    const result = await cancelJob({ projectDir, jobId });
    const status = result.status;
    const lines = [];
    if (result.alreadyTerminal) {
      lines.push(`job ${status.id} 已经是终态（${status.status}），无需取消。`);
    } else if (result.cancelled) {
      lines.push(`已取消 job ${status.id}：进程树已终止，状态落盘为 cancelled。`);
    } else {
      lines.push(`已发出取消：job ${status.id}，但仍检测到存活进程 ${result.stillAlive.join(', ')}，请检查。`);
    }
    lines.push(renderJob(await evalTerminalJob(status)));
    return textResult(lines.join('\n'), { ok: result.alreadyTerminal ? status.status === 'done' : result.cancelled, ...result });
  },

  async vivado_job_list(args) {
    assertKnownKeys(args, ['project_dir', 'limit'], 'vivado_job_list');
    const projectDir = readString(args, 'project_dir', 'vivado_job_list');
    const limitRaw = readNumber(args, 'limit', 'vivado_job_list');
    const limit = clampInt(limitRaw, 'limit', { min: 1, max: 50, def: 10, toolName: 'vivado_job_list' });
    const list = await listJobs({ projectDir, limit: limit.value });
    const note = [list.note, limit.note].filter(Boolean).join('；');
    return textResult(renderJobList({ ...list, note }), { ok: true, ...list, note });
  },

  async vivado_reports(args) {
    assertKnownKeys(args, ['job_id', 'project_dir'], 'vivado_reports');
    const jobId = readString(args, 'job_id', 'vivado_reports');
    const projectDir = readString(args, 'project_dir', 'vivado_reports');
    const report = await collectReports({ projectDir, jobId });
    return textResult(renderReports(report), { ok: true, ...report });
  },

  async vivado_hw_scan(args) {
    assertKnownKeys(args, ['project_dir', 'hw_server_url', 'timeout_sec'], 'vivado_hw_scan');
    const projectDir = readString(args, 'project_dir', 'vivado_hw_scan');
    const hwServerUrl = readString(args, 'hw_server_url', 'vivado_hw_scan') || DEFAULT_HW_SERVER_URL;
    const timeoutRaw = readNumber(args, 'timeout_sec', 'vivado_hw_scan');
    const [min, max] = HW_TIMEOUT_RANGE.scan;
    const timeout = clampInt(timeoutRaw, 'timeout_sec', { min, max, def: HW_TIMEOUT_DEFAULT.scan, toolName: 'vivado_hw_scan' });
    const result = await runHwScan({ projectDir, hwServerUrl, timeoutSec: timeout.value });
    const lines = [renderHwScan(result)];
    if (timeout.note) lines.push(`- 注意：${timeout.note}`);
    return textResult(lines.join('\n'), {
      ok: result.ok,
      tool: 'vivado_hw_scan',
      ...result,
      timeout_sec: timeout.value,
      note: timeout.note || undefined,
    });
  },

  async vivado_hw_program(args) {
    assertKnownKeys(args, ['bit_file', 'device', 'verify', 'project_dir', 'hw_server_url', 'timeout_sec'], 'vivado_hw_program');
    const bitFile = readString(args, 'bit_file', 'vivado_hw_program');
    if (!bitFile) throw new McpError('缺少必填参数 bit_file（要烧写的 .bit 绝对路径）', { code: 'INVALID_ARGUMENT', kind: 'invalid_params' });
    const device = readString(args, 'device', 'vivado_hw_program');
    const verifyRaw = readBool(args, 'verify', 'vivado_hw_program');
    const verify = verifyRaw === undefined ? true : verifyRaw;
    const projectDir = readString(args, 'project_dir', 'vivado_hw_program');
    const hwServerUrl = readString(args, 'hw_server_url', 'vivado_hw_program') || DEFAULT_HW_SERVER_URL;
    const timeoutRaw = readNumber(args, 'timeout_sec', 'vivado_hw_program');
    const [min, max] = HW_TIMEOUT_RANGE.program;
    const timeout = clampInt(timeoutRaw, 'timeout_sec', { min, max, def: HW_TIMEOUT_DEFAULT.program, toolName: 'vivado_hw_program' });
    const result = await runHwProgram({ bitFile, device, verify, projectDir, hwServerUrl, timeoutSec: timeout.value });
    const lines = [renderHwProgram(result)];
    if (timeout.note) lines.push(`- 注意：${timeout.note}`);
    return textResult(lines.join('\n'), {
      ok: result.ok,
      tool: 'vivado_hw_program',
      ...result,
      timeout_sec: timeout.value,
      note: timeout.note || undefined,
    });
  },

  async vivado_debug_cores(args) {
    assertKnownKeys(args, ['project_dir', 'dcp_file', 'include_nets'], 'vivado_debug_cores');
    const projectDir = readString(args, 'project_dir', 'vivado_debug_cores');
    const dcpFile = readString(args, 'dcp_file', 'vivado_debug_cores');
    const includeNetsRaw = readBool(args, 'include_nets', 'vivado_debug_cores');
    const includeNets = includeNetsRaw === true;
    const result = await runDebugCores({ projectDir, dcpFile, includeNets });
    return textResult(renderDebugCores(result), { ok: result.ok, tool: 'vivado_debug_cores', ...result });
  },
};

/** tools/list 返回的定义（去掉内部字段，保证均为 JSON Schema 可序列化） */
export function listToolDefinitions() {
  return TOOL_DEFINITIONS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

// 文本渲染函数也导出给 CLI 复用，保证 MCP 与 CLI 输出风格一致
export { renderDoctor, renderProjectInfo, renderTestbenches, renderJob, renderJobList, renderReports, renderHwScan, renderHwProgram, renderDebugCores };

/**
 * tools/call 分发。
 * @param {string} name
 * @param {object} rawArgs
 * @param {{isCancelled?:()=>boolean}} [ctx]
 */
export async function callTool(name, rawArgs, ctx = {}) {
  const handler = HANDLERS[name];
  if (!handler) {
    throw new RpcError(RPC_ERROR.INVALID_PARAMS, `未知工具：${name}`, { available: TOOL_NAMES });
  }
  const args = normalizeArgs(rawArgs);
  try {
    return await handler(args, ctx);
  } catch (err) {
    if (err instanceof RpcError) throw err;
    return errorResult(toMcpError(err));
  }
}
