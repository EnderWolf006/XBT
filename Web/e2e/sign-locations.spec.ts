import { createHmac } from 'node:crypto';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import type { SignLocation, SignLocationCandidate, SaveCandidateResult } from '../src/types';
import { nearestEnabledLocation, rankEnabledLocations, distanceMeters, EARTH_RADIUS_METERS } from '../src/utils/locationMatching';

const secret = (() => {
  const value = process.env.XBT_E2E_JWT_SECRET;
  if (!value) throw new Error('缺少隔离测试密钥');
  return value;
})();

declare global {
  interface Window {
    cameraTest: { active: boolean[]; lenses: string[]; revoked: string[] };
    pauseTestAnimationFrames: () => void;
    captureTest: { calls: PositionOptions[] };
    interactiveMapTest: { centers: number[][]; zooms: number[] };
  }
}

function account(admin: boolean) {
  const user = { uid: admin ? 99001 : 99002, mobile: admin ? 'e2e-admin' : 'e2e-user', name: admin ? '隔离管理员' : '隔离用户', permission: admin ? 2 : 1, avatar: '' };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
  return { user, token };
}

const adminHeaders = { Authorization: `Bearer ${account(true).token}` };
const activity = {
  active_id: 99001, activity_name: '隔离位置签到', sign_type: 4, course_id: 99001,
  class_id: 99001, if_photo: false, if_refresh_ewm: false, start_time: Date.now(),
  end_time: Date.now() + 3_600_000, course_name: '隔离课程',
};
const course = { course_id: 99001, class_id: 99001, course_name: '隔离课程', course_teacher: '测试', activities: [activity] };

async function authenticate(page: Page, admin = false) {
  if (process.env.XBT_E2E_HEADED === '1') {
    await page.bringToFront();
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const banner = document.createElement('aside');
        banner.textContent = '隔离验证：合成账号 / 高德候选模拟；地点保存使用独立真实 PostgreSQL';
        banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#172554;color:white;text-align:center;font-size:12px;z-index:100;pointer-events:none;padding:5px';
        document.body.appendChild(banner);
      });
    });
  }
  await page.addInitScript(value => {
    localStorage.setItem('accounts', JSON.stringify([value]));
    localStorage.setItem('activeUid', String(value.user.uid));
  }, account(admin));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === 'http://127.0.0.1:33081' ? route.continue() : route.abort('blockedbyclient');
  });
  await page.route('**/api/sign/activities', route => route.fulfill({ json: { code: 0, data: [course] } }));
}

async function openSign(page: Page, signType = 4, route = 'sign/99001', ifRefreshEWM = false) {
  await page.addInitScript(state => {
    history.replaceState({ usr: state, key: 'isolated', idx: 0 }, '');
  }, { activity: { ...activity, sign_type: signType, if_refresh_ewm: ifRefreshEWM }, course, selectedUids: [], classmates: [] });
  await page.goto(`/#/${route}`);
}

async function createLocation(request: APIRequestContext, name: string) {
  const response = await request.post('/api/admin/sign-locations', {
    headers: adminHeaders, data: { name, address: '合成测试地址', latitude: 1.1234567, longitude: 2.1234567 },
  });
  expect(response.ok()).toBeTruthy();
  const result: { data: SignLocation } = await response.json();
  return result.data;
}

for (const scenario of [
  { name: 'HTTP 拒绝原因', status: 403, json: { code: 403, message: '合成权限拒绝' }, expected: '合成权限拒绝' },
  { name: '成功结果', status: 200, json: { code: 0, data: { success: true, message: '合成签到完成' } }, expected: '合成签到完成' },
]) {
test(`进度反馈在动画帧暂停时仍立即显示${scenario.name}`, async ({ page }) => {
  await page.addInitScript(() => {
    let paused = false;
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => original(time => { if (!paused) callback(time); });
    window.pauseTestAnimationFrames = () => { paused = true; };
  });
  await authenticate(page);
  await page.route('**/api/sign/check', route => route.fulfill({ json: { code: 0, data: { items: [] } } }));
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  await page.route('**/api/sign/execute', async route => {
    await responseGate;
    await route.fulfill({ status: scenario.status, json: scenario.json });
  });
  try {
    await openSign(page, 0);
    await page.getByRole('button', { name: /立即签到/ }).click();
    await expect(page.getByText('正在尝试签到', { exact: true })).toBeVisible();
    await page.evaluate(() => window.pauseTestAnimationFrames());
    releaseResponse();
    await expect(page.getByText(scenario.expected, { exact: true })).toBeVisible();
  } finally {
    releaseResponse();
    await page.reload();
  }
});
}

test.afterEach(async ({ request }) => {
  const response = await request.get('/api/admin/sign-locations', { headers: adminHeaders });
  expect(response.ok()).toBeTruthy();
  const result: { data: SignLocation[] } = await response.json();
  for (const row of result.data.filter(item => item.name.startsWith('E2E '))) {
    expect((await request.delete(`/api/admin/sign-locations/${row.id}`, { headers: adminHeaders })).ok()).toBeTruthy();
  }
});

test('登录首屏不下载扫码或管理页面脚本', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', request => {
    if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
  });
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: /登录/ })).toBeVisible();
  expect(scripts.some(name => name.includes('/assets/index-'))).toBeTruthy();
  expect(scripts.some(name => /\/assets\/(?:FullScanner|FullPhoto|SignDetail|SignLocations)-/.test(name))).toBeFalsy();
});

test('管理员真实 CRUD、筛选、启停、软删除及无高德 Key 错误', async ({ page, request }) => {
  await authenticate(page, true);
  await page.goto('/#/admin/sign-locations');
  await page.getByTitle('手动新增').click();
  await page.getByLabel('名称', { exact: true }).fill('E2E 新地点');
  await page.getByLabel('地址', { exact: true }).fill('合成测试地址');
  await page.getByLabel('纬度', { exact: true }).fill('1.1234567');
  await page.getByLabel('经度', { exact: true }).fill('2.1234567');
  await page.getByRole('button', { name: '保存地点' }).click();
  const row = page.locator('article').filter({ hasText: 'E2E 新地点' });
  await expect(row).toContainText('待确认');
  const listed: { data: SignLocation[] } = await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json();
  expect(listed.data.find(item => item.name === 'E2E 新地点')?.latitude).toBe(1.123457);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('E2E 已编辑地点');
  await page.getByLabel('地址', { exact: true }).fill('合成修改地址');
  await page.getByRole('button', { name: '保存地点' }).click();
  const edited = page.locator('article').filter({ hasText: 'E2E 已编辑地点' });
  await expect(edited).toContainText('合成修改地址');
  await page.getByRole('button', { name: '已启用', exact: true }).click();
  await expect(page.locator('article')).toHaveCount(0);
  await page.getByRole('button', { name: '待确认', exact: true }).click();
  await edited.getByRole('button', { name: '明确启用' }).click();
  await expect(page.locator('article')).toHaveCount(0);
  await page.getByRole('button', { name: '已启用', exact: true }).click();
  await expect(edited).toContainText('已启用');
  await edited.getByRole('button', { name: '停用', exact: true }).click();
  await page.getByRole('button', { name: '已停用', exact: true }).click();
  await expect(edited).toContainText('已停用');
  page.once('dialog', dialog => dialog.dismiss());
  await edited.getByRole('button', { name: '删除', exact: true }).click();
  await expect(edited).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await edited.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('article')).toHaveCount(0);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('region', { name: '本次搜索结果' }).getByRole('alert')).toHaveText('search sign location candidates failed');
  await expect(page.getByTestId('actual-query')).toHaveText('实际检索词：教学楼');
});

