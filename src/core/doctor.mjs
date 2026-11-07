// 环境体检（vivado_doctor / CLI doctor）：Vivado 工具链、工程发现、GUI/锁、目录可写、TCL 就绪度。
// 设计原则：数据来源标注清楚（xpr 解析 vs 启动 Vivado），已知环境噪音只作为 warning。
import path from 'node:path';
import { createProjectContext, ENV, resolveProject, resolveTclDir } from './config.mjs';
import { listJobs } from './jobs.mjs';
import { designTop, parseXpr, simTop, currentRuns, inspectRuns } from './project.mjs';
import {
  checkProjectAvailability,
  checkWritable,
  findVivadoCandidates,
  inspectTclScripts,
  inspectVivadoEnvironment,
} from './vivado.mjs';
import { pathExists, readTextFileOrNull, sha256 } from './util.mjs';

/**
 * @param {object} options
 * @param {string} [options.projectDir]
 * @param {boolean} [options.includeVersion] 是否执行 vivado -version（会启动 Vivado，约 2s~1min）
 */
export async function runDoctor({ projectDir, includeVersion = true, env = process.env, cwd = process.cwd() } = {}) {
  const checks = [];
  const warnings = [];
  const hints = [];
  const knownNoise = [];

  // 1. 工程发现
  let project = { found: false };
  let ctx = null;
  let parsed = null;
  try {
    const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
    ctx = createProjectContext(resolved.projectDir, resolved.xprPath);
    if (resolved.xprPath) {
      parsed = parseXpr(resolved.xprPath, ctx);
      const runs = await inspectRuns(parsed);
      const cur = currentRuns(parsed);
      project = {
        found: true,
        source: resolved.source,
        projectDir: ctx.projectDir,
        dataSource: 'xpr-parse（不启动 Vivado）',
        xpr: {
          path: ctx.xprPath,
          name: ctx.xprName,
          exists: await pathExists(ctx.xprPath),
          declaredPathInProject: parsed.declaredProjectPath,
        },
        part: parsed.part,
        design: { fileset: 'sources_1', top: designTop(parsed) },
        sim: { set: parsed.activeSimSet, top: simTop(parsed) },
        currentRun: { synth: cur.synth ? cur.synth.id : null, impl: cur.impl ? cur.impl.id : null },
        runs: runs.map((r) => ({ id: r.id, kind: r.kind, part: r.part, current: r.current, status: r.status, progress: r.progress })),
      };
      checks.push({ name: 'project', ok: true, message: `工程可读：${ctx.xprPath}` });
      if (parsed.declaredProjectPath && path.resolve(parsed.declaredProjectPath) !== path.resolve(ctx.xprPath)) {
        knownNoise.push({
          code: 'STALE_PROJECT_PATH',
          message: `xpr 里记录的工程路径是旧机器路径：${parsed.declaredProjectPath}（当前：${ctx.xprPath}）`,
          hint: 'Vivado 工程整体拷贝后常见，属已知噪音；不影响解析与构建。',
        });
      }
      const ipRepo = parsed.config?.IPOutputRepo || parsed.config?.IPStaticSourceDir;
      if (ipRepo && /^[A-Za-z]:[\\/]/.test(ipRepo)) {
        const expanded = ipRepo.replace(/\$PPRDIR/g, ctx.projectDir).replace(/\$PIPUSERFILESDIR/g, ctx.ipUserFilesDir);
        if (!(await pathExists(expanded))) {
          knownNoise.push({
            code: 'IP_OUTPUT_REPO_MISSING',
            message: `工程 IP Output Repository 指向不存在/其它机器的路径：${ipRepo}`,
            hint: '打开工程时可能出现 WARNING，属已知噪音；本项目未使用 IP 时可忽略。',
          });
        }
      }
      const simSet = parsed.fileSets.find((s) => s.type === 'SimulationSrcs');
      const wcfgRaw = simSet ? simSet.wcfgFilesRaw || [] : [];
      const missingWcfg = [];
      for (const raw of wcfgRaw) {
        const abs = raw
          .replace(/\$PPRDIR/g, ctx.projectDir)
          .replace(/\$PSRCDIR/g, ctx.srcsDir)
          .replace(/\$PRUNDIR/g, ctx.runsDir);
        if (!(await pathExists(path.normalize(abs)))) missingWcfg.push(raw);
      }
      if (missingWcfg.length > 0) {
        knownNoise.push({
          code: 'MISSING_WCFG',
          message: `仿真波形配置（wcfg）有 ${missingWcfg.length} 个引用缺失（来自其它机器路径）`,
          hint: '打开工程/仿真时 Vivado 会报 CRITICAL WARNING，属已知环境噪音，不影响 xvlog/xelab/xsim 批处理。',
        });
      }
      if (missingWcfg.length > 0) warnings.push(`缺失 wcfg：${missingWcfg.length} 个（已知噪音）`);
    } else {
      project = { found: false, projectDir: ctx.projectDir, dataSource: 'xpr-parse' };
      checks.push({ name: 'project', ok: false, message: `目录中没有 .xpr：${ctx.projectDir}` });
      hints.push(`设置 ${ENV.projectRoot}=<工程根> 或传 project_dir。`);
    }
  } catch (err) {
    project = { found: false, error: err && err.message ? err.message : String(err) };
    checks.push({ name: 'project', ok: false, message: project.error });
    if (err && err.hint) hints.push(err.hint);
  }

  // 2. Vivado 环境
  const vivadoEnv = await inspectVivadoEnvironment({
    projectDir: ctx ? ctx.projectDir : null,
    env,
    cachePath: ctx ? ctx.versionCachePath : null,
    includeVersion,
  });
  const versionInfo = vivadoEnv.version || null;
  const companions = vivadoEnv.companions || null;
  checks.push({
    name: 'vivado',
    ok: !!vivadoEnv.found,
    message: vivadoEnv.found
      ? `Vivado：${versionInfo ? `v${versionInfo.version}` : '已找到（未探测版本）'} @ ${vivadoEnv.vivadoBin}`
      : '未找到 Vivado',
  });
  if (vivadoEnv.found && versionInfo) {
    checks.push({ name: 'vivado_version', ok: true, message: `-version 正常：v${versionInfo.version}${versionInfo.cached ? '（缓存）' : ''}` });
  } else if (vivadoEnv.found && includeVersion) {
    warnings.push(`无法解析 vivado -version 输出：${vivadoEnv.versionError || '未知原因'}`);
  }
  if (vivadoEnv.found) {
    if (companions && companions.allPresent) {
      checks.push({ name: 'xsim_tools', ok: true, message: `仿真工具齐全：${path.dirname(vivadoEnv.vivadoBin)}（xvlog/xelab/xsim）` });
    } else {
      checks.push({
        name: 'xsim_tools',
        ok: false,
        message: `缺少仿真工具：${companions ? (companions.missing || []).join(', ') : 'xvlog/xelab/xsim'}`,
      });
      hints.push('确认 VIVADO_BIN 指向 Vivado 的 bin 目录，且 xvlog.bat/xelab.bat/xsim.bat 存在。');
    }
  } else {
    hints.push(...(vivadoEnv.hint ? [vivadoEnv.hint] : []));
    checks.push({ name: 'xsim_tools', ok: false, message: '未找到 Vivado，无法检查仿真工具' });
  }

  // 3. GUI / 工程锁
  const availability = ctx
    ? await checkProjectAvailability({ projectDir: ctx.projectDir, env })
    : { ok: true, blockers: [], warnings: [], processes: [], lockFiles: [] };
  const guiRunning = (availability.processes || []).length > 0;
  checks.push({
    name: 'project_access',
    ok: availability.ok,
    message: availability.ok
      ? guiRunning
        ? `检测到 ${availability.processes.length} 个 vivado.exe；当前无工程锁`
        : '无 Vivado GUI 进程、无工程锁'
      : availability.blockers.map((b) => b.message).join('；'),
  });
  if (!availability.ok) for (const b of availability.blockers) hints.push(b.hint);
  if (guiRunning && availability.ok) warnings.push('检测到 vivado.exe 进程：若批处理构建，请确认它是无害的（例如本工具链自己的 job）。');

  // 4. 目录可写 + TCL 就绪 + jobs
  let writable = null;
  if (ctx) {
    writable = await checkWritable(ctx.runtimeDir);
    checks.push({
      name: 'writable',
      ok: writable.writable,
      message: writable.writable ? `运行期目录可写：${ctx.runtimeDir}` : `运行期目录不可写：${writable.error}`,
    });
    if (!writable.writable) hints.push('检查工程目录权限，或把工程复制到可写目录。');
  }
  const tclDir = resolveTclDir(env);
  const tcl = await inspectTclScripts(tclDir);
  checks.push({
    name: 'tcl_scripts',
    ok: tcl.complete,
    message: tcl.complete ? `TCL 构建脚本齐全：${tclDir}` : `TCL 构建脚本未就绪（缺 ${tcl.missing.join(', ')}）：${tclDir}`,
  });
  if (!tcl.complete) warnings.push('构建类工具暂不可用（T1 的 tcl/** 未就绪或目录不对），仿真/信息类工具不受影响。');

  let jobs = { jobs: [], count: 0 };
  if (ctx) {
    try {
      jobs = await listJobs({ projectDir: ctx.projectDir, limit: 5, env, cwd });
    } catch {
      /* ignore */
    }
  }
  const runningJobs = jobs.jobs.filter((j) => j.status === 'running' || j.status === 'starting');

  // 5. xpr 备份一致性（构建后恢复是否成功）
  if (ctx && parsed) {
    const backups = [];
    const fsPromises = (await import('node:fs/promises')).default;
    try {
      for (const entry of await fsPromises.readdir(ctx.backupDir, { withFileTypes: true })) {
        if (entry.isDirectory()) backups.push(entry.name);
      }
    } catch {
      /* ignore */
    }
    backups.sort((a, b) => b.localeCompare(a));
    if (backups.length > 0) {
      const latest = path.join(ctx.backupDir, backups[0], path.basename(ctx.xprPath));
      const [a, b] = await Promise.all([readTextFileOrNull(latest), readTextFileOrNull(ctx.xprPath)]);
      if (a != null && b != null && sha256(a) !== sha256(b)) {
        warnings.push(`当前 xpr 与最近备份 ${backups[0]} 不一致：如果刚跑完构建，说明 xpr 恢复失败或构建过程改写了工程文件，请人工核对。`);
      }
    }
  }

  const ok =
    !!(vivadoEnv.found && project.found) &&
    availability.ok &&
    (!writable || writable.writable) &&
    !runningJobs.some(() => false);

  return {
    ok,
    generatedAt: new Date().toISOString(),
    includeVersion,
    project,
    vivado: {
      found: !!vivadoEnv.found,
      bin: vivadoEnv.found ? vivadoEnv.vivadoBin : null,
      source: vivadoEnv.source || null,
      version: versionInfo ? { version: versionInfo.version, swBuild: versionInfo.swBuild, ipBuild: versionInfo.ipBuild, cached: !!versionInfo.cached } : null,
      versionError: vivadoEnv.versionError || null,
      companions,
      attempts: vivadoEnv.attempts || [],
      envValues: vivadoEnv.envValues || {},
    },
    access: {
      ok: availability.ok,
      guiProcesses: availability.processes || [],
      lockFiles: availability.lockFiles || [],
      blockers: availability.blockers || [],
      warnings: availability.warnings || [],
    },
    writable,
    tcl: { dir: tcl.dir, complete: tcl.complete, missing: tcl.missing, scripts: tcl.scripts },
    jobs: {
      count: jobs.count,
      running: runningJobs.map((j) => ({ id: j.id, stage: j.stage, status: j.status })),
      recent: jobs.jobs.slice(0, 5).map((j) => ({ id: j.id, kind: j.kind, stage: j.stage, status: j.status, startedAt: j.startedAt })),
    },
    checks,
    warnings: [...new Set(warnings)],
    knownNoise,
    hints: [...new Set(hints)],
    dataSourceNote: '工程/顶层/run 信息来自 .xpr 直接解析，不启动 Vivado（2018.3 无 get_property current_run 的可用性由 xpr 的 State="current" 替代）。',
  };
}
