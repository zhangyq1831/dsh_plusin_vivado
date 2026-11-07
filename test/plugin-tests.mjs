#!/usr/bin/env node
// Native Cordis plugin tests: register the tool surface on a fake context and exercise
// the execute path against a synthetic Vivado project fixture. Fully offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, name as pluginName, inject, resolveNodeBinary } from '../index.mjs';
import { listToolDefinitions } from '../src/mcp/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');
const FAKE_VIVADO = path.join(FIXTURES, 'fake-vivado', 'vivado.bat');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vivado-plugin-tests-'));
const ENV_KEYS = ['VIVADO_PROJECT_ROOT', 'VIVADO_BIN', 'VIVADO_MCP_NODE', 'VIVADO_MCP_ALLOW_EXTERNAL_VIVADO'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let pass = 0;
let fail = 0;
const failures = [];
async function test(title, fn) {
  const t0 = Date.now();
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${title}（${Date.now() - t0}ms）`);
  } catch (err) {
    fail += 1;
    failures.push({ title, err });
    console.log(`  ✗ ${title}`);
    console.log(String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).map((l) => `      ${l}`).join('\n'));
  }
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function check(value, message) {
  if (!value) throw new Error(message || 'assertion failed');
}
function includes(haystack, needle, message) {
  const ok = typeof haystack === 'string' ? haystack.includes(needle) : Array.isArray(haystack) && haystack.includes(needle);
  if (!ok) throw new Error(`${message || 'missing'}: ${JSON.stringify(needle)}`);
}

function newFakeProject(tag) {
  const dir = path.join(TMP, `proj-${tag}`);
  fs.cpSync(path.join(FIXTURES, 'fake-project'), dir, { recursive: true });
  return dir;
}

function makeFakeContext() {
  const registered = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {} },
    tools: {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
        registered.set(definition.name, definition);
        const dispose = () => registered.delete(definition.name);
        disposers.push(dispose);
        return dispose;
      },
    },
    effect(fn, label) {
      const dispose = fn();
      return { label, dispose, [Symbol.dispose]: dispose };
    },
    registered,
    disposeAll() {
      while (disposers.length) disposers.pop()();
    },
  };
  return ctx;
}

function withEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
}
function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

async function main() {
  const suiteStarted = Date.now();
  console.log(`Vivado plugin offline tests\npackage: ${ROOT}\ntmp: ${TMP}\n`);
  withEnv({ VIVADO_MCP_NODE: process.execPath, VIVADO_BIN: FAKE_VIVADO, VIVADO_PROJECT_ROOT: undefined, VIVADO_MCP_ALLOW_EXTERNAL_VIVADO: '1' });

  const definitions = listToolDefinitions();
  const expectedNames = definitions.map((d) => d.name).sort();

  await test('plugin exports name/inject and apply registers 14 tools', async () => {
    eq(pluginName, 'vivado-plugin');
    eq(JSON.stringify(inject), JSON.stringify(['tools']));
    eq(expectedNames.length, 14, 'tool definition count');
    const ctx = makeFakeContext();
    const result = apply(ctx, {});
    eq(result.toolCount, 14);
    eq(ctx.registered.size, 14);
    eq(JSON.stringify([...ctx.registered.keys()].sort()), JSON.stringify(expectedNames));
    for (const [toolName, def] of ctx.registered) {
      check(def.description && def.description.length > 10, `${toolName} description`);
      check(def.parameters && def.parameters.type === 'object', `${toolName} parameters must be an object schema`);
      eq(typeof def.execute, 'function', `${toolName} execute`);
      eq(typeof def.output.render, 'function', `${toolName} output.render`);
      eq(def.timeoutMs, 300000);
      check(Array.isArray(def.output.schema ? [def.output.schema] : null), `${toolName} output.schema`);
    }
    ctx.disposeAll();
    eq(ctx.registered.size, 0, 'dispose should unregister all tools');
  });

  await test('apply without configured project does not fall back to the package directory', async () => {
    const ctx = makeFakeContext();
    const result = apply(ctx, {});
    eq(result.projectDir, null);
    // The package directory must never be used as an implicit Vivado project.
    check(!process.env.VIVADO_PROJECT_ROOT, 'VIVADO_PROJECT_ROOT must stay unset');
    ctx.disposeAll();
  });

  await test('config.projectDir is resolved and exported to the process environment', async () => {
    const projDir = newFakeProject('config');
    const ctx = makeFakeContext();
    const result = apply(ctx, { projectDir: projDir, vivadoBin: FAKE_VIVADO });
    eq(result.projectDir, projDir);
    eq(process.env.VIVADO_PROJECT_ROOT, projDir);
    eq(process.env.VIVADO_BIN, FAKE_VIVADO);
    ctx.disposeAll();
  });

  await test('execute vivado_project_info against a synthetic project', async () => {
    const projDir = newFakeProject('execute');
    const ctx = makeFakeContext();
    apply(ctx, { projectDir: projDir });
    const def = ctx.registered.get('vivado_project_info');
    const value = await def.execute({}, { signal: { aborted: false } });
    check(value && typeof value.text === 'string' && value.text.length > 0, 'text output');
    eq(value.structured.ok, true);
    eq(value.structured.part, 'xc7a100tcsg324-1');
    eq(value.structured.design.top, 'fake_dut');
    eq(value.structured.sim.top, 'fake_tb');
    includes(value.text, 'xc7a100tcsg324-1');
    ctx.disposeAll();
  });

  await test('tool failures surface as thrown errors (job_status missing/unknown job)', async () => {
    const projDir = newFakeProject('errors');
    const ctx = makeFakeContext();
    apply(ctx, { projectDir: projDir });
    const status = ctx.registered.get('vivado_job_status');
    let missing = null;
    try {
      await status.execute({}, { signal: { aborted: false } });
    } catch (err) {
      missing = err;
    }
    check(missing, 'missing job_id should throw');
    includes(String(missing.message), 'job_id');
    let unknown = null;
    try {
      await status.execute({ job_id: 'does-not-exist' }, { signal: { aborted: false } });
    } catch (err) {
      unknown = err;
    }
    check(unknown, 'unknown job should throw');
    includes(String(unknown.message), '失败');
    ctx.disposeAll();
  });

  await test('resolveNodeBinary: explicit config wins, invalid config throws', async () => {
    const explicit = resolveNodeBinary({ configNodeBin: process.execPath, env: {}, execPath: process.execPath });
    eq(explicit.source, 'config.nodeBin');
    eq(explicit.path, process.execPath);
    let error = null;
    try {
      resolveNodeBinary({ configNodeBin: path.join(TMP, 'missing-node.exe'), env: {}, execPath: process.execPath });
    } catch (err) {
      error = err;
    }
    check(error, 'missing configured node should throw');
  });

  await test('package/bundle metadata is a valid public bundle', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    eq(pkg.name, 'dsh-vivado-plugin');
    eq(pkg.type, 'module');
    eq(pkg.dsh.bundle.patch, './cordis.patch.yml');
    eq(pkg.main, './index.mjs');
    for (const need of ['index.mjs', 'src', 'bin', 'tcl', 'locale', 'docs', 'skill']) {
      check(pkg.files.includes(need), `package.json files should include ${need}`);
    }
    const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
    includes(patch, 'id: vivado-plugin');
    includes(patch, 'name: dsh-vivado-plugin');
    check(!/[A-Za-z]:\\/.test(patch), 'cordis.patch.yml must not contain a local absolute path');
    for (const lang of ['en', 'zh']) {
      const locale = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', `${lang}.json`), 'utf8'));
      check(locale.meta && locale.meta.title && locale.meta.description, `${lang} locale metadata`);
    }
    includes(fs.readFileSync(path.join(ROOT, 'icon.svg'), 'utf8'), '<svg');
  });

  await test('all tool definitions are JSON-serializable and unique', () => {
    const names = definitions.map((d) => d.name);
    eq(new Set(names).size, names.length, 'tool names should be unique');
    for (const tool of definitions) {
      check(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} inputSchema`);
      JSON.stringify(tool.inputSchema);
    }
  });

  restoreEnv();
  const elapsed = ((Date.now() - suiteStarted) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Result: ${pass} passed, ${fail} failed（${elapsed}s）`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const item of failures) console.log(`  ✗ ${item.title}`);
    process.exit(1);
  }
  console.log('All passed ✅');
  fs.rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  restoreEnv();
  console.error('test framework error:', err && err.stack ? err.stack : err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