test('普通用户不能进入管理路由或调用管理 API', async ({ page, request }) => {
  await authenticate(page);
  await page.goto('/#/admin/sign-locations');
  await expect(page).toHaveURL(/\/#\/$/);
  expect((await request.post('/api/admin/sign-locations/candidates', { headers: { Authorization: `Bearer ${account(false).token}` }, data: {} })).status()).toBe(403);
  expect((await request.post('/api/admin/sign-locations/1/restore', { headers: { Authorization: `Bearer ${account(false).token}` }, data: { confirmed: true } })).status()).toBe(403);
  expect((await request.get('/api/admin/sign-locations', { headers: { Authorization: `Bearer ${account(false).token}` } })).status()).toBe(403);
});

const candidate = (name: string, id: string): SignLocationCandidate => ({
  name, address: '合成大学北校区（非真实地址）', latitude: 31.1234567, longitude: 113.1234567, amap_poi_id: id, source: 'amap',
});
async function candidateCheckpoint(page: Page, name: string) {
  if (process.env.XBT_E2E_HEADED === '1') await page.waitForTimeout(2200);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test('坐标采集拒绝行内重试、精度警告、名称必填与真实预览零写', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.captureTest = { calls: [] };
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (success: PositionCallback, failure: PositionErrorCallback, options: PositionOptions) => {
        window.captureTest.calls.push(options);
        if (window.captureTest.calls.length <= 2) {
          failure({ code: 1, message: 'synthetic denial', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
          return;
        }
        success({ coords: { latitude: 39.915, longitude: 116.404, accuracy: 51, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
          timestamp: Date.parse('2026-09-25T06:00:00Z'), toJSON: () => ({}) });
      },
    } });
  });
  await authenticate(page, true);
  const writes: string[] = [], signs: string[] = [];
  page.on('request', r => {
    if (r.url().endsWith('/api/admin/sign-locations') && r.method() === 'POST') writes.push(r.url());
    if (r.url().includes('/sign/execute')) signs.push(r.url());
  });
  const before = (await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data.length;
  await page.goto('/#/admin/sign-locations');
  await page.getByTitle('手动新增').click();
  const modal = page.getByRole('dialog', { name: '手动新增地点' });
  for (let i = 0; i < 2; i++) {
    await modal.getByRole('button', { name: '浏览器现场定位' }).click();
    await expect(modal.getByRole('alert')).toHaveCount(1);
    await expect(modal.getByRole('alert')).toContainText('定位权限被拒绝');
  }
  await candidateCheckpoint(page, 'capture-permission-inline-not-toast');
  await modal.getByRole('button', { name: '浏览器现场定位' }).click();
  await expect(modal.getByTestId('gps-preview')).toContainText('116.410244');
  await expect(modal.getByTestId('gps-preview')).toContainText('39.916404');
  await expect(modal.getByRole('alert')).toContainText('精度差于50米');
  expect(await page.evaluate(() => window.captureTest.calls.every(o => o.enableHighAccuracy && o.timeout === 10000 && o.maximumAge === 0))).toBeTruthy();
  expect((await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data.length).toBe(before);
  await expect(modal.getByLabel('纬度', { exact: true })).toHaveValue('0');
  await modal.getByRole('button', { name: '使用定位点' }).click();
  await expect(modal.getByLabel('纬度', { exact: true })).toHaveValue('39.916404');
  await modal.getByRole('button', { name: '保存地点' }).click();
  await expect(modal.getByRole('alert').filter({ hasText: '名称' })).toBeVisible();
  expect(writes).toHaveLength(0);
  await candidateCheckpoint(page, 'capture-accuracy-name-required-no-write');
  await modal.getByLabel('名称', { exact: true }).fill('E2E 现场采集公开样例');
  await modal.getByLabel('地址', { exact: true }).fill('公开转换样例，非实际设备或楼栋');
  await modal.getByRole('button', { name: '保存地点' }).click();
  const row = page.locator('article').filter({ hasText: 'E2E 现场采集公开样例' });
  await expect(row).toContainText('待确认');
  await expect(row).toContainText('现场定位');
  expect(writes).toHaveLength(1);
  expect(signs).toHaveLength(0);
});

test('个人入口无校区仍可地图搜索取点，保存编辑删除仅影响本人', async ({ page, request }) => {
  await authenticate(page, true);
  await mockInteractiveMap(page);
  await page.route('**/api/sign/locations/settings', route => route.fulfill({ json: { code: 0, data: { personal_only: true } } }));
  await page.route('**/api/sign/locations/search-map', route => route.fulfill({ json: { code: 0, data: [
    { name: '合成个人图书馆', address: '合成个人地址', latitude: 31.123456, longitude: 121.123456, amap_poi_id: 'personal-map' },
  ] } }));
  let previews = 0, globalWrites = 0, signs = 0;
  page.on('request', request => {
    if (request.url().includes('/map-preview')) previews++;
    if (request.url().includes('/admin/sign-locations') && request.method() !== 'GET') globalWrites++;
    if (request.url().includes('/sign/execute')) signs++;
  });
  const name = 'E2E 个人地图无校区';
  let savedID: number | undefined;
  try {
    await page.goto('/#/admin/sign-locations');
    await expect(page.getByRole('heading', { name: '我的常用地点' })).toBeVisible();
    await page.getByRole('button', { name: '添加位置' }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('纬度', { exact: true })).toHaveValue('');
    await expect(modal.getByLabel('经度', { exact: true })).toHaveValue('');
    await modal.getByLabel('名称', { exact: true }).fill(name);
    await modal.getByLabel('地址', { exact: true }).fill('E2E 个人地址');
    await modal.getByRole('button', { name: '保存个人地点' }).click();
    await expect(modal.getByRole('alert')).toContainText('完整的 GCJ-02 坐标');
    await modal.getByRole('button', { name: '打开地图取点' }).click();
    await expect(modal.getByTestId('map-center')).toContainText('经度 104');
    await expect(modal.getByRole('button', { name: '使用中心点' })).toBeDisabled();
    await modal.getByLabel('全域搜索地点名或地址').fill('合成个人图书馆');
    await modal.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(modal.getByTestId('map-center')).toContainText('121.123456');
    await expect(modal.getByLabel('经度', { exact: true })).toHaveValue('');
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button', { name: '使用中心点' }).click();
    await expect(modal.getByLabel('经度', { exact: true })).toHaveValue('121.123456');
    await modal.getByLabel('名称', { exact: true }).fill(name);
    await modal.getByLabel('地址', { exact: true }).fill('E2E 个人地址');
    await modal.getByRole('button', { name: '保存个人地点' }).click();
    const row = page.locator('article').filter({ hasText: name });
    await expect(row).toBeVisible();
    const mine = (await (await request.get('/api/sign/locations/personal', { headers: adminHeaders })).json()).data as SignLocation[];
    savedID = mine.find(item => item.name === name)?.id;
    expect(savedID).toBeDefined();
    const otherHeaders = { Authorization: `Bearer ${account(false).token}` };
    const other = (await (await request.get('/api/sign/locations/personal', { headers: otherHeaders })).json()).data as SignLocation[];
    expect(other.some(item => item.id === savedID)).toBeFalsy();
    for (const method of ['put', 'delete'] as const) {
      const response = await request[method](`/api/sign/locations/personal/${savedID}`, {
        headers: otherHeaders, data: { name, address: 'takeover', latitude: 31, longitude: 121 },
      });
      expect(response.status()).toBe(404);
    }
    await row.getByRole('button', { name: '编辑' }).click();
    await modal.getByLabel('经度', { exact: true }).fill('');
    await modal.getByRole('button', { name: '保存个人地点' }).click();
    await expect(modal.getByRole('alert')).toContainText('完整的 GCJ-02 坐标');
    await modal.getByLabel('经度', { exact: true }).fill('181');
    await modal.getByRole('button', { name: '保存个人地点' }).click();
    await expect(modal.getByRole('alert')).toContainText('经度 -180～180');
    await modal.getByLabel('纬度', { exact: true }).fill('0');
    await modal.getByLabel('经度', { exact: true }).fill('0');
    await modal.getByLabel('地址', { exact: true }).fill('E2E 编辑后的个人地址');
    await modal.getByRole('button', { name: '保存个人地点' }).click();
    await expect(row).toContainText('E2E 编辑后的个人地址');
    const stored = (await (await request.get('/api/sign/locations/personal', { headers: adminHeaders })).json()).data as SignLocation[];
    expect(stored.find(item => item.id === savedID)).toMatchObject({ latitude: 0, longitude: 0 });
    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: '删除' }).click();
    await expect(row).toHaveCount(0);
    expect(previews).toBe(0);
    expect(globalWrites).toBe(0);
    expect(signs).toBe(0);
  } finally {
    if (savedID !== undefined) await request.delete(`/api/sign/locations/personal/${savedID}`, { headers: adminHeaders });
  }
});

