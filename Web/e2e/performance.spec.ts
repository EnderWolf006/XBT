import { createHmac } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import type { CourseActivities, SignActivity } from '../src/types';
import { describeSignRules } from '../src/utils/signRules';

const source = 'https://photo.chaoxing.com/p/isolated-test?temp=1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function account(uid = 99002, permission = 1) {
  const secret = process.env.XBT_E2E_JWT_SECRET;
  if (!secret) throw new Error('缺少隔离测试密钥');
  const user = { uid, name: `测试用户${uid}`, mobile: 'e2e-user', avatar: source, permission };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return { user, token: `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}` };
}

async function authenticate(page: Page, admin = false) {
  const savedAccount = account(admin ? 99001 : 99002, admin ? 2 : 1);
  await page.addInitScript(value => {
    localStorage.setItem('accounts', JSON.stringify([value]));
    localStorage.setItem('activeUid', String(value.user.uid));
  }, savedAccount);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === 'http://127.0.0.1:33081' ? route.continue() : route.abort('blockedbyclient');
  });
  return savedAccount;
}

test('头像和课程封面同源加载、合并并发请求且不直接请求超星图片', async ({ page }) => {
  const savedAccount = await authenticate(page);
  const courses = [{
    course_id: 1, class_id: 1, course_name: '测试课程', course_teacher: '测试', icon: source, activities: [],
  }];
  await page.addInitScript(courses => {
    Object.defineProperty(AbortSignal, 'any', { value: undefined });
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined });
    Object.defineProperty(window, 'IntersectionObserver', { value: undefined });
    localStorage.setItem('cached_activities_99002', JSON.stringify(courses));
  }, courses);
  const outside: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).hostname.endsWith('chaoxing.com')) outside.push(request.resourceType());
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  await page.route('**/api/media/image?*', async route => {
    count++;
    expect(route.request().headers().authorization).toBe(`Bearer ${savedAccount.token}`);
    expect(new URL(route.request().url()).searchParams.get('source')).toBe(source);
    await gate;
    await route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.route('**/api/sign/activities', route => route.fulfill({ json: { code: 0, data: courses } }));
  try {
    await page.goto('/#/');
    await expect(page.getByRole('img', { name: '测试课程（默认图像）', exact: true })).toBeVisible();
    release();
    await expect(page.locator('img[alt="测试用户99002"]')).toBeVisible();
    await expect(page.locator('img[alt="测试课程"]')).toBeVisible();
    await expect.poll(() => page.locator('img[alt="测试用户99002"]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    expect(count).toBe(1);
    expect(outside).toEqual([]);
  } finally {
    release();
  }
});

test('头像请求失败显示替代图像，不退出账号也不重复回源', async ({ page }) => {
  await authenticate(page);
  let count = 0;
  await page.route('**/api/media/image?*', route => {
    count++;
    return route.fulfill({ status: 401, json: { code: 401, message: '合成图片鉴权失败' } });
  });
  await page.route('**/api/sign/activities', route => route.fulfill({ json: { code: 0, data: [] } }));
  await page.goto('/#/');
  await expect(page.getByRole('img', { name: '测试用户99002（加载失败）', exact: true })).toBeVisible();
  await page.getByTitle('刷新活动').click();
  await expect(page).toHaveURL(/#\/$/);
  expect(await page.evaluate(() => localStorage.getItem('activeUid'))).toBe('99002');
  expect(count).toBe(1);
});

test('活动刷新失败保留本账号缓存、明确提示且手动刷新绕过短缓存', async ({ page }) => {
  await authenticate(page);
  await page.addInitScript(() => {
    localStorage.setItem('cached_activities_99002', JSON.stringify([{
      course_id: 1, class_id: 1, course_name: '本账号缓存课程', course_teacher: '测试', activities: [],
    }]));
    localStorage.setItem('cached_activities_99001', JSON.stringify([{
      course_id: 2, class_id: 2, course_name: '另一个账号的课程', course_teacher: '测试', activities: [],
    }]));
  });
  await page.route('**/api/media/image?*', route => route.fulfill({ status: 502, body: '' }));
  let force = false;
  await page.route('**/api/sign/activities', route => {
    force ||= route.request().headers()['cache-control'] === 'no-cache';
    return route.fulfill({ status: 504, json: { code: 504, message: '活动刷新超时，请稍后重试' } });
  });
  await page.goto('/#/');
  await expect(page.getByText('本账号缓存课程', { exact: true })).toBeVisible();
  await expect(page.getByText('另一个账号的课程', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('列表可能不是最新');
  await page.getByTitle('刷新活动').click();
  await expect.poll(() => force).toBeTruthy();
});

test('图片接口要求登录并拒绝任意来源，不访问真实学习通', async ({ request }) => {
  const response = await request.get('/api/media/image?source=https%3A%2F%2Fexample.com%2Fimage.png');
  expect(response.status()).toBe(401);
  for (const source of ['http://127.0.0.1/secret', 'https://example.com/image.png', 'file:///etc/passwd']) {
    const denied = await request.get('/api/media/image', { params: { source }, headers: { Authorization: `Bearer ${account().token}` } });
    expect(denied.status()).toBe(400);
    expect((await denied.json()).message).toContain('图片加载失败');
  }
});

const places = [
  { id: 88001, name: '示例大学龙湖校区3号楼', address: '示例大学龙湖校区 · 第三教学楼北侧入口（示例数据）', latitude: 34.781825, longitude: 113.791829, is_personal: true },
  { id: 88002, name: '示例大学龙湖校区信息工程学院', address: '示例大学龙湖校区 · 信息工程学院东门（示例数据）', latitude: 34.777505, longitude: 113.798006, is_personal: true },
];

async function markPreview(page: Page) {
  await page.evaluate(() => {
    const note = document.createElement('aside');
    note.textContent = '界面预览 · 示例数据，不代表真实签到';
    note.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:200;background:#172554;color:#fff;text-align:center;padding:5px;font-size:11px;pointer-events:none';
    document.body.appendChild(note);
  });
}

for (const width of [221, 430, 700, 768, 1024, 1440]) {
  test(`响应式560px内容框：${width}px地点卡片不挤压文字和按钮`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 980 });
    await authenticate(page, true);
    await page.route('**/api/sign/locations/settings', route => route.fulfill({ json: { code: 0, data: { personal_only: true } } }));
    await page.route('**/api/sign/locations/personal', route => route.fulfill({ json: { code: 0, data: places } }));
    await page.goto('/#/admin/sign-locations');
    await expect(page.getByRole('heading', { name: places[1].name })).toBeVisible();
    const shell = page.locator('.app-shell').first();
    const box = await shell.boundingBox();
    expect(box?.width).toBe(width >= 768 ? 560 : Math.min(width, 480));
    const cards = page.locator('.loc-saved-card');
    expect(await cards.count()).toBe(2);
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
    expect(await page.locator('.loc-page').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    expect(await cards.evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBeTruthy();
    for (const card of await cards.all()) {
      const privacy = await card.locator('.loc-privacy').boundingBox();
      expect(privacy!.height).toBeLessThan(24);
      const edit = card.getByRole('button', { name: '编辑', exact: true });
      expect(await edit.evaluate(element => element.scrollWidth <= element.clientWidth)).toBeTruthy();
      expect((await edit.boundingBox())!.height).toBe(44);
    }
    if (width === 430 || width === 1024) {
      await markPreview(page);
      await shell.screenshot({ path: testInfo.outputPath(`places-${width}.png`) });
    }
    await page.getByLabel('筛选我的地点').fill('信息工程');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(places[1].name);
    await cards.first().getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '编辑个人地点' }).getByLabel('名称', { exact: true })).toHaveValue(places[1].name);
    if (width === 1024) {
      await page.route('**/api/courses', route => route.fulfill({ json: { code: 0, data: [{ course_id: 1, class_id: 1, name: '示例课程', teacher: '示例教师', is_selected: true }] } }));
      await page.goto('/#/courses');
      await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeVisible();
      expect((await page.locator('.app-shell.fixed').boundingBox())!.width).toBe(560);
    }
  });
}

for (const width of [430, 1024]) {
  test(`滚动条隐藏${width}px：页面和弹层仍可滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 640 });
    await authenticate(page, true);
    const manyPlaces = Array.from({ length: 8 }, (_, index) => ({
      ...places[index % places.length], id: 89001 + index, name: `滚动示例地点${index + 1}`,
    }));
    await page.route('**/api/sign/locations/settings', route => route.fulfill({ json: { code: 0, data: { personal_only: true } } }));
    await page.route('**/api/sign/locations/personal', route => route.fulfill({ json: { code: 0, data: manyPlaces } }));
    await page.goto('/#/admin/sign-locations');
    await expect(page.locator('.loc-saved-card')).toHaveCount(8);
    const scroll = page.locator('.loc-page');
    await expect(scroll).toHaveCSS('scrollbar-width', 'none');
    expect(await scroll.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').display)).toBe('none');
    expect(await scroll.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
    const box = (await scroll.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    const add = page.getByRole('button', { name: '添加位置', exact: true });
    await add.focus();
    await page.keyboard.press('End');
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
    const bottom = await scroll.evaluate(element => element.scrollTop);
    await page.keyboard.press('PageUp');
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(bottom - 100);
    await page.mouse.wheel(0, -3000);
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeLessThan(2);
    await add.click();
    await expect(page.getByRole('dialog', { name: '添加个人地点' })).toBeVisible();
    await page.setViewportSize({ width, height: 420 });
    const dialogBody = page.locator('.loc-dialog-body');
    await expect(dialogBody).toHaveCSS('scrollbar-width', 'none');
    expect(await dialogBody.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').display)).toBe('none');
    expect(await dialogBody.evaluate(element => element.closest('#root'))).toBeNull();
    expect(await dialogBody.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(20);
    const dialogBox = (await dialogBody.boundingBox())!;
    await page.mouse.move(dialogBox.x + dialogBox.width / 2, dialogBox.y + dialogBox.height / 2);
    await page.mouse.wheel(0, 160);
    await expect.poll(() => dialogBody.evaluate(element => element.scrollTop)).toBeGreaterThan(20);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  });
}

function ruleActivity(id: number, overrides: Partial<SignActivity> = {}): SignActivity {
  return {
    active_id: id, activity_name: `规则示例${id}`, sign_type: 2, course_id: 88001, class_id: 88001,
    start_time: Date.now() - 60_000, end_time: Date.now() + 3_600_000, course_name: '规则示例课程',
    course_teacher: '示例教师', if_photo: false, if_refresh_ewm: false, record_source: 0,
    record_source_name: '', record_sign_time: 0, rules_verified: true, ...overrides,
  };
}

const ruleCases = [
  { activity: ruleActivity(1, { sign_type: 3 }), label: '手势' },
  { activity: ruleActivity(2), label: '二维码' },
  { activity: ruleActivity(3, { if_get_range: true }), label: '二维码 + 位置' },
  { activity: ruleActivity(4, { if_get_range: true, if_photo: true }), label: '二维码 + 位置 + 人脸' },
  { activity: ruleActivity(5, { sign_type: 0, if_photo: true }), label: '拍照' },
  { activity: ruleActivity(6, { sign_type: 4, if_get_range: true, if_photo: true }), label: '位置 + 人脸' },
  { activity: ruleActivity(7, { sign_type: 5, need_face: true }), label: '签到码 + 人脸' },
  { activity: ruleActivity(9, { rules_verified: false }), label: '二维码（规则待核实）' },
  { activity: ruleActivity(10, { rules_verified: undefined }), label: '二维码（规则待核实）' },
];

test('签到规则组合保留主方式，位置在前且不重复，拍照不冒充活体人脸', () => {
  for (const { activity, label } of ruleCases) expect(describeSignRules(activity)).toBe(label);
});

for (const width of [221, 430, 1024]) {
  test(`签到规则组合${width}px：完整显示且不把二维码人脸误标为拍照`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1100 });
    await authenticate(page);
    const course: CourseActivities = { course_id: 88001, class_id: 88001, course_name: '规则示例课程', course_teacher: '示例教师', icon: '', has_more: false, activities: ruleCases.slice(0, 4).map(value => value.activity) };
    await page.route('**/api/media/image?*', route => route.fulfill({ contentType: 'image/png', body: png }));
    await page.route('**/api/sign/activities', route => route.fulfill({ json: { code: 0, data: [course] } }));
    await page.goto('/#/');
    await page.getByText('规则示例课程', { exact: true }).click();
    const labels = page.locator('.sign-rule-label');
    await expect(labels).toHaveCount(4);
    for (let index = 0; index < 4; index++) {
      await expect(labels.nth(index)).toHaveText(ruleCases[index].label);
      expect(await labels.nth(index).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
    }
    const faceRow = labels.nth(3).locator('xpath=../../..');
    await expect(faceRow.locator('svg.lucide-qr-code')).toHaveCount(1);
    await expect(faceRow.locator('svg.lucide-camera')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    if (width === 430 || width === 1024) {
      await markPreview(page);
      await page.locator('.app-shell').first().screenshot({ path: testInfo.outputPath(`rules-${width}.png`) });
    }
  });
}

test('签到规则组合在新签到提醒和详情标题一致，App人脸另行提示', async ({ page }) => {
  await authenticate(page);
  const gesture = ruleActivity(1, { sign_type: 3 });
  const combined = ruleActivity(8, { if_get_range: true, need_face: true });
  let loads = 0;
  await page.route('**/api/media/image?*', route => route.fulfill({ contentType: 'image/png', body: png }));
  await page.route('**/api/sign/activities', route => route.fulfill({ json: { code: 0, data: [{
    course_id: 88001, class_id: 88001, course_name: '规则示例课程', course_teacher: '示例教师',
    icon: '', has_more: false, activities: ++loads === 1 ? [gesture] : [gesture, combined],
  }] } }));
  await page.route('**/api/sign/classmates?*', route => route.fulfill({ json: { code: 0, data: [] } }));
  await page.route('**/api/sign/locations', route => route.fulfill({ json: { code: 0, data: [] } }));
  await page.goto('/#/');
  await page.getByText('规则示例课程', { exact: true }).click();
  await expect(page.getByLabel('签到要求：手势', { exact: true })).toBeVisible();
  await page.getByTitle('刷新活动').click();
  await expect(page.getByText(/新签到：规则示例课程.*二维码 \+ 位置 \+ 人脸/)).toContainText('需在学习通 App 完成人脸验证');
  await page.getByLabel('签到要求：二维码 + 位置 + 人脸', { exact: true }).click();
  await expect(page.getByRole('heading', { name: '二维码 + 位置 + 人脸', exact: true })).toBeVisible();
  await expect(page.getByText('人脸验证（活体）', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '需学习通 App 人脸验证', exact: true })).toBeDisabled();
});

test('签到规则组合不把未核实的旧缓存显示成无需位置', async ({ page }) => {
  await authenticate(page);
  const pending = ruleActivity(9, { rules_verified: false });
  const known = ruleActivity(3, { if_get_range: true });
  await page.route('**/api/sign/activities', route => route.fulfill({ json: { code: 0, data: [{
    course_id: 88001, class_id: 88001, course_name: '规则示例课程', course_teacher: '示例教师',
    icon: '', has_more: false, activities: [pending, known],
  }] } }));
  await page.goto('/#/');
  await page.getByText('规则示例课程', { exact: true }).click();
  await expect(page.getByLabel('签到要求：二维码（规则待核实）', { exact: true })).toBeVisible();
  await expect(page.getByLabel('签到要求：二维码 + 位置', { exact: true })).toBeVisible();
});
