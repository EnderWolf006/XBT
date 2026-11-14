import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function timeBudget(deadline, requested) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('隔离回归整体期限已到，进入清理');
  return Math.min(requested, remaining);
}

export function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error ? { code: error.code, signal: error.signal, killed: error.killed } : {}),
    ...(error instanceof Error && error.cause !== undefined ? { cause: errorDetails(error.cause) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(errorDetails) } : {}),
  };
}

export async function rememberTree(child, timeout = 30_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') throw new Error('当前隔离运行器仅支持 Windows');
  const script = `
    $ErrorActionPreference='Stop'
    $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)
    $root=$all | Where-Object { $_.ProcessId -eq ${child.pid} }
    if (-not $root) { Write-Output '[]'; exit 0 }
    if ($root.ParentProcessId -ne ${process.pid}) { throw '进程归属改变，拒绝停止' }
    $ids=@(${child.pid})
    for ($i=0; $i -lt $ids.Count; $i++) {
      $ids+=@($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $_.ProcessId })
    }
    $records=@(foreach ($id in $ids) {
      $p=$all | Where-Object { $_.ProcessId -eq $id }
      [pscustomobject]@{pid=$p.ProcessId;parent=$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o')}
    })
    ConvertTo-Json -InputObject $records -Compress`;
  const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout });
  const known = new Map((child.ownedTree || []).map(item => [`${item.pid}:${item.created}`, item]));
  for (const item of JSON.parse(result.stdout)) known.set(`${item.pid}:${item.created}`, item);
  child.ownedTree = [...known.values()];
}

export async function stopTree(child) {
  if (!child?.pid) return;
  await rememberTree(child);
  if (!child.ownedTree?.length) return;
  const records = JSON.stringify([...child.ownedTree].reverse());
  const script = `
    $ErrorActionPreference='Stop'
    $records=ConvertFrom-Json '${records}'
    foreach ($record in $records) {
      $id=$record.pid
      $current=Get-CimInstance Win32_Process -Filter "ProcessId = $id"
      if ($current -and $current.ParentProcessId -eq $record.parent -and $current.CreationDate.ToUniversalTime().ToString('o') -eq $record.created) {
        try { Stop-Process -Id $id -Force -PassThru -ErrorAction Stop | Wait-Process -Timeout 5 }
        catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw } }
      }
    }`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000 });
  child.ownedTree = [];
}

export function closeProcessOutput(child) {
  if (!child) return;
  if ((child.pid && child.exitCode === null && child.signalCode === null) || child.ownedTree?.length) {
    throw new Error('自建进程树尚未确认退出，不能关闭日志流');
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export class Processes {
  children = new Set();

  start(command, args, options = {}) {
    const child = spawn(command, args, { ...options, windowsHide: true });
    this.children.add(child);
    child.completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    // Keep the rejection observed until the caller awaits startup/completion.
    child.completion.catch(error => { child.startError = error; });
    return child;
  }

  async run(command, args, options = {}, timeout = 180_000, input) {
    const { log, acceptedExitCodes = [0], ...spawnOptions } = options;
    const child = this.start(command, args, { ...spawnOptions, stdio: ['pipe', log ?? 'ignore', log ?? 'ignore'] });
    if (input) child.stdin.end(input);
    else child.stdin.end();
    let timer;
    let failure;
    try {
      const code = await Promise.race([
        child.completion,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`命令超时：${command}`)), timeout); }),
      ]);
      if (!acceptedExitCodes.includes(code)) throw new Error(`命令失败：${command}，退出码 ${code}`);
      return code;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      clearTimeout(timer);
      try { await stopTree(child); }
      catch (error) { throw new AggregateError(failure ? [failure, error] : [error], '命令清理失败，保留原始失败原因'); }
      this.children.delete(child);
    }
  }

  async close() {
    const failures = [];
    for (const child of [...this.children].reverse()) {
      try { await stopTree(child); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, '未能安全停止全部自建进程，保留数据目录');
    this.children.clear();
  }
}

export async function waitUntil(check, timeout, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${description}超时`);
}

export function uiNode(xml, predicate) {
  const decode = value => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const tag of xml.matchAll(/<node\b[^>]*>/g)) {
    const attributes = Object.fromEntries([...tag[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], decode(match[2])]));
    if (!predicate(attributes)) continue;
    const bounds = attributes.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!bounds || +bounds[3] <= +bounds[1] || +bounds[4] <= +bounds[2]) throw new Error('原生控件边界无效');
    return { ...attributes, x: Math.floor((+bounds[1] + +bounds[3]) / 2), y: Math.floor((+bounds[2] + +bounds[4]) / 2) };
  }
  throw new Error('没有找到预期的原生控件');
}