for (const width of [221, 320, 430, 1024]) {
test(`地点界面 ${width}px 无横向溢出，固定保存与键盘焦点可用`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
  await authenticate(page, true);
  await mockInteractiveMap(page);
  await page.route('**/api/sign/locations/settings', route => route.fulfill({ json: { code: 0, data: { personal_only: true } } }));
  await page.route('**/api/sign/locations/personal', route => route.fulfill({ json: { code: 0, data: [{
    id: 7001, name: '图书馆 · 东侧入口', address: '合成大学南校区 · 图书馆东门，仅用于界面验证',
    latitude: 31.230416, longitude: 121.473701, is_personal: true, status: 'enabled',
  }] } }));
  const noOverflow = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    expect(await page.locator('.loc-dialog-body').evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBeTruthy();
  };
  await page.goto('/#/admin/sign-locations');
  await expect(page.getByRole('heading', { name: '图书馆 · 东侧入口' })).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: testInfo.outputPath(`places-${width}.png`) });
  await page.getByLabel('筛选我的地点').fill('不存在的地点');
  await expect(page.getByText('没有匹配的已保存地点')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  const add = page.getByRole('button', { name: '添加位置' });
  await add.click();
  const modal = page.getByRole('dialog', { name: '添加个人地点' });
  await expect(modal).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(modal.getByRole('button', { name: '保存个人地点' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(modal.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  await modal.getByRole('button', { name: '打开地图取点' }).click();
  await expect(modal.getByTestId('map-center')).toContainText('经度 104');
  await modal.getByTestId('map-image').scrollIntoViewIfNeeded();
  await noOverflow();
  const save = await modal.getByRole('button', { name: '保存个人地点' }).boundingBox();
  expect(save).not.toBeNull();
  expect(save!.y + save!.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
  await page.screenshot({ path: testInfo.outputPath(`map-${width}.png`) });
  await modal.getByLabel('名称', { exact: true }).fill('测试地点');
  await modal.getByRole('button', { name: '保存个人地点' }).click();
  await expect(modal.getByRole('alert')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(add).toBeFocused();
});
}

test('地图加载失败可原位重试，关闭弹层恢复原按钮焦点', async ({ page }) => {
  await authenticate(page);
  await mockInteractiveMap(page);
  await stubNearbyGPS(page);
  let requests = 0;
  await page.route('**/api/sign/locations/map-config', route => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 502, json: { code: 1, message: '地图服务暂时不可用' } })
      : route.fulfill({ json: { code: 0, data: { key: 'synthetic-js-key', service_path: '/api/amap-service/synthetic-grant' } } });
  });
  await openSign(page);
  const open = page.getByRole('button', { name: '打开地图选择位置' });
  await open.click();
  const modal = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(modal.getByRole('alert').filter({ hasText: '地图服务暂时不可用' })).toBeVisible();
  await modal.getByRole('button', { name: '重新加载地图' }).click();
  await expect(modal.getByRole('button', { name: '搜索', exact: true })).toBeEnabled();
  await expect(modal.getByRole('button', { name: '确认使用此坐标签到' })).toBeDisabled();
  expect(requests).toBe(2);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(open).toBeFocused();
});

test('地图中心只在明确确认后填表、平移缩放重新确认且保存pending', async ({ page, request }) => {
  await authenticate(page, true);
  await mockInteractiveMap(page);
  const maps: { center: { latitude: number; longitude: number } | null; zoom: number; direction?: string; meters?: number }[] = [];
  await page.route('**/api/admin/sign-locations/map-preview', async route => {
    const input = route.request().postDataJSON();
    maps.push(input);
    const center = input.center ?? { latitude: 39.9164, longitude: 116.4102 };
    await route.fulfill({ json: { code: 0, data: { center, zoom: input.zoom, image_data: '', coordinate_system: 'GCJ-02', campus_reference: !input.center } } });
  });
  let writes = 0, signs = 0;
  page.on('request', r => {
    if (r.url().endsWith('/api/admin/sign-locations') && r.method() === 'POST') writes++;
    if (r.url().includes('/sign/execute')) signs++;
  });
  await page.goto('/#/admin/sign-locations');
  await page.getByTitle('手动新增').click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: '打开地图取点' }).click();
  await expect(modal.getByTestId('map-center')).toContainText('经度 104');
  await expect(modal.getByRole('button', { name: '使用中心点' })).toBeDisabled();
  await expect(modal.getByLabel('纬度', { exact: true })).toHaveValue('0');
  const mapImage = modal.getByTestId('map-image');
  const firstBox = await mapImage.boundingBox();
  if (!firstBox) throw new Error('missing map image box');
  const mapSurface = await mapImage.getByLabel('可拖动交互地图').boundingBox();
  expect(mapSurface?.height).toBeGreaterThan(0);
  await page.mouse.click(firstBox.x + firstBox.width * 2 / 3, firstBox.y + firstBox.height / 2);
  await expect(modal.getByTestId('map-center')).not.toContainText('经度 104，');
  expect(maps).toHaveLength(0);
  const clickedCenter = await modal.getByTestId('map-center').textContent();
  const dragBox = await mapImage.boundingBox();
  if (!dragBox) throw new Error('missing interactive map box');
  await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width / 2 + 90, dragBox.y + dragBox.height / 2, { steps: 5 });
  await expect(modal.getByTestId('map-center')).not.toHaveText(clickedCenter ?? '');
  await page.mouse.up();
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: '放大' }).click();
  await expect(modal.getByTestId('map-center')).toContainText('缩放 5');
  await expect(modal.getByRole('checkbox')).not.toBeChecked();
  await expect(modal.getByLabel('经度', { exact: true })).toHaveValue('0');
  expect(writes).toBe(0);
  expect(maps).toHaveLength(0);
  const centerText = await modal.getByTestId('map-center').textContent();
  const longitudeMatch = centerText?.match(/经度 ([\d.-]+)/);
  if (!longitudeMatch) throw new Error('map center longitude missing');
  const selectedLongitude = Number(longitudeMatch[1]);
  await candidateCheckpoint(page, 'map-reference-pan-zoom-no-selection-no-write');
  await modal.getByRole('checkbox').check();
  await modal.getByRole('button', { name: '使用中心点' }).click();
  await expect(modal.getByLabel('经度', { exact: true })).toHaveValue(String(selectedLongitude));
  await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('');
  await modal.getByLabel('名称', { exact: true }).fill('E2E 地图明确取点');
  await modal.getByLabel('地址', { exact: true }).fill('合成地图，仅控件契约验收');
  await modal.getByRole('button', { name: '保存地点' }).click();
  const row = page.locator('article').filter({ hasText: 'E2E 地图明确取点' });
  await expect(row).toContainText('地图取点');
  await expect(row).toContainText('待确认');
  const result = (await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data as SignLocation[];
  const stored = result.find(item => item.name === 'E2E 地图明确取点');
  expect(stored).toMatchObject({ source: 'map_pick', status: 'pending', longitude: selectedLongitude, amap_poi_id: '' });
  expect(writes).toBe(1);
  expect(signs).toBe(0);
  await candidateCheckpoint(page, 'map-pick-explicit-save-pending');
});

test('地图搜索候选需明确选择后才居中且不自动保存或签到', async ({ page }) => {
  await authenticate(page, true);
  await mockInteractiveMap(page);
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e2e8f0"/><text x="20" y="50">SEARCH MAP</text></svg>').toString('base64');
  const maps: { center: { latitude: number; longitude: number } | null; zoom: number }[] = [];
  await page.route('**/api/admin/sign-locations/map-preview', route => {
    const input = route.request().postDataJSON();
    maps.push(input);
    return route.fulfill({ json: { code: 0, data: { center: input.center ?? { latitude: 0, longitude: 0 }, zoom: input.zoom,
      image_data: image, coordinate_system: 'GCJ-02', campus_reference: !input.center } } });
  });
  await page.route('**/api/admin/sign-locations/search-map', route => route.fulfill({ json: { code: 0, data: [
    { name: '合成图书馆东门', address: '合成校区东侧', latitude: 39.900001, longitude: 116.300001, amap_poi_id: 'east' },
    { name: '合成图书馆西门', address: '合成校区西侧', latitude: 39.900002, longitude: 116.300002, amap_poi_id: 'west' },
  ] } }));
  let writes = 0, signs = 0;
  page.on('request', r => { if (r.url().endsWith('/api/admin/sign-locations') && r.method() === 'POST') writes++; if (r.url().includes('/sign/execute')) signs++; });
  await page.goto('/#/admin/sign-locations');
  await page.getByTitle('手动新增').click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: '打开地图取点' }).click();
  await modal.getByLabel('全域搜索地点名或地址').fill('图书馆');
  await modal.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(modal.getByRole('status').filter({ hasText: '全域搜索找到' })).toContainText('全域搜索找到 2 个候选');
  await expect(modal.getByRole('button', { name: /合成图书馆东门/ })).toBeVisible();
  await modal.getByRole('button', { name: /合成图书馆西门/ }).click();
  await expect(modal.getByTestId('map-center')).toContainText('116.300002');
  await expect(modal.getByRole('checkbox')).not.toBeChecked();
  expect(maps).toHaveLength(0);
  expect(await page.evaluate(() => window.interactiveMapTest.centers.at(-1))).toEqual([116.300002, 39.900002]);
  expect(writes).toBe(0);
  expect(signs).toBe(0);
});

test('地图拖动期间中心连续变化，确认使用交互地图中心', async ({ page }) => {
  await stubNearbyGPS(page);
  await authenticate(page);
  await mockInteractiveMap(page);
  await page.route('**/api/sign/locations/map-preview', route => {
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { code: 0, data: { center: input.center ?? { latitude: 0, longitude: 0 }, zoom: input.zoom,
      image_data: '', coordinate_system: 'GCJ-02', campus_reference: !input.center } } });
  });
  await openSign(page);
  await page.getByRole('button', { name: '打开地图选择位置' }).click();
  const map = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(map.getByTestId('map-center')).toContainText('纬度 35');
  const mapBox = await map.getByTestId('map-image').boundingBox();
  if (!mapBox) throw new Error('missing interactive map box');
  const mapSurface = await map.getByLabel('可拖动交互地图').boundingBox();
  expect(mapSurface?.height).toBeGreaterThan(0);
  const start = await map.getByTestId('map-center').textContent();
  await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + mapBox.width / 2 + 100, mapBox.y + mapBox.height / 2, { steps: 5 });
  await expect(map.getByTestId('map-center')).not.toHaveText(start ?? '');
  await page.mouse.up();
  await expect(map.getByRole('checkbox')).not.toBeChecked();
  await expect(map.getByRole('button', { name: '确认使用此坐标签到' })).toBeDisabled();
});

test('签到地图地点搜索只移动交互地图，不匹配启用地点或自动签到', async ({ page }) => {
  await stubNearbyGPS(page);
  await authenticate(page);
  await mockInteractiveMap(page);
  await page.route('**/api/sign/locations', route => route.fulfill({ json: { code: 0, data: [] } }));
  await page.route('**/api/sign/locations/map-preview', route => route.fulfill({
    json: { code: 0, data: { center: { latitude: 0, longitude: 0 }, zoom: 16, image_data: '', campus_reference: true } },
  }));
  let searchBody: { keywords: string; scope: string } | undefined;
  await page.route('**/api/sign/locations/search-map', route => {
    searchBody = route.request().postDataJSON();
    return route.fulfill({ json: { code: 0, data: [
      { name: '合成教学楼', address: '合成校区', latitude: 39.900001, longitude: 116.300001 },
    ] } });
  });
  let executes = 0;
  page.on('request', request => { if (request.url().endsWith('/api/sign/execute')) executes++; });
  await openSign(page);
  await page.getByRole('button', { name: '打开地图选择位置' }).click();
  const map = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(map.getByLabel('全域搜索地点名或地址')).toBeVisible();
  await map.getByLabel('全域搜索地点名或地址').fill('教学楼');
  await map.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(map.getByRole('status')).toContainText('地图已移动到该候选中心');
  await expect(map.getByTestId('map-center')).toContainText('116.300001');
  await expect(map.getByRole('checkbox')).not.toBeChecked();
  expect(searchBody).toEqual({ keywords: '教学楼', scope: 'full' });
  expect(executes).toBe(0);
});

