import { createServer, request } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const blockedMessage = '隔离网关禁止外部业务入口';

export function createGateway(dist, android = false) {
  const stats = { blockedExecutions: 0, forwardedExecutions: 0 };
  const activity = { active_id: 99001, activity_name: '隔离位置签到', sign_type: 4, course_id: 99001, class_id: 99001, if_photo: false, if_refresh_ewm: false, start_time: Date.now(), end_time: Date.now() + 3_600_000, course_name: '隔离课程' };
  const course = { course_id: 99001, class_id: 99001, course_name: '隔离课程', course_teacher: '测试', activities: [activity] };
  const json = (res, status, body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:33081');
    const denied = () => json(res, 403, { code: 403, message: blockedMessage });
    if (!['http://127.0.0.1:33081', 'http://10.0.2.2:33081'].includes(url.origin)) return denied();
    if (android) {
      if (url.pathname === '/api/sign/activities') return json(res, 200, { code: 0, data: [course] });
      if (url.pathname === '/api/sign/classmates') return json(res, 200, { code: 0, data: [] });
      if (url.pathname === '/api/sign/check') return json(res, 200, { code: 0, data: { items: [] } });
      if (url.pathname === '/api/admin/sign-locations/search') return denied();
      if (url.pathname.startsWith('/api/sign/') && url.pathname !== '/api/sign/locations') {
        if (url.pathname === '/api/sign/execute') stats.blockedExecutions++;
        return denied();
      }
    }
    if (url.pathname.startsWith('/api/')) {
      const allowed = /^\/api\/(?:health|media\/image|sign\/(?:locations(?:\/(?:settings|personal(?:\/\d+)?|search-map|map-config|coordinate-preview|map-preview))?|classmates|check|execute)|admin\/sign-locations(?:\/(?:search|search-map|candidates|coordinate-preview|map-preview|\d+(?:\/(?:enable|disable|restore))?))?)$/.test(url.pathname);
      if (!allowed) return denied();
      if (url.pathname === '/api/sign/execute') stats.forwardedExecutions++;
      const upstream = request({
        hostname: '127.0.0.1', port: 33030, path: url.pathname + url.search, method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:33030' },
      }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => json(res, 502, { code: 502, message: '隔离后端不可用' }));
      req.pipe(upstream);
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch (error) {
      if (!(error instanceof URIError)) throw error;
      return json(res, 400, { code: 400, message: '请求路径编码无效' });
    }
    const target = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(dist + path.sep) || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' }[path.extname(target)] || 'application/octet-stream' });
    res.end(readFileSync(target));
  });
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
  return { server, stats, activity, course };
}
