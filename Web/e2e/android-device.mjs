import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect as baseExpect, request } from '@playwright/test';
import { uiNode } from './processes.mjs';
import { blockedMessage } from './gateway.mjs';

const serial = process.env.XBT_E2E_ANDROID_SERIAL;
const secret = process.env.XBT_E2E_JWT_SECRET;
const results = process.env.XBT_E2E_RESULTS;
const expectedAvd = process.env.XBT_E2E_AVD_NAME;
if (process.env.XBT_E2E_ISOLATED !== '1' || !serial || !/^emulator-\d+$/.test(serial) || !secret || !results || !expectedAvd) {
  throw new Error('设备回归必须由隔离运行器启动');
}
const adbPath = process.env.XBT_ADB;
if (!adbPath) throw new Error('缺少运行器提供的 ADB 路径');
const packageName = 'com.github.enderwolf006.xbt';
const origin = 'http://10.0.2.2:33081';
const checks = [];
let browser;
let port;
let api;
const expect = baseExpect.configure({ timeout: 60_000 });
let page;
const network = [];

function nativeUI() {
  adb('shell', 'uiautomator', 'dump', '/data/local/tmp/xbt-test-ui.xml');
  return adb('shell', 'cat', '/data/local/tmp/xbt-test-ui.xml');
}

function tap(node) {
  adb('shell', 'input', 'tap', String(node.x), String(node.y));
}

async function confirmDelete(row, name, accept) {
  const opened = page.waitForEvent('dialog');
  const clicked = row.getByRole('button', { name: '删除', exact: true }).click().then(() => null, error => error);
  const dialog = await opened;
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toContain(name);
  const xml = nativeUI();
  expect(xml.includes(`确定要删除`)).toBe(true);
  expect(xml.includes(name)).toBe(true);
  const button = uiNode(xml, node => node['resource-id'] === `android:id/button${accept ? 1 : 2}` && node.package === packageName);
  tap(button);
  const error = await clicked;
  if (error) throw error;
  expect(nativeUI().includes('确定要删除')).toBe(false);
}

function adb(...args) {
  const result = spawnSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`隔离 ADB 命令失败：${args.slice(0, 2).join(' ')}，退出码 ${result.status}`);
  return result.stdout.trim();
}