test('未配置校区且定位被拒绝时仍可在签到地图搜索', async ({ page }) => {
  await stubNearbyGPS(page);
  await authenticate(page);
  await mockInteractiveMap(page);
  await page.route('**/api/sign/locations', route => route.fulfill({ json: { code: 0, data: [] } }));
  let previews = 0;
  await page.route('**/api/sign/locations/map-preview', route => {
    previews++;
    return route.fulfill({ status: 502, json: { code: 1, message: '没有校区视图参考' } });
  });
  await page.route('**/api/sign/locations/search-map', route => route.fulfill({
    json: { code: 0, data: [{ name: '合成图书馆', address: '合成地址', latitude: 39.9, longitude: 116.3 }] },
  }));
  await openSign(page);
  await page.getByRole('button', { name: '打开地图选择位置' }).click();
  const map = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(map.getByText('当前为全国参考视图', { exact: false })).toBeVisible();
  await expect(map.getByRole('button', { name: '搜索', exact: true })).toBeEnabled();
  await map.getByLabel('全域搜索地点名或地址').fill('合成图书馆');
  await map.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(map.getByTestId('map-center')).toContainText('116.3');
  await expect(map.getByText('当前为全国参考视图', { exact: false })).toHaveCount(0);
  await expect(map.getByRole('checkbox')).not.toBeChecked();
  expect(previews).toBe(0);
  expect(await page.evaluate(() => window.interactiveMapTest.zooms.at(-1))).toBe(16);
});

test('定位未返回时地图即可搜索且迟到定位不会覆盖搜索中心', async ({ page }) => {
  await authenticate(page);
  await mockInteractiveMap(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (success: PositionCallback) => {
        window.addEventListener('release-test-gps', () => success({
          coords: { latitude: 39, longitude: 115, accuracy: 20, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
          timestamp: Date.now(), toJSON: () => ({}),
        }), { once: true });
      },
    } });
  });
  await page.route('**/api/sign/locations', route => route.fulfill({ json: { code: 0, data: [] } }));
  await page.route('**/api/sign/locations/coordinate-preview', route => route.fulfill({
    json: { code: 0, data: { point: { latitude: 39, longitude: 115 }, accuracy: 20, converted: true } },
  }));
  await page.route('**/api/sign/locations/search-map', route => route.fulfill({
    json: { code: 0, data: [{ name: '合成图书馆', address: '合成地址', latitude: 39.9, longitude: 116.3 }] },
  }));
  await openSign(page);
  await page.getByRole('button', { name: '打开地图选择位置' }).click();
  const map = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(map.getByRole('button', { name: '搜索', exact: true })).toBeEnabled({ timeout: 5000 });
  await map.getByLabel('全域搜索地点名或地址').fill('合成图书馆');
  await map.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(map.getByTestId('map-center')).toContainText('116.3');
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-gps')));
  await expect(map.getByText('现场定位精度 20 米；可继续拖动地图微调。')).toBeVisible();
  await expect(map.getByTestId('map-center')).toContainText('116.3');
});

test('坐标采集非安全上下文、超时与预览权限均明确拒绝', async ({ page, request }) => {
  for (const endpoint of ['coordinate-preview', 'map-preview']) {
    expect((await request.post(`/api/admin/sign-locations/${endpoint}`, { data: {} })).status()).toBe(401);
    expect((await request.post(`/api/admin/sign-locations/${endpoint}`, { headers: { Authorization: `Bearer ${account(false).token}` }, data: {} })).status()).toBe(403);
  }
  await authenticate(page, true);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: (_ok: PositionCallback, fail: PositionErrorCallback) => fail({ code: 3, message: 'synthetic timeout', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) } });
  });
  await page.goto('/#/admin/sign-locations');
  await page.getByTitle('手动新增').click();
  await page.getByRole('button', { name: '浏览器现场定位' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('安全环境');
  await page.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: true }));
  await page.getByRole('button', { name: '浏览器现场定位' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('定位超时');
});

