import { randomBytes } from 'node:crypto';
import { createServer as createTCPServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Processes, waitUntil, timeBudget, errorDetails } from './processes.mjs';
import { createGateway } from './gateway.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.resolve(web, '..', 'Server');
const pg = process.env.XBT_POSTGRES_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
const artifactRoot = process.env.XBT_E2E_ARTIFACTS;
const android = process.argv[2] === '--android';
const deadline = Date.now() + 30 * 60_000;
if (!artifactRoot || !path.isAbsolute(artifactRoot)) {
  throw new Error('请设置 XBT_E2E_ARTIFACTS 为独立验证产物的绝对路径');
}
mkdirSync(artifactRoot, { recursive: true });
const run = mkdtempSync(path.join(artifactRoot, 'web-e2e-'));
console.log(`隔离回归产物：${run}`);
const data = path.join(run, 'pgdata');
const dist = path.join(run, 'web-dist');
const log = openSync(path.join(run, 'commands.log'), 'a');
const secret = randomBytes(32).toString('hex');
const testDatabase = 'xbt_sign_location_test_e2e';
const testDSN = `postgresql://postgres@127.0.0.1:55432/${testDatabase}?sslmode=disable`;
const env = {
  ...process.env,
  VITE_API_BASE_URL: '/api',
  XBT_E2E_ISOLATED: '1',
  XBT_E2E_JWT_SECRET: secret,
  XBT_E2E_RESULTS: path.join(run, 'test-results'),
  XBT_TEST_POSTGRES_DSN: testDSN,
};
let gateway;
let fixture;
let failure;
let pgStarted = false;
const processes = new Processes();
writeFileSync(path.join(run, 'run-budget.json'), JSON.stringify({ startedAt: new Date().toISOString(), workDeadline: new Date(deadline).toISOString() }, null, 2));

function execute(command, args, cwd = web, input, timeout = 180_000) {
  return processes.run(command, args, { cwd, env, log }, timeBudget(deadline, timeout), input);
}

async function assertPortFree(port) {
  const probe = createTCPServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => probe.close(resolve));
}

try {
  await Promise.all([55432, 33030, 33081].map(assertPortFree));
  await execute(path.join(pg, 'initdb.exe'), ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  const postgres = processes.start(path.join(pg, 'postgres.exe'), ['-D', data, '-h', '127.0.0.1', '-p', '55432'], { stdio: ['ignore', log, log] });
  await waitUntil(async () => {
    if (postgres.startError || postgres.exitCode !== null) throw new Error('临时 PostgreSQL 提前退出');
    const code = await processes.run(path.join(pg, 'pg_isready.exe'), ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-t', '2'],
      { acceptedExitCodes: [0, 1, 2] }, timeBudget(deadline, 5000));
    return code === 0;
  }, timeBudget(deadline, 30_000), '临时数据库启动');
  pgStarted = true;
  await execute(path.join(pg, 'createdb.exe'), ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', testDatabase]);
  await execute('go', ['test', './...', '-count=1'], server);
  const binary = path.join(run, 'server-e2e.exe');
  await execute('go', ['build', '-o', binary, './cmd/server'], server);
  writeFileSync(path.join(run, 'config.yaml'), JSON.stringify({
    app_env: 'test', http_addr: '127.0.0.1:33030', postgres_dsn: testDSN,
    jwt_secret: secret, credential_secret: randomBytes(32).toString('hex'),
    amap: { api_key: '', campus_address: 'isolated-test' },
  }));
  const backend = processes.start(binary, [], { cwd: run, stdio: ['ignore', log, log] });
  await waitUntil(async () => {
    if (backend.startError || backend.exitCode !== null) throw new Error('临时后端提前退出');
    try { return (await fetch('http://127.0.0.1:33030/api/health', { signal: AbortSignal.timeout(3000) })).ok; }
    catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return false;
      throw error;
    }
  }, timeBudget(deadline, 30_000), '临时后端启动');
  await execute(path.join(pg, 'psql.exe'), ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', testDatabase, '-v', 'ON_ERROR_STOP=1'], web, `
    INSERT INTO users (uid,mobile,name,credential_cipher,permission) VALUES
      (99001,'e2e-admin','隔离管理员','intentionally-invalid-cipher',2),
      (99002,'e2e-user','隔离用户','intentionally-invalid-cipher',1);
    INSERT INTO user_courses (user_uid,course_id,class_id) VALUES (99002,99001,99001);
  `);
  await execute(process.execPath, [process.env.npm_execpath, 'run', 'lint', '--', '--max-warnings=0']);
  await execute(process.execPath, [process.env.npm_execpath, 'run', 'build', '--', '--outDir', dist]);
  const config = JSON.parse(readFileSync(path.join(run, 'config.yaml'), 'utf8'));
  const sensitive = [config.jwt_secret, config.credential_secret, config.postgres_dsn];
  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(dist, { recursive: true })) {
    if (!/\.(js|css|html|map)$/.test(name)) continue;
    const text = readFileSync(path.join(dist, name), 'utf8');
    if (/api_key|restapi\.amap\.com|postgres_dsn|jwt_secret|credential_secret|postgres(?:ql)?:\/\//i.test(text) ||
        sensitive.some(value => text.includes(value))) {
      throw new Error('新 Web 构建产物发现后端敏感配置标识');
    }
  }
  fixture = createGateway(dist, android);
  gateway = fixture.server;
  await new Promise((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(33081, '127.0.0.1', resolve);
  });
  if (android) {
    const { runAndroid } = await import('./run-android.mjs');
    await runAndroid({ run, env, fixture, deadline });
  } else {
    const testLog = openSync(path.join(run, 'browser-tests.log'), 'a');
    try {
      await processes.run(process.execPath, [path.join(web, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', ...process.argv.slice(2)], { cwd: web, env, log: testLog }, timeBudget(deadline, 300_000));
    } finally { closeSync(testLog); }
    console.log(readFileSync(path.join(run, 'browser-tests.log'), 'utf8'));
  }
  console.log('Go 全量/集成测试、Server/Web 构建、敏感配置扫描、浏览器回归通过。');
} catch (error) {
  failure = error;
  writeFileSync(path.join(run, 'run-failure.json'), JSON.stringify(errorDetails(error), null, 2));
  throw error;
} finally {
  const cleanupErrors = [];
  if (fixture) writeFileSync(path.join(run, 'gateway-result.json'), JSON.stringify(fixture.stats, null, 2));
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise(resolve => gateway.close(resolve));
  }
  try {
    if (pgStarted) await processes.run(path.join(pg, 'pg_ctl.exe'), ['-D', data, 'stop', '-m', 'fast', '-w', '-t', '15'], { cwd: web, env, log }, 20_000);
  } catch (error) { cleanupErrors.push(error); }
  try {
    await processes.close();
    rmSync(data, { recursive: true, force: true });
    rmSync(path.join(run, 'config.yaml'), { force: true });
  } catch (error) { cleanupErrors.push(error); }
  closeSync(log);
  if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, '隔离回归清理失败，未确认停止的资源保留，禁止手工盲删');
  console.log(`已停止并清理本次实例；构建、命令记录及截图保留在 ${run}`);
}
