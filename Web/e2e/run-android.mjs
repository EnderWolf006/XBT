import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, openSync, closeSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Processes, waitUntil, timeBudget, errorDetails, rememberTree, closeProcessOutput } from './processes.mjs';
import { createInterface } from 'node:readline';

const exec = promisify(execFile);
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runAndroid({ run, env, fixture, deadline }) {
  if (process.platform !== 'win32') throw new Error('设备运行器当前仅支持 Windows');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !path.isAbsolute(sdk)) throw new Error('请设置已有 SDK 的 ANDROID_HOME，运行器不会下载 SDK');
  const image = process.env.XBT_ANDROID_SYSTEM_IMAGE || 'system-images\\android-36.1\\google_apis_playstore\\x86_64';
  if (path.isAbsolute(image) || image.split(/[\\/]/).includes('..')) throw new Error('系统镜像必须是 SDK 下的相对路径');
  const adbPath = path.join(sdk, 'platform-tools', 'adb.exe');
  const emulatorPath = path.join(sdk, 'emulator', 'emulator.exe');
  for (const file of [adbPath, emulatorPath, path.join(sdk, image, 'system.img')]) {
    if (!existsSync(file)) throw new Error(`缺少已有工具或镜像：${file}；不会自动安装`);
  }
  for (const port of [5556, 5557]) {
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  }
  const serial = 'emulator-5556';
  const name = `XBT_${path.basename(run).replaceAll('-', '_')}`;
  const avdRoot = path.join(run, 'avd');
  const emulatorHome = path.join(run, 'android-home');
  const avd = path.join(avdRoot, `${name}.avd`);
  const sdkEnv = { ...env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdRoot };
  const processes = new Processes();
  const log = openSync(path.join(run, 'android-system.log'), 'a');
  let bootVerified = false;
  let emulator;
  let failure;
  const state = { phase: 'gradle', updatedAt: '', emulatorExit: null, failure: null, cleanupErrors: [] };
  const saveState = () => {
    state.updatedAt = new Date().toISOString();
    writeFileSync(path.join(run, 'android-run-state.json'), JSON.stringify(state, null, 2));
  };
  const phase = value => { state.phase = value; saveState(); };
  const adb = async (args, timeout = 20_000, allowedFailure = false) => {
    try {
      return await exec(adbPath, ['-s', serial, ...args], { timeout: state.phase === 'cleanup' ? timeout : timeBudget(deadline, timeout), maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
    } catch (error) {
      const expectedTransport = /device .*?(?:not found|offline|unauthorized)|no devices\/emulators found/.test(error.stderr || '');
      const absentPackage = args[0] === 'shell' && args[1] === 'pm' && args[2] === 'path' && error.code === 1 && !error.stderr?.trim();
      if (allowedFailure && !error.killed && (expectedTransport || absentPackage)) return { stdout: '', stderr: error.stderr || '' };
      throw new Error(`自建设备命令失败：${args.slice(0, 2).join(' ')}`, { cause: error });
    }
  };
  try {
    saveState();
    await processes.run(process.env.ComSpec, ['/d', '/s', '/c', '.\\gradlew.bat --offline --no-daemon --max-workers=2 -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:testDebugUnitTest --rerun :app:lintDebug'],
      { cwd: path.join(web, '..', 'Android'), env: sdkEnv, log }, timeBudget(deadline, 600_000));
    const apk = path.join(web, '..', 'Android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    mkdirSync(avd, { recursive: true });
    mkdirSync(emulatorHome, { recursive: true });
    writeFileSync(path.join(avdRoot, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${avd}\ntarget=android-36.1\n`);
    writeFileSync(path.join(avd, 'config.ini'), [
      `AvdId=${name}`, 'avd.ini.encoding=UTF-8', 'PlayStore.enabled=true', 'abi.type=x86_64',
      'hw.cpu.arch=x86_64', 'hw.cpu.ncore=4', 'hw.ramSize=3072', 'hw.lcd.width=720',
      'hw.lcd.height=1280', 'hw.lcd.density=320', 'disk.dataPartition.size=6G',
      'hw.keyboard=yes', 'hw.sdCard=no', 'hw.audioInput=no', 'hw.camera.back=none',
      'hw.camera.front=none', 'hw.gpu.enabled=yes', 'hw.gpu.mode=host',
      `image.sysdir.1=${image}\\`, 'tag.id=google_apis_playstore', 'target=android-36.1',
    ].join('\n'));
    phase('boot');
    emulator = processes.start(emulatorPath, [
      '-avd', name, '-read-only', '-no-snapshot-load', '-no-snapshot-save', '-no-window',
      '-no-audio', '-no-boot-anim', '-camera-back', 'none', '-camera-front', 'none',
      '-memory', '3072', '-cores', '4', '-gpu', 'host', '-feature', '-Vulkan', '-port', '5556',
    ], { env: { ...sdkEnv, ANDROID_USER_HOME: emulatorHome, ANDROID_EMULATOR_HOME: emulatorHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [emulator.stdout, emulator.stderr]) {
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
        writeFileSync(log, line.replace(/(androidboot\.qemu\.adb\.pubkey=).*/, '$1[redacted]') + '\n');
      });
    }
    state.emulatorPid = emulator.pid;
    emulator.once('exit', (code, signal) => {
      state.emulatorExit = { code, signal, phase: state.phase };
      saveState();
    });
    await rememberTree(emulator, timeBudget(deadline, 30_000));
    await waitUntil(async () => {
      if (emulator.startError || emulator.exitCode !== null) throw new Error('自建模拟器提前退出，见 android-system.log');
      if ((await adb(['get-state'], 5000, true)).stdout.trim() !== 'device') return false;
      const actual = (await adb(['shell', 'getprop', 'ro.boot.qemu.avd_name'], 20_000, true)).stdout.trim();
      if (!actual) return false;
      if (actual !== name) throw new Error('拒绝操作非本次创建的模拟器');
      bootVerified = true;
      return (await adb(['shell', 'getprop', 'sys.boot_completed'], 20_000, true)).stdout.trim() === '1';
    }, timeBudget(deadline, 12 * 60_000), '单轮模拟器冷启动');
    phase('disable-gms');
    await adb(['shell', 'pm', 'disable-user', '--user', '0', 'com.google.android.gms']);
    phase('install');
    const prior = await adb(['shell', 'pm', 'path', 'com.github.enderwolf006.xbt'], 10_000, true);
    if (prior.stdout.trim()) throw new Error('临时设备已有同包应用，拒绝覆盖');
    const install = await adb(['install', '--no-streaming', apk], 60_000);
    if (!install.stdout.includes('Success')) throw new Error('APK 未成功安装');
    await adb(['shell', 'pm', 'grant', 'com.github.enderwolf006.xbt', 'android.permission.CAMERA']);
    // Only this disposable guest uses the restrictive HTTP gateway as a proxy.
    await adb(['shell', 'settings', 'put', 'global', 'http_proxy', '10.0.2.2:33081']);
    phase('verify-camera');
    const camera = (await adb(['shell', 'dumpsys', 'media.camera'])).stdout;
    if (!/Number of camera devices:\s*0\b/.test(camera)) throw new Error('未建立无相机故障注入环境');
    writeFileSync(path.join(run, 'android-environment.json'), JSON.stringify({
      name, serial, cameraCount: 0, bootCompleted: true, installed: true,
      apkSha256: createHash('sha256').update(readFileSync(apk)).digest('hex').toUpperCase(),
      abi: (await adb(['shell', 'getprop', 'ro.product.cpu.abilist'])).stdout.trim(),
    }, null, 2));
    const testLog = openSync(path.join(run, 'android-tests.log'), 'a');
    phase('device-assertions');
    try {
      await processes.run(process.execPath, [path.join(web, 'e2e', 'android-device.mjs')], {
        cwd: web, log: testLog,
        env: {
          ...sdkEnv, XBT_ADB: adbPath, XBT_E2E_ANDROID_SERIAL: serial, XBT_E2E_AVD_NAME: name,
          XBT_E2E_ACTIVITY: JSON.stringify(fixture.activity), XBT_E2E_COURSE: JSON.stringify(fixture.course),
        },
      }, timeBudget(deadline, 300_000));
    } finally { closeSync(testLog); }
    if (fixture.stats.blockedExecutions === 0 || fixture.stats.forwardedExecutions !== 0) throw new Error('设备执行请求边界断言失败');
    writeFileSync(path.join(run, 'gateway-result.json'), JSON.stringify(fixture.stats, null, 2));
    console.log(readFileSync(path.join(run, 'android-tests.log'), 'utf8'));
    phase('passed');
  } catch (error) {
    failure = error;
    state.failure = { phase: state.phase, ...errorDetails(error) };
    saveState();
    throw error;
  } finally {
    phase('cleanup');
    const cleanupErrors = [];
    try {
      await rememberTree(emulator);
      state.ownedPids = (emulator?.ownedTree || []).map(item => item.pid);
      saveState();
      if (bootVerified && (await adb(['get-state'], 5000, true)).stdout.trim() === 'device') {
        if ((await adb(['shell', 'getprop', 'ro.boot.qemu.avd_name'])).stdout.trim() !== name) {
          throw new Error('清理前设备归属改变，只停止本次已跟踪的宿主进程');
        }
        const mappings = (await adb(['forward', '--list'])).stdout.trim().split('\n');
        for (const line of mappings) {
          const [device, local, remote] = line.trim().split(/\s+/);
          if (device === serial && remote?.startsWith('localabstract:webview_devtools_remote_')) {
            await adb(['forward', '--remove', local]);
          }
        }
        await adb(['emu', 'kill'], 10_000);
        await waitUntil(() => emulator.exitCode !== null, 10_000, '自建模拟器正常退出');
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      await processes.close();
      closeProcessOutput(emulator);
      state.processesStopped = true;
      rmSync(avdRoot, { recursive: true, force: true });
      rmSync(emulatorHome, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    closeSync(log);
    state.cleanupErrors = cleanupErrors.map(errorDetails);
    saveState();
    if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, '设备清理失败，已保留原始失败原因');
  }
}