test('候选连续搜索只读、确认保存定位及管理员修改保护', async ({ page, request }) => {
  test.setTimeout(120_000);
  const history = await createLocation(request, 'E2E 历史地点保留');
  const first = candidate('E2E 合成教学楼', 'e2e-search-teaching');
  const second = candidate('E2E 合成图书馆', 'e2e-search-library');
  await authenticate(page, true);
  await page.route('**/api/admin/sign-locations/search', route => {
    const query = route.request().postDataJSON();
    expect(query.scope).toBe('full');
    return route.fulfill({ json: { code: 0, data: [query.keywords === '图书馆' ? second : first] } });
  });
  const list = async (): Promise<SignLocation[]> => (await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data;
  const before = await list();
  await page.goto('/#/admin/sign-locations');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const results = page.getByRole('region', { name: '本次搜索结果' });
  await expect(results.getByTestId('search-candidate')).toContainText(first.name);
  expect(await list()).toEqual(before);
  await candidateCheckpoint(page, 'first-search-readonly');
  await page.getByRole('button', { name: '图书馆', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(results.getByTestId('search-candidate')).toContainText(second.name);
  await expect(results).not.toContainText(first.name);
  await expect(results).toContainText('来源：高德 POI');
  await expect(results).toContainText('31.1234567');
  expect(await list()).toEqual(before);
  await candidateCheckpoint(page, 'second-search-replaces-first');
  const savedResponse = page.waitForResponse(r => r.url().endsWith('/api/admin/sign-locations/candidates'));
  await results.getByRole('button', { name: '确认保存为待确认' }).click();
  const saved: SaveCandidateResult = (await (await savedResponse).json()).data;
  expect(saved.created).toBe(true);
  expect(saved.location).toMatchObject({ status: 'pending', source: 'amap', latitude: 31.123457, amap_poi_id: second.amap_poi_id });
  const row = page.locator(`#saved-location-${saved.location.id}`);
  await expect(row).toHaveAttribute('data-highlighted', 'true');
  await expect(row.getByText('待确认', { exact: true })).toBeVisible();
  expect((await list()).length).toBe(before.length + 1);
  expect((await list()).find(item => item.id === history.id)).toEqual(before.find(item => item.id === history.id));
  await candidateCheckpoint(page, 'confirmed-pending-located');
  await row.getByRole('button', { name: '明确启用' }).click();
  await expect(row.getByText('已启用', { exact: true })).toBeVisible();
  const enabled: { data: SignLocation[] } = await (await request.get('/api/sign/locations', { headers: adminHeaders })).json();
  expect(enabled.data.some(item => item.id === saved.location.id)).toBe(true);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('E2E 管理员修订图书馆');
  await page.getByLabel('纬度', { exact: true }).fill('32');
  await page.getByRole('button', { name: '保存地点', exact: true }).click();
  await expect(row).toContainText('E2E 管理员修订图书馆');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const existingResponse = page.waitForResponse(r => r.url().endsWith('/api/admin/sign-locations/candidates'));
  await results.getByRole('button', { name: '确认保存为待确认' }).click();
  const existing: SaveCandidateResult = (await (await existingResponse).json()).data;
  expect(existing).toMatchObject({ created: false, location: { id: saved.location.id, name: 'E2E 管理员修订图书馆', latitude: 32, status: 'enabled' } });
  await expect(row).toHaveAttribute('data-highlighted', 'true');
  expect((await list()).length).toBe(before.length + 1);
  await candidateCheckpoint(page, 'existing-location-preserved');
});

test('候选乱序、空结果和失败不残留旧结果，支持完整名称', async ({ page }) => {
  test.setTimeout(90_000);
  await authenticate(page, true);
  let releaseSlow!: () => void;
  const gate = new Promise<void>(resolve => { releaseSlow = resolve; });
  await page.route('**/api/admin/sign-locations/search', async route => {
    const query = route.request().postDataJSON();
    expect(query.scope).toBe('full');
    if (query.keywords === '慢学校教学楼') await gate;
    if (query.keywords === '无结果') return route.fulfill({ json: { code: 0, data: [] } });
    if (query.keywords === '失败') return route.fulfill({ status: 503, json: { code: 503, message: '合成上游暂不可用' } });
    return route.fulfill({ json: { code: 0, data: [candidate(`E2E ${query.keywords}`, `e2e-${query.keywords}`)] } });
  });
  try {
    await page.goto('/#/admin/sign-locations');
    await page.getByLabel('检索方式', { exact: true }).selectOption('full');
    const input = page.getByPlaceholder('搜索关键词，默认教学楼');
    const results = page.getByRole('region', { name: '本次搜索结果' });
    await input.fill('慢学校教学楼');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(results.getByRole('status')).toContainText('正在搜索');
    await expect(results.getByTestId('search-candidate')).toHaveCount(0);
    await input.fill('新学校图书馆');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(results.getByTestId('search-candidate')).toContainText('新学校图书馆');
    const oldResponse = page.waitForResponse(r => r.url().endsWith('/search') && r.request().postDataJSON().keywords === '慢学校教学楼');
    releaseSlow();
    await oldResponse;
    await candidateCheckpoint(page, 'newest-search-wins');
    await expect(results).not.toContainText('慢学校教学楼');
    for (const term of ['无结果', '失败']) {
      await input.fill(term);
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await expect(results.getByTestId('search-candidate')).toHaveCount(0);
      if (term === '无结果') await expect(results).toContainText('本次未找到有效候选');
      else await expect(results.getByRole('alert')).toHaveText('合成上游暂不可用');
      await candidateCheckpoint(page, term === '无结果' ? 'empty-results' : 'failed-results');
    }
    await input.fill('楼'.repeat(65));
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(results.getByRole('alert')).toHaveText('搜索关键词不能超过 64 个字符');
  } finally { releaseSlow(); }
});

test('候选保存API校验、来源状态固定且不恢复已删记录', async ({ request }) => {
  const body = candidate('E2E 候选删除保护', 'e2e-deleted');
  const save = (data: object) => request.post('/api/admin/sign-locations/candidates', { headers: adminHeaders, data });
  expect((await save({ ...body, latitude: 91 })).status()).toBe(400);
  expect((await save({ ...body, name: '' })).status()).toBe(400);
  expect((await save({ name: body.name, address: body.address })).status()).toBe(400);
  const response = await save({ ...body, source: 'manual', status: 'enabled' });
  expect(response.ok()).toBeTruthy();
  const result: SaveCandidateResult = (await response.json()).data;
  expect(result).toMatchObject({ created: true, location: { source: 'amap', status: 'pending' } });
  expect((await request.delete(`/api/admin/sign-locations/${result.location.id}`, { headers: adminHeaders })).ok()).toBeTruthy();
  const deleted = await save(body);
  expect(deleted.status()).toBe(409);
  expect((await deleted.json()).data).toMatchObject({ error_code: 'SIGN_LOCATION_DELETED', location: { id: result.location.id } });
  const listed: { data: SignLocation[] } = await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json();
  expect(listed.data.some(item => item.amap_poi_id === body.amap_poi_id)).toBe(false);
});

test('已删除候选行内提示不堆toast、取消恢复零写、确认恢复保留旧内容', async ({ page, request }) => {
  test.setTimeout(120_000);
  const input = candidate('E2E 恢复候选原楼名', 'e2e-restore-ui');
  const saved: SaveCandidateResult = (await (await request.post('/api/admin/sign-locations/candidates', { headers: adminHeaders, data: input })).json()).data;
  const id = saved.location.id;
  await request.put(`/api/admin/sign-locations/${id}`, { headers: adminHeaders, data: { name: 'E2E 管理员修订旧楼', address: '合成旧地址需保留', latitude: 33, longitude: 115 } });
  await request.post(`/api/admin/sign-locations/${id}/enable`, { headers: adminHeaders });
  await request.delete(`/api/admin/sign-locations/${id}`, { headers: adminHeaders });
  await authenticate(page, true);
  await page.route('**/api/admin/sign-locations/search', route => route.fulfill({
    json: { code: 0, data: [input], query_keywords: '合成大学 第一教学楼' },
  }));
  let saveCalls = 0;
  let restoreCalls = 0;
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/candidates')) saveCalls++;
    if (r.method() === 'POST' && r.url().endsWith('/restore')) restoreCalls++;
  });
  await page.goto('/#/admin/sign-locations');
  const results = page.getByRole('region', { name: '本次搜索结果' });
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByTestId('actual-query')).toHaveText('实际检索词：合成大学 第一教学楼');
  await results.getByRole('button', { name: '确认保存为待确认' }).click();
  await expect(results.getByRole('alert')).toContainText('已被删除');
  await expect(results.getByRole('button', { name: '确认保存为待确认' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '已被删除' })).toHaveCount(0);
  await expect(results).toContainText('E2E 管理员修订旧楼');
  for (let i = 0; i < 5; i++) {
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('不会自动启用');
      expect(dialog.message()).toContain(`（#${id}）`);
      await dialog.dismiss();
    });
    await results.getByRole('button', { name: '确认恢复旧地点为待确认' }).click();
  }
  expect(saveCalls).toBe(1);
  expect(restoreCalls).toBe(0);
  await expect(results.getByRole('alert')).toHaveCount(1);
  const list = async (): Promise<SignLocation[]> => (await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data;
  expect((await list()).some(row => row.id === id)).toBe(false);
  await candidateCheckpoint(page, 'deleted-inline-five-cancels-no-toast');
  expect((await request.post(`/api/admin/sign-locations/${id}/restore`, { headers: adminHeaders, data: { confirmed: false } })).status()).toBe(400);
  expect((await list()).some(row => row.id === id)).toBe(false);
  const response = page.waitForResponse(r => r.url().endsWith(`/${id}/restore`));
  page.once('dialog', dialog => dialog.accept());
  await results.getByRole('button', { name: '确认恢复旧地点为待确认' }).click();
  const restored: SaveCandidateResult = (await (await response).json()).data;
  expect(restored).toMatchObject({ created: false, restored: true, location: { id, name: 'E2E 管理员修订旧楼', address: '合成旧地址需保留', latitude: 33, longitude: 115, status: 'pending', source: 'amap' } });
  const row = page.locator(`#saved-location-${id}`);
  await expect(row).toHaveAttribute('data-highlighted', 'true');
  await expect(row).toContainText('待确认');
  await expect(results.getByRole('alert')).toHaveCount(0);
  const enabled = (await (await request.get('/api/sign/locations', { headers: adminHeaders })).json()).data as SignLocation[];
  expect(enabled.some(item => item.id === id)).toBe(false);
  await candidateCheckpoint(page, 'restored-old-fields-pending-highlight');
  await row.getByRole('button', { name: '明确启用' }).click();
  await expect(row).toContainText('已启用');
  const repeat: SaveCandidateResult = (await (await request.post(`/api/admin/sign-locations/${id}/restore`, { headers: adminHeaders, data: { confirmed: true } })).json()).data;
  expect(repeat).toMatchObject({ restored: false, location: { id, status: 'enabled', name: 'E2E 管理员修订旧楼' } });
  expect((await request.post('/api/admin/sign-locations/0/restore', { headers: adminHeaders, data: { confirmed: true } })).status()).toBe(400);
  expect((await request.post('/api/admin/sign-locations/999999/restore', { headers: adminHeaders, data: { confirmed: true } })).status()).toBe(404);
});

test('候选普通409或网络失败不能误判可恢复，重复错误保持单条内联', async ({ page }) => {
  test.setTimeout(90_000);
  await authenticate(page, true);
  await page.route('**/api/admin/sign-locations/search', route => route.fulfill({ json: { code: 0, data: [candidate('E2E 普通错误候选', 'e2e-ordinary-error')] } }));
  let attempt = 0;
  await page.route('**/api/admin/sign-locations/candidates', route => {
    attempt++;
    if (attempt === 3) return route.abort('failed');
    return route.fulfill({ status: 409, json: { code: 1, message: '该候选对应的地点已被删除（合成普通冲突文案，不是类型依据）', data: { error_code: 'SIGN_LOCATION_CONFLICT' } } });
  });
  await page.goto('/#/admin/sign-locations');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const results = page.getByRole('region', { name: '本次搜索结果' });
  for (let i = 0; i < 4; i++) {
    await results.getByRole('button', { name: i === 0 ? '确认保存为待确认' : '重试保存候选' }).click();
    await expect(results.getByRole('alert')).toHaveCount(1);
    await expect(results.getByRole('button', { name: '确认恢复旧地点为待确认' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: '已被删除' })).toHaveCount(0);
  }
  await candidateCheckpoint(page, 'ordinary-error-not-restorable-no-toast');
});

test('候选保存中的新搜索不错误标记新候选已保存', async ({ page }) => {
  test.setTimeout(90_000);
  await authenticate(page, true);
  const first = candidate('E2E 保存中教学楼', 'e2e-inflight-a');
  const next = candidate('E2E 新搜索图书馆', 'e2e-inflight-b');
  await page.route('**/api/admin/sign-locations/search', route => route.fulfill({
    json: { code: 0, data: [route.request().postDataJSON().keywords === '图书馆' ? next : first] },
  }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/admin/sign-locations/candidates', async route => {
    if (route.request().postDataJSON().amap_poi_id === first.amap_poi_id) await gate;
    await route.continue();
  });
  try {
    await page.goto('/#/admin/sign-locations');
    const results = page.getByRole('region', { name: '本次搜索结果' });
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await results.getByRole('button', { name: '确认保存为待确认' }).click();
    await expect(results.getByRole('button', { name: '正在保存…' })).toBeVisible();
    await page.getByRole('button', { name: '图书馆', exact: true }).click();
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(results.getByTestId('search-candidate')).toContainText(next.name);
    await expect(results.getByRole('button', { name: '正在保存…' })).toHaveCount(0);
    const saved = page.waitForResponse(r => r.url().endsWith('/candidates'));
    release();
    const old: SaveCandidateResult = (await (await saved).json()).data;
    await expect(page.locator(`#saved-location-${old.location.id}`)).toHaveAttribute('data-highlighted', 'true');
    await expect(results.getByRole('button', { name: '确认保存为待确认' })).toBeEnabled();
    await expect(results.getByRole('button', { name: '查看已保存地点' })).toHaveCount(0);
    await candidateCheckpoint(page, 'old-save-does-not-mark-new-result');
    const savedNext = page.waitForResponse(r => r.url().endsWith('/candidates'));
    await results.getByRole('button', { name: '确认保存为待确认' }).click();
    const current: SaveCandidateResult = (await (await savedNext).json()).data;
    expect(current.created).toBe(true);
    expect(current.location.id).not.toBe(old.location.id);
  } finally { release(); }
});

