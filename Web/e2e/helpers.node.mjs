import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { uiNode, Processes, timeBudget, errorDetails, rememberTree, closeProcessOutput, waitUntil } from './processes.mjs';
import { createGateway, blockedMessage } from './gateway.mjs';
import path from 'node:path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

test('整体期限会限制命令预算，期限已到不能再启动工作', () => {
  assert.equal(timeBudget(Date.now() + 5000, 100), 100);
  assert.ok(timeBudget(Date.now() + 100, 5000) <= 100);
  assert.throws(() => timeBudget(Date.now() - 1, 100), /整体期限已到/);
});

test('清理错误和原始错误可同时持久化，不覆盖首因', () => {
  const failure = new Error('启动失败', { cause: new Error('设备断开') });
  const details = errorDetails(new AggregateError([failure, new Error('清理失败')], '回归失败'));
  assert.equal(details.errors[0].cause.message, '设备断开');
  assert.equal(details.errors[1].message, '清理失败');
});

test('有界就绪探针只接受显式声明的退出码', async () => {
  const processes = new Processes();
  try {
    assert.equal(await processes.run(process.execPath, ['-e', 'process.exit(2)'], { acceptedExitCodes: [0, 1, 2] }, 1000), 2);
    await assert.rejects(processes.run(process.execPath, ['-e', 'process.exit(3)'], { acceptedExitCodes: [0, 1, 2] }, 1000), /退出码 3/);
  } finally { await processes.close(); }
});

test('原生控件按语义匹配并计算真实点击位置', () => {
  const node = uiNode('<node text="知道了" bounds="[20,30][80,90]" resource-id="android:id/button1" />', item => item.text === '知道了');
  assert.deepEqual([node.x, node.y], [50, 60]);
  assert.throws(() => uiNode('<node text="OK" bounds="[0,0][0,0]" />', () => true), /边界无效/);
  assert.throws(() => uiNode('<node text="Cancel" bounds="[0,0][10,10]" />', item => item.text === 'OK'), /没有找到/);
});

test('Android 网关返回完整403正文且不向后端转发执行', async () => {
  const { server, stats } = createGateway(path.resolve('e2e'), true);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = target => new Promise((resolve, reject) => {
    request({ hostname: '127.0.0.1', port, path: target }, response => {
      const chunks = [];
      response.on('data', data => chunks.push(data));
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    }).on('error', reject).end();
  });
  try {
    const denied = await call('/api/sign/execute');
    assert.equal(denied.status, 403);
    assert.equal(denied.data.message, blockedMessage);
    assert.equal(stats.blockedExecutions, 1);
    assert.equal(stats.forwardedExecutions, 0);
    assert.equal((await call('http://example.invalid/api/sign/locations')).status, 403);
    assert.deepEqual((await call('/api/sign/check')).data.data.items, []);
    assert.equal((await call('/api/admin/sign-locations/search')).status, 403);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('超时命令返回失败并移除进程跟踪', async () => {
  const processes = new Processes();
  await assert.rejects(processes.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, 300), /超时/);
  assert.equal(processes.children.size, 0);
  await processes.close();
});

test('超时停止根进程及其子进程，而不是只结束命令外壳', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'xbt-process-test-'));
  const record = path.join(directory, 'pids.json');
  const processes = new Processes();
  const script = `
    const {spawn}=require('node:child_process');
    const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true});
    writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
    setInterval(()=>{},1000);
  `;
  try {
    await assert.rejects(processes.run(process.execPath, ['-e', script, record], {}, 1500), /超时/);
    for (const pid of JSON.parse(readFileSync(record, 'utf8'))) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
  } finally {
    await processes.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('根退出与日志流close不能替代后代进程退出确认', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'xbt-process-exit-test-'));
  const record = path.join(directory, 'child.json');
  const processes = new Processes();
  // A Node launcher closes its own Windows job on exit; use a native launcher like the SDK.
  const script = `
    $start=New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName='${process.execPath.replaceAll("'", "''")}'
    $start.Arguments='-e "setInterval(()=>{},1000)"'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $child=[System.Diagnostics.Process]::Start($start)
    [System.IO.File]::WriteAllText('${record.replaceAll("'", "''")}',$child.Id.ToString())
    [Console]::In.ReadLine() | Out-Null
    exit 0
  `;
  const root = processes.start('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  root.once('close', () => { closed = true; });
  try {
    await waitUntil(() => existsSync(record), 5000, '创建受控子进程');
    await rememberTree(root);
    const childPid = JSON.parse(readFileSync(record, 'utf8'));
    root.stdin.end('exit\n');
    assert.equal(await root.completion, 0);
    assert.throws(() => process.kill(root.pid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(childPid, 0));
    t.diagnostic(`本机根进程 close=${closed}，此时后代仍存活；不能以流状态判断进程树`);
    assert.throws(() => closeProcessOutput(root), /尚未确认退出/);
    await processes.close();
    closeProcessOutput(root);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal(root.stdout.destroyed, true);
    const heldOutput = { ...root, stdout: new PassThrough(), stderr: new PassThrough() };
    assert.equal(heldOutput.stdout.destroyed, false);
    closeProcessOutput(heldOutput);
    assert.equal(heldOutput.stdout.destroyed, true);
    assert.equal(heldOutput.stderr.destroyed, true);
  } finally {
    await processes.close();
    closeProcessOutput(root);
    rmSync(directory, { recursive: true, force: true });
  }
});