function appPid() {
  const result = spawnSync(adbPath, ['-s', serial, 'shell', 'pidof', packageName], { encoding: 'utf8', timeout: 30_000 });
  if (!result.error && result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return '';
  if (result.error || result.status !== 0) throw new Error('无法读取隔离应用启动状态');
  return result.stdout.trim();
}

function account(admin) {
  const user = { uid: admin ? 99001 : 99002, mobile: admin ? 'e2e-admin' : 'e2e-user', name: admin ? '隔离管理员' : '隔离用户', permission: admin ? 2 : 1, avatar: '' };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
  return { user, token };
}

async function authenticate(page, admin) {
  await page.evaluate(value => {
    localStorage.setItem('accounts', JSON.stringify([value]));
    localStorage.setItem('activeUid', String(value.user.uid));
  }, account(admin));
  await page.reload();
}

try {
  const avdName = adb('shell', 'getprop', 'ro.boot.qemu.avd_name');
  if (avdName !== expectedAvd) throw new Error('拒绝连接非本次创建的临时 AVD');
  if (adb('shell', 'pm', 'path', packageName).split('\n').some(line => !line.startsWith('package:'))) {
    throw new Error('临时模拟器没有安装待测 APK');
  }
  const abi = adb('shell', 'getprop', 'ro.product.cpu.abilist');
  adb('shell', 'am', 'force-stop', packageName);
  adb('shell', 'am', 'start', '-n', `${packageName}/.MainActivity`);
  await expect.poll(appPid, { timeout: 60_000 }).toMatch(/^\d+$/);
  const pid = appPid();
  await expect.poll(() => adb('shell', 'cat', '/proc/net/unix').includes(`webview_devtools_remote_${pid}`), { timeout: 60_000 }).toBe(true);
  port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  if (!/^\d+$/.test(port)) throw new Error('ADB 未返回专用转发端口');
  const endpoint = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(10_000) })).json();
  const targets = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  if (!targets.some(target => target.type === 'page' && target.url.startsWith(origin))) {
    throw new Error('DevTools HTTP 没有本应用的隔离页面');
  }
  mkdirSync(results, { recursive: true });
  writeFileSync(path.join(results, 'devtools-safe.json'), JSON.stringify({
    browser: version.Browser, pageFound: true, serial, pid,
  }, null, 2));
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 30_000 });
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(60_000);
  page.on('requestfinished', req => {
    if (req.url().startsWith(origin)) network.push({ event: 'finished', path: new URL(req.url()).pathname, method: req.method() });
  });
  page.on('requestfailed', req => {
    if (req.url().startsWith(origin)) network.push({ event: 'failed', path: new URL(req.url()).pathname, method: req.method() });
  });
  page.on('dialog', () => { /* Native Android buttons own dialog confirmation. */ });
  await expect(page).toHaveURL(new RegExp('^http://10\\.0\\.2\\.2:33081/'));
  const activity = JSON.parse(process.env.XBT_E2E_ACTIVITY);
  const course = JSON.parse(process.env.XBT_E2E_COURSE);
  const bridge = await page.evaluate(() => typeof window.XBTCameraBridge);
  expect(bridge).toBe('object');
  mkdirSync(results, { recursive: true });
  checks.push('原生 Activity 和真实 WebView 启动、真实 Android 桥存在');
  await expect.poll(async () => page.evaluate(() => JSON.parse(window.XBTCameraBridge.getCameraState()).error), { timeout: 60_000 }).toContain('相机不可用');
  adb('shell', 'uiautomator', 'dump', '/data/local/tmp/xbt-camera-fix-ui.xml');
  const ui = adb('shell', 'cat', '/data/local/tmp/xbt-camera-fix-ui.xml');
  expect(ui.includes('相机不可用')).toBe(true);
  expect(ui.includes('其他功能仍可使用')).toBe(true);
  const nativeScreenshot = spawnSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 15_000 });
  if (nativeScreenshot.error || nativeScreenshot.status !== 0) throw new Error('相机错误提示截图失败');
  writeFileSync(path.join(results, 'camera-error-native.png'), nativeScreenshot.stdout);
  writeFileSync(path.join(results, 'camera-error-ui.xml'), ui);
  tap(uiNode(ui, node => node.text === '知道了' && node.package === packageName));
  expect(nativeUI().includes('相机不可用')).toBe(false);
  checks.push('受控无相机初始化失败不崩溃，中文错误在原生界面可见且可关闭');
  api = await request.newContext({ baseURL: 'http://127.0.0.1:33081', extraHTTPHeaders: { Authorization: `Bearer ${account(true).token}` } });

  await authenticate(page, true);
  await page.goto(`${origin}/#/admin/sign-locations`);
  await page.getByTitle('手动新增').click();
  await page.getByLabel('名称', { exact: true }).fill('E2E Android 新地点');
  await page.getByLabel('地址', { exact: true }).fill('合成设备测试地址');
  await page.getByLabel('纬度', { exact: true }).fill('1.1234567');
  await page.getByLabel('经度', { exact: true }).fill('2.1234567');
  await page.getByRole('button', { name: '保存地点' }).click();
  let row = page.locator('article').filter({ hasText: 'E2E Android 新地点' });
  await expect(row).toContainText('待确认');
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('E2E Android 已编辑');
  await page.getByRole('button', { name: '保存地点' }).click();
  row = page.locator('article').filter({ hasText: 'E2E Android 已编辑' });
  await row.getByRole('button', { name: '明确启用' }).click();
  await page.getByRole('button', { name: '已启用', exact: true }).click();
  await expect(row).toContainText('已启用');
  const response = await api.get('/api/admin/sign-locations');
  expect(response.ok()).toBe(true);
  const location = (await response.json()).data.find(item => item.name === 'E2E Android 已编辑');
  expect(location.latitude).toBe(1.123457);
  checks.push('设备管理员新增、编辑、筛选、启用及真实 PostgreSQL 六位坐标');

  await authenticate(page, false);
  await page.goto(`${origin}/`);
  await page.evaluate(state => history.replaceState({ usr: state, key: 'device-test', idx: 0 }, '', '/#/sign/99001'), { activity, course, selectedUids: [], classmates: [] });
  await page.reload();
  await page.getByText('点击选择地点', { exact: true }).first().click();
  await page.getByText(location.name, { exact: true }).click();
  await page.screenshot({ path: path.join(results, 'android-location-selection.png') });
  const [sent, denied] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith('/api/sign/execute')),
    page.waitForResponse(r => r.url().endsWith('/api/sign/execute')),
    page.getByRole('button', { name: /立即签到/ }).click(),
  ]);
  const body = sent.postDataJSON();
  expect(body.location_id).toBe(location.id);
  expect(body.special_params).toEqual({});
  expect(denied.status()).toBe(403);
  expect(await denied.finished()).toBeNull();
  expect((await denied.json()).message).toBe(blockedMessage);
  await expect(page.getByText(blockedMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('失败', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(results, 'android-denied-visible.png') });
  checks.push('设备用户选择与顶层 location_id；请求由隔离网关阻断，未转发签到');

  expect((await api.post(`/api/admin/sign-locations/${location.id}/disable`)).ok()).toBe(true);
  await page.reload();
  await expect(page.getByText('暂无可用签到地点')).toBeVisible();
  checks.push('真实停用后设备端不再提供地点');

  await authenticate(page, true);
  await page.goto(`${origin}/#/admin/sign-locations`);
  await page.getByRole('button', { name: '已停用', exact: true }).click();
  row = page.locator('article').filter({ hasText: location.name });
  await expect(row).toContainText('已停用');
  await confirmDelete(row, location.name, false);
  await expect(row).toBeVisible();
  expect((await (await api.get('/api/admin/sign-locations')).json()).data.some(item => item.id === location.id)).toBe(true);
  await confirmDelete(row, location.name, true);
  await expect(page.locator('article')).toHaveCount(0);
  checks.push('设备原生确认框取消/确认，框实际消失及删除后列表刷新');

  mkdirSync(results, { recursive: true });
  await page.screenshot({ path: path.join(results, 'android-webview.png') });
  const screenshot = spawnSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30_000 });
  if (screenshot.status !== 0 || screenshot.error) throw new Error('设备截图失败');
  writeFileSync(path.join(results, 'android-screen.png'), screenshot.stdout);
  expect(appPid()).toBe(pid);
  const closed = page.waitForEvent('close', { timeout: 15_000 });
  adb('shell', 'am', 'start', '-f', '0x10008000', '-n', `${packageName}/.MainActivity`);
  await closed;
  expect(page.isClosed()).toBe(true);
  checks.push('NEW_TASK|CLEAR_TASK结束旧Activity后原WebView销毁；并非配置变化recreate');
  const report = { time: new Date().toISOString(), avd: avdName, abi, apiLevel: adb('shell', 'getprop', 'ro.build.version.sdk'), packageName, checks, externalSignForwarded: false, sameProcessSurvived: true };
  writeFileSync(path.join(results, 'android-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  mkdirSync(results, { recursive: true });
  const diagnostics = [];
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: path.join(results, 'android-failed-page.png'), timeout: 10_000 }); }
    catch (diagnosticError) { diagnostics.push(`页面截图失败：${diagnosticError.message}`); }
    try { writeFileSync(path.join(results, 'android-failed-ui.xml'), nativeUI()); }
    catch (diagnosticError) { diagnostics.push(`原生界面采集失败：${diagnosticError.message}`); }
  }
  writeFileSync(path.join(results, 'android-failure.json'), JSON.stringify({ checks, error: error.message, network, diagnostics }, null, 2));
  throw error;
} finally {
  if (api) await api.dispose();
  try { if (browser) await browser.close(); }
  finally { if (port && /^\d+$/.test(port)) adb('forward', '--remove', `tcp:${port}`); }
}