test('签到选点149米可匹配151米不可匹配、排序与空集不造点', () => {
  const point = { latitude: 0, longitude: 0 };
  const row = (id: number, meters: number, status: SignLocation['status'] = 'enabled') => ({
    id, name: `合成${id}`, address: '测试', latitude: meters / EARTH_RADIUS_METERS * 180 / Math.PI, longitude: 0, status, source: 'manual', amap_poi_id: '',
  } as SignLocation);
  const near = row(1, 149), far = row(2, 151), pending = row(3, 0, 'pending');
  expect(distanceMeters(point, near)).toBeCloseTo(149, 7);
  expect(distanceMeters(point, far)).toBeCloseTo(151, 7);
  expect(nearestEnabledLocation([far, pending, near], point)?.id).toBe(1);
  expect(nearestEnabledLocation([far, pending], point)).toBeNull();
  expect(nearestEnabledLocation([], point)).toBeNull();
  expect(rankEnabledLocations([far, near, pending], point).map(item => item.location.id)).toEqual([1, 2]);
});

test('签到选点普通用户只读预览可达、管理写拒绝、坐标不能代替ID', async ({ request }) => {
  const headers = { Authorization: `Bearer ${account(false).token}` };
  const before = (await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data.length;
  const preview = await request.post('/api/sign/locations/coordinate-preview', { headers, data: { latitude: 39.915, longitude: 116.404, accuracy: 20, captured_at: '2026-09-25T06:00:00Z' } });
  expect(preview.status()).toBe(200);
  expect((await preview.json()).data.point).toEqual({ latitude: 39.916404, longitude: 116.410244 });
  const map = await request.post('/api/sign/locations/map-preview', { headers, data: { center: { latitude: 39, longitude: 116 }, zoom: 16 } });
  expect(map.status()).toBe(502);
  expect((await map.json()).message).toContain('后端未配置高德服务');
  for (const endpoint of ['coordinate-preview', 'map-preview']) {
    expect((await request.post(`/api/sign/locations/${endpoint}`, { data: {} })).status()).toBe(401);
  }
  for (const endpoint of ['', '/search', '/candidates', '/1/enable', '/1/restore']) {
    expect((await request.post(`/api/admin/sign-locations${endpoint}`, { headers, data: {} })).status()).toBe(403);
  }
  expect((await request.get('/api/admin/sign-locations', { headers })).status()).toBe(403);
  for (const extras of [{}, { latitude: 39.9, longitude: 116.4, special_params: { latitude: '39.9', longitude: '116.4', location_id: 99 } }]) {
    const response = await request.post('/api/sign/execute', { headers, data: { activity_id: 99001, course_id: 99001, class_id: 99001, sign_type: 4, ...extras } });
    expect((await response.json()).data).toMatchObject({ success: false, message: '请选择有效的签到地点' });
  }
  expect((await (await request.get('/api/admin/sign-locations', { headers: adminHeaders })).json()).data.length).toBe(before);
});

async function setupNearbyFixtures(request: APIRequestContext) {
  const rows: SignLocation[] = [];
  for (const [index, meters] of [149, 151, 0].entries()) {
    const response = await request.post('/api/admin/sign-locations', { headers: adminHeaders, data: {
      name: `E2E 附近${meters}米`, address: '公开样例附近合成地点，不是真实楼栋',
      latitude: 39.916404 + meters / EARTH_RADIUS_METERS * 180 / Math.PI, longitude: 116.410244,
    } });
    expect(response.ok()).toBeTruthy();
    const row = (await response.json()).data as SignLocation;
    if (index < 2) expect((await request.post(`/api/admin/sign-locations/${row.id}/enable`, { headers: adminHeaders })).ok()).toBeTruthy();
    rows.push(row);
  }
  return rows;
}

async function stubNearbyGPS(page: Page) {
  await page.addInitScript(() => {
    let calls = 0;
    window.captureTest = { calls: [] };
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (success: PositionCallback, fail: PositionErrorCallback, options: PositionOptions) => {
        window.captureTest.calls.push(options);
        if (++calls === 1) { fail({ code: 1, message: 'synthetic denial', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); return; }
        success({ coords: { latitude: 39.915, longitude: 116.404, accuracy: 20, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
          timestamp: Date.parse('2026-09-25T06:00:00Z'), toJSON: () => ({}) });
      },
    } });
  });
}

async function mockInteractiveMap(page: Page) {
  await page.route('**/api/sign/locations/map-config', route => route.fulfill({
    json: { code: 0, data: { key: 'synthetic-js-key', service_path: '/api/amap-service/synthetic-grant' } },
  }));
  await page.route('https://webapi.amap.com/maps**', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      window.AMap = { Map: class {
        constructor(container, options) {
          this.center = options.center;
          this.zoom = options.zoom;
          this.listeners = new Map();
          window.interactiveMapTest = { centers: [this.center], zooms: [this.zoom] };
          let drag = null;
          const emit = event => (this.listeners.get(event) || []).forEach(callback => callback());
          container.addEventListener('pointerdown', event => { drag = [event.clientX, event.clientY, event.clientX, event.clientY]; });
          container.addEventListener('pointermove', event => {
            if (!drag || !(event.buttons & 1)) return;
            this.center = [this.center[0] - (event.clientX - drag[0]) * 0.00001, this.center[1] + (event.clientY - drag[1]) * 0.00001];
            drag[0] = event.clientX;
            drag[1] = event.clientY;
            emit('move');
          });
          container.addEventListener('pointerup', event => {
            if (drag) {
              if (Math.hypot(event.clientX - drag[2], event.clientY - drag[3]) < 6) {
                const rect = container.getBoundingClientRect();
                this.center = [this.center[0] + (event.clientX - rect.left - rect.width / 2) * 0.00001,
                  this.center[1] - (event.clientY - rect.top - rect.height / 2) * 0.00001];
                emit('move');
              }
              emit('moveend');
            }
            drag = null;
          });
          this.emit = emit;
        }
        getCenter() { return { getLng: () => this.center[0], getLat: () => this.center[1] }; }
        getZoom() { return this.zoom; }
        resize() {}
        setCenter(center) { this.center = center; window.interactiveMapTest.centers.push(center); this.emit('move'); this.emit('moveend'); }
        setZoom(zoom) { this.zoom = zoom; window.interactiveMapTest.zooms.push(zoom); this.emit('move'); this.emit('moveend'); }
        on(event, callback) { this.listeners.get(event)?.push(callback) ?? this.listeners.set(event, [callback]); }
        off(event, callback) { this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== callback)); }
        destroy() {}
      } };
    `,
  }));
}

test('签到选点列表现场定位行内重试、按距离排序但不自动选中', async ({ page, request }) => {
  const [near, far, pending] = await setupNearbyFixtures(request);
  await stubNearbyGPS(page);
  await authenticate(page);
  let executes = 0, writes = 0;
  page.on('request', r => {
    if (r.url().includes('/sign/execute')) executes++;
    if (r.url().includes('/admin/') && r.method() !== 'GET') writes++;
  });
  await openSign(page);
  await expect(page.getByRole('button', { name: '打开地图选择位置' })).toBeVisible();
  await page.getByText('点击选择地点', { exact: true }).first().click();
  await page.getByRole('button', { name: '现场定位', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toContainText('定位权限被拒绝');
  await candidateCheckpoint(page, 'sign-list-gps-denied-inline');
  await page.getByRole('button', { name: '现场定位', exact: true }).click();
  await expect(page.getByTestId('nearby-preview')).toContainText('116.410244');
  const options = page.getByTestId('enabled-location-option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText(near.name);
  await expect(options.nth(1)).toContainText(far.name);
  await expect(page.getByText(pending.name, { exact: true })).toHaveCount(0);
  const storedMeridianDistance = (near.latitude - 39.916404) * Math.PI / 180 * EARTH_RADIUS_METERS;
  expect(storedMeridianDistance).toBeGreaterThan(148.8);
  expect(storedMeridianDistance).toBeLessThan(149.2);
  await expect(options.nth(0)).toContainText(`${storedMeridianDistance.toFixed(1)} 米`);
  await expect(page.getByRole('heading', { name: '选择签到位置' })).toBeVisible();
  await candidateCheckpoint(page, 'sign-list-distance-sorted-no-auto-selection');
  await page.getByRole('button', { name: '使用最近地点' }).click();
  await expect(page.getByRole('heading', { name: '选择签到位置' })).toHaveCount(0);
  await expect(page.getByText(near.name, { exact: true })).toBeVisible();
  expect(executes).toBe(0); expect(writes).toBe(0);
});

test('一键现场定位不依赖已启用地点并提交本次 GCJ-02 坐标', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (success: PositionCallback) => {
        success({ coords: { latitude: 39.915, longitude: 116.404, accuracy: 20, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
          timestamp: Date.parse('2026-09-25T06:00:00Z'), toJSON: () => ({}) });
      },
    } });
  });
  await authenticate(page);
  await page.route('**/api/sign/locations', route => route.fulfill({ status: 503, json: { code: 503, message: '合成地点列表不可用' } }));
  await page.route('**/api/sign/check', route => route.fulfill({ json: { code: 0, data: { items: [] } } }));
  await page.route('**/api/sign/execute', route => route.fulfill({ json: { code: 0, data: { success: true, message: '合成一键签到完成' } } }));
  await openSign(page);

  const requestSent = page.waitForRequest(route => route.url().endsWith('/api/sign/execute'));
  await page.getByRole('button', { name: '一键现场定位并签到' }).click();
  const body = (await requestSent).postDataJSON();

  expect(body).toMatchObject({
    sign_type: 4,
    location_mode: 'device_gps',
    device_location: {
      latitude: 39.916404,
      longitude: 116.410244,
      accuracy: 20,
      captured_at: '2026-09-25T06:00:00Z',
      coordinate_system: 'GCJ-02',
    },
    special_params: {},
  });
  expect(body.location_id).toBeUndefined();
  await expect(page.getByText('合成一键签到完成', { exact: true })).toBeVisible();
});

test('位置签到主操作并列展示一键定位和地图选择，非位置签到不显示', async ({ page }, testInfo) => {
  await stubNearbyGPS(page);
  await authenticate(page);
  await mockInteractiveMap(page);
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e2e8f0"/></svg>').toString('base64');
  await page.route('**/api/sign/locations/map-preview', route => {
    const input = route.request().postDataJSON();
    return route.fulfill({ json: { code: 0, data: { center: input.center ?? { latitude: 0, longitude: 0 }, zoom: input.zoom,
      image_data: image, coordinate_system: 'GCJ-02', campus_reference: !input.center } } });
  });
  await openSign(page);
  const actions = page.getByRole('group', { name: '位置签到主操作' });
  await expect(actions.getByRole('button', { name: '一键现场定位并签到' })).toBeVisible();
  await expect(actions.getByRole('button', { name: '打开地图选择位置' })).toBeVisible();
  await expect(page.getByText('点击选择地点', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sign-location-actions.png') });
  await actions.getByRole('button', { name: '打开地图选择位置' }).click();
  await expect(page.getByRole('dialog', { name: '地图选择签到位置' })).toBeVisible();

  await openSign(page, 2, 'sign/99001', true);
  await expect(page.getByRole('button', { name: '一键现场定位并签到' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开地图选择位置' })).toHaveCount(0);
});

test('一键现场定位失败可重试且重复点击只执行一次', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: {
      getCurrentPosition: (success: PositionCallback) => {
        success({ coords: { latitude: 39.915, longitude: 116.404, accuracy: 20, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
          timestamp: Date.parse('2026-09-25T06:00:00Z'), toJSON: () => ({}) });
      },
    } });
  });
  await authenticate(page);
  let previews = 0;
  await page.route('**/api/sign/locations/coordinate-preview', route => {
    previews++;
    return previews === 1
      ? route.fulfill({ status: 503, json: { code: 503, message: '合成定位预览失败' } })
      : route.fulfill({ json: { code: 0, data: {
        point: { latitude: 39.916404, longitude: 116.410244 }, accuracy: 20,
        captured_at: '2026-09-25T06:00:00Z', poor_accuracy: false, coordinate_system: 'GCJ-02',
        converted: true, warning: '',
      } } });
  });
  await page.route('**/api/sign/check', route => route.fulfill({ json: { code: 0, data: { items: [] } } }));
  let executes = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sign/execute', async route => {
    executes++;
    await gate;
    await route.fulfill({ json: { code: 0, data: { success: true, message: '合成重试签到完成' } } });
  });
  try {
    await openSign(page);
    const button = page.getByRole('button', { name: '一键现场定位并签到' });
    await button.click();
    await expect(page.getByText('合成定位预览失败', { exact: true })).toBeVisible();
    await button.evaluate(element => { element.click(); element.click(); });
    await expect.poll(() => executes).toBe(1);
    release();
    await expect(page.getByText('合成重试签到完成', { exact: true })).toBeVisible();
  } finally {
    release();
  }
});

test('地图中心直接用于本次签到，不搜索或匹配附近已启用地点', async ({ page }) => {
  await stubNearbyGPS(page);
  await authenticate(page);
  await mockInteractiveMap(page);
  const requests: { center: { latitude: number; longitude: number } | null; zoom: number; direction?: string }[] = [];
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e2e8f0"/><text x="20" y="50">SYNTHETIC MAP - ENABLED LOCATIONS ONLY</text></svg>').toString('base64');
  await page.route('**/api/sign/locations/map-preview', route => {
    const input = route.request().postDataJSON();
    requests.push(input);
    return route.fulfill({ json: { code: 0, data: { center: input.center ?? { latitude: 0, longitude: 0 }, zoom: input.zoom,
      image_data: image, coordinate_system: 'GCJ-02', campus_reference: !input.center } } });
  });
  let executes = 0, locationLists = 0, writes = 0;
  await page.route('**/api/sign/locations', route => {
    locationLists++;
    return route.fulfill({ json: { code: 0, data: [] } });
  });
  await page.route('**/api/sign/check', route => route.fulfill({ json: { code: 0, data: { items: [] } } }));
  await page.route('**/api/sign/execute', async route => {
    executes++;
    await route.fulfill({ json: { code: 0, data: { success: true, message: '地图坐标签到已提交' } } });
  });
  page.on('request', r => { if (r.url().includes('/admin/') && r.method() !== 'GET') writes++; });
  await openSign(page);
  await page.getByRole('button', { name: '打开地图选择位置' }).click();
  const map = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(map.getByRole('button', { name: '回到目前位置' })).toBeVisible();
  await expect(map.getByRole('alert')).toContainText('定位权限被拒绝');
  await expect(map.getByTestId('map-center')).toContainText('纬度 35');
  expect(requests).toHaveLength(0);
  await map.getByRole('button', { name: '回到目前位置' }).click();
  await expect(map.getByTestId('map-center')).toContainText('116.410244');
  await map.getByRole('checkbox').check();
  const locationListsBeforeConfirmation = locationLists;
  await map.getByRole('button', { name: '确认使用此坐标签到' }).click();
  await expect(map).toHaveCount(0);
  await expect(page.getByText('地图选择点', { exact: true })).toBeVisible();
  await expect(page.getByText(/GCJ-02：纬度 39\.916404，经度 116\.410244/)).toBeVisible();
  const listCountAfterMapSelection = locationLists;
  expect(listCountAfterMapSelection).toBe(locationListsBeforeConfirmation);
  await candidateCheckpoint(page, 'sign-map-point-selected-directly-with-no-nearby-lookup');
  const executeRequest = page.waitForRequest(r => r.url().endsWith('/api/sign/execute'));
  await page.getByRole('button', { name: /立即签到/ }).click();
  const body = (await executeRequest).postDataJSON();
  expect(body).toMatchObject({
    sign_type: 4,
    location_mode: 'map_pick',
    map_location: { latitude: 39.916404, longitude: 116.410244, coordinate_system: 'GCJ-02' },
    special_params: {},
  });
  expect(body.location_id).toBeUndefined();
  await expect(page.getByText('地图坐标签到已提交', { exact: true })).toBeVisible();
  expect(locationLists).toBe(listCountAfterMapSelection);
  expect(executes).toBe(1); expect(writes).toBe(0);
});

test('地图回到目前位置会重设地图中心并要求重新确认', async ({ page }) => {
  await stubNearbyGPS(page);
  await authenticate(page);
  await mockInteractiveMap(page);
  const requests: { center: { latitude: number; longitude: number } | null; zoom: number; direction?: string }[] = [];
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#e2e8f0"/><text x="20" y="50">SYNTHETIC MAP</text></svg>').toString('base64');
  await page.route('**/api/sign/locations/map-preview', route => {
    const input = route.request().postDataJSON();
    requests.push(input);
    return route.fulfill({ json: { code: 0, data: { center: input.center ?? { latitude: 0, longitude: 0 }, zoom: input.zoom,
      image_data: image, coordinate_system: 'GCJ-02', campus_reference: !input.center } } });
  });
  await openSign(page);
  await page.getByRole('button', { name: '打开地图选择位置' }).click();
  const map = page.getByRole('dialog', { name: '地图选择签到位置' });
  await expect(map.getByRole('button', { name: '回到目前位置' })).toBeVisible();
  await expect(map.getByRole('alert')).toContainText('定位权限被拒绝');
  await expect(map.getByTestId('map-center')).toContainText('纬度 35');
  expect(requests).toHaveLength(0);
  await map.getByRole('button', { name: '回到目前位置' }).click();
  await expect(map.getByTestId('map-center')).toContainText('116.410244');
  await expect(map.getByRole('checkbox')).not.toBeChecked();
  expect(requests).toHaveLength(0);
  expect(await page.evaluate(() => window.interactiveMapTest.centers.at(-1))).toEqual([116.410244, 39.916404]);
  expect(await page.evaluate(() => window.captureTest.calls.length)).toBe(2);
  await candidateCheckpoint(page, 'sign-map-auto-denial-retry-current-gcj-center');
  await map.getByRole('checkbox').check();
  await map.getByRole('button', { name: '放大' }).click();
  await expect(map.getByRole('checkbox')).not.toBeChecked();
  await map.getByRole('checkbox').check();
  await expect(map.getByRole('button', { name: '确认使用此坐标签到' })).toBeEnabled();
});

test('用户无地点提示、必选校验、加载失败及重新加载', async ({ page }) => {
  await authenticate(page);
  await openSign(page);
  await expect(page.getByText('暂无可用签到地点')).toBeVisible();
  await page.getByRole('button', { name: /立即签到/ }).click();
  await expect(page.getByText('请先选择签到地点')).toBeVisible();
  let attempts = 0;
  await page.route('**/api/sign/locations', route => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { code: 503, message: '合成加载失败' } })
      : route.continue();
  });
  await page.reload();
  await page.getByText('点击选择地点', { exact: true }).first().click();
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('button', { name: '重新加载' })).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('用户选择只提交 location_id，停用及删除由真实后端拒绝', async ({ page, request }) => {
  const location = await createLocation(request, 'E2E 用户地点');
  await request.post(`/api/admin/sign-locations/${location.id}/enable`, { headers: adminHeaders });
  await authenticate(page);
  await openSign(page);
  await page.getByText('点击选择地点', { exact: true }).first().click();
  await page.getByText(location.name, { exact: true }).click();
  await request.post(`/api/admin/sign-locations/${location.id}/disable`, { headers: adminHeaders });
  const sent = page.waitForRequest(r => r.url().endsWith('/api/sign/execute'));
  await page.getByRole('button', { name: /立即签到/ }).click();
  const body = (await sent).postDataJSON();
  expect(body.sign_type).toBe(4);
  expect(body.location_id).toBe(location.id);
  expect(body.special_params).toEqual({});
  await expect(page.getByText('签到地点不可用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '✕', exact: true }).click();
  await request.delete(`/api/admin/sign-locations/${location.id}`, { headers: adminHeaders });
  const rejected = await request.post('/api/sign/execute', {
    headers: { Authorization: `Bearer ${account(false).token}` }, data: body,
  });
  expect((await rejected.json()).data).toMatchObject({ success: false, message: '签到地点不可用' });
  await page.reload();
  await expect(page.getByText('暂无可用签到地点')).toBeVisible();
});

test('活动只加载一次，课程空列表只同步一次且保存选择无请求循环', async ({ page }) => {
  await authenticate(page);
  let activities = 0;
  await page.route('**/api/sign/activities', route => {
    activities++;
    return route.fulfill({ json: { code: 0, data: [] } });
  });
  await page.goto('/#/');
  await expect.poll(() => activities).toBe(1);
  let loads = 0;
  let syncs = 0;
  await page.route('**/api/courses', route => {
    loads++;
    return route.fulfill({ json: { code: 0, data: loads === 1 ? [] : [{ course_id: 99001, class_id: 99001, name: '隔离测试课程', is_selected: false }] } });
  });
  await page.route('**/api/courses/sync', route => { syncs++; return route.fulfill({ json: { code: 0 } }); });
  await page.goto('/#/courses');
  await page.getByText('隔离测试课程', { exact: true }).click();
  await page.route('**/api/courses/selection', async route => {
    expect(route.request().postDataJSON()).toEqual({ course_ids: [99001] });
    await route.fulfill({ json: { code: 0 } });
  });
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page).toHaveURL(/\/#\/$/);
  expect(loads).toBe(2);
  expect(syncs).toBe(1);
});

test('受控手势短路径重置、跳点补齐且请求参数保持兼容', async ({ page }) => {
  await authenticate(page);
  await openSign(page, 3);
  const canvas = page.locator('canvas');
  const rect = await canvas.boundingBox();
  if (!rect) throw new Error('手势画布不可见');
  const point = (x: number, y: number) => page.mouse.move(rect.x + x, rect.y + y);
  await point(44, 44);
  await page.mouse.down();
  await point(110, 44);
  await page.mouse.up();
  await expect(page.getByText('手势至少连接 4 个点')).toBeVisible();
  await page.getByRole('button', { name: /立即签到/ }).click();
  await expect(page.getByText('请输入正确位数的签到码 / 手势')).toBeVisible();
  await point(44, 44);
  await page.mouse.down();
  await point(176, 44);
  await point(176, 176);
  await page.mouse.up();
  const sent = page.waitForRequest(r => r.url().endsWith('/api/sign/execute'));
  await page.getByRole('button', { name: /立即签到/ }).click();
  expect((await sent).postDataJSON().special_params).toEqual({ sign_code: '12369' });
  await page.getByRole('button', { name: '✕', exact: true }).click();
});

test('原生相机桥切换/拍照重渲染不重启，退出撤销照片 URL', async ({ page }) => {
  await authenticate(page);
  await page.addInitScript(() => {
    const active: boolean[] = [];
    const lenses: string[] = [];
    const revoked: string[] = [];
    let captures = 0;
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
    Object.assign(window, {
      cameraTest: { active, lenses, revoked },
      XBTCameraBridge: {
        isReady: () => true,
        getCameraState: () => JSON.stringify({ active: true }),
        setScannerActive: (value: boolean) => {
          active.push(value);
          setTimeout(() => window.dispatchEvent(new CustomEvent('xbt-native-camera-state', { detail: { active: value } })), 0);
        },
        setLensFacing: (value: string) => lenses.push(value),
        syncPunchHole: () => {},
        takePhoto: () => {
          const base64 = document.createElement('canvas').toDataURL('image/png');
          if (++captures === 1) return Promise.resolve(base64);
          setTimeout(() => window.dispatchEvent(new CustomEvent('xbt-native-photo', { detail: { base64 } })), 0);
        },
      },
    });
  });
  await openSign(page, 0, 'photo-capture');
  await expect(page.locator('[data-native-ready="1"]')).toBeVisible();
  await page.getByRole('button', { name: '切换摄像头' }).click();
  await page.getByRole('button', { name: '前置摄像头' }).click();
  const activeBefore = await page.evaluate(() => window.cameraTest.active.length);
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.getByText('已添加至照片池')).toBeVisible();
  await page.getByRole('button', { name: '拍照', exact: true }).click();
  await expect(page.locator('img')).toHaveCount(2);
  expect(await page.evaluate(() => window.cameraTest.active.length)).toBe(activeBefore);
  await page.getByRole('button', { name: /完成/ }).click();
  await expect(page).toHaveURL(/\/#\/sign\/99001$/);
  await expect.poll(() => page.evaluate(() => window.cameraTest.revoked.length)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.cameraTest.active.at(-1))).toBe(false);
});

test('原生扫码使用最新回调且进度重渲染不重启相机', async ({ page }, testInfo) => {
  await authenticate(page);
  await page.addInitScript(() => {
    const active: boolean[] = [];
    Object.assign(window, {
      cameraTest: { active, lenses: [], revoked: [] },
      XBTCameraBridge: {
        isReady: () => true,
        getCameraState: () => JSON.stringify({ active: true }),
        setScannerActive: (value: boolean) => {
          active.push(value);
          setTimeout(() => window.dispatchEvent(new CustomEvent('xbt-native-camera-state', { detail: { active: value } })), 0);
        },
        setLensFacing: () => {},
        syncPunchHole: () => {},
      },
    });

    navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('原生模式不应打开 Web 摄像头'));
  });
  await openSign(page, 2, 'scanner');
  await expect(page.locator('[data-native-ready="1"]')).toBeVisible();
  await page.route('**/api/sign/locations', route => route.fulfill({ json: { code: 0, data: [
    { id: 98765, name: '当前账号的个人地点', address: '合成地址', latitude: 31, longitude: 121, status: 'enabled', is_personal: true },
  ] } }));
  await page.getByRole('button', { name: '选择扫码签到位置' }).click();
  await expect(page.getByText('我的常用', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('scanner-place-picker.png') });
  await expect(page.getByText('一号教学楼', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /当前账号的个人地点.*合成地址/ }).click();
  await expect(page.getByRole('heading', { name: '选择签到位置' })).toHaveCount(0);
  const activeBefore = await page.evaluate(() => window.cameraTest.active.length);
  const sent = page.waitForRequest(r => r.url().endsWith('/api/sign/execute'));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('xbt-native-qr', {
    detail: { text: 'https://mobilelearn.chaoxing.com/?enc=isolated-test&c=isolated' },
  })));
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ sign_type: 2, location_id: 98765, special_params: { enc: 'isolated-test', c: 'isolated' } });
  expect(body.special_params.latitude).toBeUndefined();
  await expect(page.getByText('签到地点不可用')).toBeVisible();
  expect(await page.evaluate(() => window.cameraTest.active.length)).toBe(activeBefore);
  await page.getByRole('button', { name: '✕', exact: true }).click();
  await expect(page.getByText('签到进度', { exact: true })).toHaveCount(0);
});

test('二维码签到仅动态二维码显示最新码提示', async ({ page }) => {
  await authenticate(page);
  await openSign(page, 2, 'sign/99001', true);
  await expect(page.getByRole('status')).toHaveText('动态二维码：请扫描老师当前展示的最新二维码，旧截图可能失效。');

  await openSign(page, 2, 'sign/99001', false);
  await expect(page.getByRole('status')).toHaveCount(0);
});
