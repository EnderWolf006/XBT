# 学不通部署包

这是从项目工作目录制作的独立分发包，不是原部署的数据库备份。
请先完整解压到固定目录，例如 `D:\Apps\XBT-Deploy`，不要在压缩软件内部直接运行。

## 内容与边界

公开多账号部署建议设置 `personal_locations_only: true`：地点管理入口改为“我的常用地点”，
每个账号只能查看、编辑和调用自己的地点，即使拥有管理员权限也不例外。
没有创建者的旧公共记录不会删除或自动分配，但会隐藏并禁止调用，需要本人重新保存。
该配置默认关闭以兼容原公共地点管理；切换前请备份配置和数据库，更新后端与前端并重启后端。
未配置统一校区地址时，添加地图可直接从全国参考视图搜索、取点，无须设置所有用户共用的校区。

地图、地点表单和签到位置选择使用统一的移动端弹层：标题与保存按钮固定，内容独立滚动；
键盘 Tab 限制在弹层内，Escape 可关闭并回到原按钮。地图搜索、定位与缩放分别提供明确控件，
长说明和手动参考中心默认折叠。地图取点仍需勾选确认，保存不自动签到，地点隔离规则不变。

电脑端（视口至少768px）主内容框居中、最大560px；较窄视口保留原480px上限并随屏幕收缩。
页面和弹层隐藏原生滚动条外观，仍可使用鼠标滚轮、触摸和键盘滚动，不改变滚动范围或页面宽度。
个人地点卡片按实际可用宽度排列，不按浏览器宽度强行双列；隐私提示及编辑、删除按钮不会被挤成竖排。
首页活动、出现新签到的提醒和详情标题统一展示“签到方式 + 位置 + 人脸”，如“二维码 + 位置 + 人脸”。
“位置”由位置签到、教师限定范围或新版详情 `ifopenAddress` 的位置校验要求决定，
不把用户可选附加地点当必需要求；普通拍照签到仍称“拍照”，需要学习通 App 完成的人脸验证另行明确提示。
规则读取同时使用旧详情的时间/主方式和新版 PPT 详情的校验标志；旧详情的 `ifGetRange=0`
不能证明未开启位置校验。新版详情取代原独立的人脸预加载请求，不增加轮询或后台任务，
仍受活动请求8秒总期限、全局4条课程链和每请求2门课程的限制，两种详情单响应最多256KiB。
旧活动缓存会按规则版本在访问时重新核实一次，已结束且已核实的活动继续复用缓存；
未能核实的旧缓存明确显示“规则待核实”，不能把缺失数据当成不需要位置。
升级需要更新后端并重启，自动为活动缓存表增加版本列；不清空课程选择、个人地点或签到记录，
不调整定位偏移、坐标转换或实际提交协议。

网站选点、搜索、现场定位预览和地点存储统一使用高德 GCJ-02。后端向学习通提交位置签到、
以及携带已选地点的二维码签到时，在外部请求边界转换一次为百度 BD-09，不修改数据库坐标，
不新增外部地图请求或后台任务。未标注坐标系的旧直接调用参数保留原有透传行为。
手动录入地点也必须遵守 GCJ-02 契约；如果早期录入的是百度坐标，应由本人在高德地图重新取点，
不能仅凭数值猜测坐标系或批量偏移。此次适配不追改历史签到，也不表示已回读学习通最终落点。

可选全站偏移 `sign_location_offset` 默认纬度、经度均为 `0`（关闭）。启用后所有用户通过
地图选点、现场定位、常用地点和扫码附加地点提交的 GCJ-02 点，都会在 BD-09 转换前加一次
该角度差；地图显示与数据库仍是原点。提交前按偏移后的 GCJ-02 反查真实地址，
学习通仅显示“中国 + 地图服务返回的完整地址”，不提交选点来源、坐标或偏移调试文字。
反查使用现有高德服务端 Key，每次携带网站地点的提交增加一次最多8秒的请求；
失败或地址为空会明确拒绝本次提交，不回退到虚构地址。实际地址层级取决于地图数据，
不保证与学习通原生地图供应商的街道命名逐字一致；不改变学习通自身的字体、缩放或控件。
例如 `latitude: -0.000093`、`longitude: 0.000027` 会将
公开演示坐标 `39.915000, 116.404000` 移到 `39.914907, 116.404027`，即向南、向东的小幅位移。
这是运营者主动设置的位移，不是地图精度修正；角度差相同不表示全球各纬度米数相同。
修改服务器配置后重启后端生效，改回两个 `0` 即关闭；不回写历史签到，不影响无位置签到，
未标注坐标系的旧直接调用参数不偏移。最终物理落点仍须在新测试活动中核对。

- 包含 Server、Web、Android 源码及测试、依赖锁文件、历史技术文档。
- 包含由本包源码重新构建的 Windows x64 和 Linux x64 后端，以及 Web 静态页面。
- 不包含原部署账号、数据库数据、数据库备份、真实配置、SSH 密钥、API 密钥、运行日志。
- 不包含 node_modules、Android 构建缓存和 APK。Android 需要单独配置并构建。
- 旧管理器包含绝对路径和旧数据库恢复操作，未复制；本包启动器不会导入原用户数据。
- 原快捷方式不能跨电脑直接使用。根目录 CMD 为便携入口；解压后可生成自己的桌面 LNK。
- `docs`、`Android\UPSTREAM.md` 为历史开发记录，其中原机器路径不适用于本机部署，以本说明为准。
- 网站依赖学习通、高德等外部服务。源码和进程正常不保证第三方登录或签到可用。
  若遇到 `passport403.html` / 重定向循环，应排查外部接口和部署网络，不要关闭认证或增加跳转上限。
- 本包不提供“本机开机后自动后台常驻”或自动迁移线上数据库；运行窗口需保持打开。

## Windows 首次部署

### 1. 安装运行依赖

安装 Node.js 24 LTS（包含 npm）和 PostgreSQL 14 或更高版本。
预编译后端支持 Windows x64；运行它不需要安装 Go。
本包未内置上述安装程序，首次安装 Web 依赖也需要联网。

### 2. 创建自己的数据库

使用 PostgreSQL 的 SQL Shell / psql，以数据库管理员登录，执行：

```sql
CREATE ROLE xbt LOGIN;
\password xbt
CREATE DATABASE xbt OWNER xbt;
```

`\password` 会交互提示输入新密码；不要使用原部署者的密码。
应用启动时会自动创建当前版本的表，不需要再手动执行 `Server\init.sql`。
不要把空包直接连到他人的生产库；如需连接已有库，应先独立备份并核对密钥和版本。

### 3. 配置项目

双击 `Configure-XBT.cmd`，首次运行会创建 `Server\config.yaml` 并生成两个独立随机密钥。
在打开的记事本中，将 `postgres_dsn` 的 `CHANGE_ME_DB_PASSWORD` 替换为刚设置的数据库密码；
按自己的 PostgreSQL 安装情况调整 host、port、user、dbname。
DSN 值含空格时需遵守 PostgreSQL DSN 引号规则，同时保持外层 YAML 字符串合法。

保留 `http_addr: "127.0.0.1:3030"`，这是本地启动器使用的默认后端端口。
不要重复生成或随意修改 `credential_secret`，它关系到已有账号凭据的解密。
JWT 和凭据密钥必须备份，不能随同二次分享包泄露。

新部署模板默认开启白名单、不给所有访客管理员权限，并启用 TLS 证书校验。
如果运营者明确允许任何学习通账号登录，可设置：

```yaml
public_access: true
public_admin: false
```

这只放开本项目白名单，仍须学习通真实验证通过。
不要将 `public_admin` 设为 true，除非确实希望所有成功登录者都成为管理员。
保持白名单模式时，应由运营者首先完成可信账号的初始化。
地图相关 Key 留空时，相应地图功能不可用；请填写自己申请的服务端/JS API 配置。
签到页交互地图不依赖固定校区地址：先显示已选地点或有提示的全国参考视图，现场定位并行进行，不阻塞地图和搜索；定位返回后仅在用户尚未操作地图时自动移动到当前位置，避免覆盖已搜索或核对的地点。管理员的“校区 + 建筑关键词”检索仍需配置 `amap.campus_address`，未配置时请使用“完整学校 / 地点名称”检索。
管理员默认使用完整地点名称检索，快捷关键词不会切换检索方式。扫码页从登录账号可见地点接口加载公共启用地点和个人常用地点，不再使用包内固定学校预设；选择后提交地点 ID，由后端校验归属并读取坐标。不选择地点时保持无位置扫码。

### 4. 启动与快捷方式

1. 确认 PostgreSQL 服务已运行。
2. 双击 `Start-XBT.cmd`。首次启动自动执行 `npm ci` 安装锁定的 Web 依赖。
3. 启动器会检查后端、网页及 API 代理，然后打开 `http://127.0.0.1:5173/`。
4. 双击 `Create-Desktop-Shortcuts.cmd`，即可在当前用户桌面创建“学不通-启动”和“学不通-配置”。
5. `Open-Web.url` 只打开网页，不负责启动服务。

启动器只监听本机，不会自动开放防火墙或公网端口。
运行日志显示在启动窗口中。请用 Ctrl+C 正常退出，使启动器清理本次进程；
强制结束 PowerShell 或异常关机不能保证清理，应检查端口后重新启动。
PostgreSQL 由接收方管理，启动器不会停止、删除或重建数据库。
如果端口 3030 / 5173 已被占用，启动器会报错，不会杀死其他程序。
高级用户可修改配置中的 `http_addr`，并使用匹配的
`launcher\Start-XBT.ps1 -ApiPort 33030 -WebPort 33081`；普通快捷方式仍使用默认端口。

移动解压目录后，需要删除本包生成的两个旧快捷方式，再重新创建。
如要检查启动流程但不保持运行，可在配置和依赖准备好后执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\launcher\Start-XBT.ps1 -SmokeTest
```

此检查会连接配置中的数据库并运行正常的建表逻辑，不等同于真实账号登录测试。

## Linux 服务器部署

`Server\xbt-server-linux-amd64` 是 Linux x64 可执行文件，不是 Windows 程序。
Linux 部署不使用 CMD/LNK；不必安装 Node 来提供已经构建好的静态网页。

1. 安装并创建自己的 PostgreSQL 数据库和账号。
2. 在服务器应用目录中复制 `launcher/config.template.yaml` 为 `config.yaml`。
3. 将所有 `CHANGE_ME_...` 换成独立随机密钥和数据库密码，并配置自己的地图服务。
4. 将 Linux 二进制改为可执行，用专门的非 root 服务用户运行。工作目录必须包含 `config.yaml`。
5. 用 systemd 管理后端，用 Nginx 提供 `Web/dist`，配置自己的域名和 HTTPS 证书。

例如在已经准备好配置的应用目录运行：

```bash
chmod +x ./xbt-server-linux-amd64
./xbt-server-linux-amd64
```

Nginx 核心路由示例（放入自己的 HTTPS server 块，并修改静态目录）：

```nginx
root /opt/xbt/Web/dist;
index index.html;
gzip on;
gzip_static on;
gzip_vary on;
gzip_comp_level 4;
gzip_types text/css application/javascript application/json image/svg+xml;
location ^~ /assets/ {
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
}
location = /index.html {
    add_header Cache-Control "no-cache";
}
location = /api/media/image {
    access_log off;
    proxy_pass http://127.0.0.1:3030;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 12s;
}
location /api/ {
    proxy_pass http://127.0.0.1:3030;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}
location / {
    try_files $uri $uri/ /index.html;
}
```

此示例不包含证书签发、DNS 或数据库安装配置，不要直接覆盖其他站点。
公共部署必须使用 HTTPS；不要把 Vite preview 作为生产公网服务器。
`gzip_static` 需要 Nginx 对应模块；没有预压缩 `.gz` 文件时由动态 gzip 提供压缩。服务器2会在发布时为 JS/CSS 生成 `.gz` 文件，减少日常请求的 CPU 开销，并在 HTTPS 监听启用 HTTP/2。带内容哈希的 `/assets/` 文件可以长期缓存，入口 HTML 需重新验证；API 不设置共享缓存，避免混用账号数据。后续发布必须同时上传全部拆分脚本，并保留上一版哈希资源，以兼容已打开的页面。
Web 页面采用按路由加载：登录首屏不会下载扫码及管理页面代码，首次进入对应页面时才加载相关脚本。

### 低资源图片与活动加载

头像和课程封面由带登录令牌的本站图片接口获取，按需加载、合并同账号同图的在途请求，
浏览器最多同时加载2张；失败显示明确的默认图像，不因单张图片401退出整个账号，
也不自动无限重试。图片 Blob 只供当前组件展示，退出或换图时释放，不建立长期内存图片库。

后端图片数据只落磁盘：总量最多200MiB（包含正在写入的预留）、单张最多2MiB、
索引最多1024项、24小时过期；全站最多2个并发回源、16个等待者及16个填充任务。
缓存键按登录 UID 与原始图片地址隔离，文件名只用摘要；不解码、缩放、压缩或转码图片。
只接受 `photo.chaoxing.com` 与 `p.ananas.chaoxing.com` 原始来源，以及经核实的
HTTPS 重定向图片 CDN `p.cldisk.com`，不开放通用 URL 代理。
回源使用学习通页面的固定 Referer 兼容 CDN 防盗链，不转发用户令牌或 Cookie；
仍校验 TLS、DNS 公网地址、重定向次数、图片类型和大小。
禁止 Nginx 记录图片接口的原始查询参数，上方精确 location 的 `access_log off` 用于此目的；
应用日志也只记录路由、状态与耗时，不记录原图地址。

配置项 `media_cache_dir` 默认 `cache/images`，相对于后端工作目录。
服务器2使用 `/var/cache/xbt/images`，目录仅应用用户可写。
使用 `ProtectSystem=strict` 的 systemd 部署，还需在该服务的 drop-in 中加入：

```ini
[Service]
CacheDirectory=xbt
CacheDirectoryMode=0700
```

配置 `media_cache_dir: "/var/cache/xbt/images"` 后执行 `systemctl daemon-reload` 并重启
自己的后端服务。磁盘缓存不是业务数据，不纳入数据库备份；如需清理，先停止该服务，
仅移除上述目录内由本应用生成的摘要图片文件，不能删除数据库、配置、其他缓存或父目录。
不需要定时清理任务；缓存读写时按需过期与淘汰。当前不提供单独关闭图片代理的开关，
回退旧版必须同时恢复已备份的后端、前端入口和对应配置，不能直接删掉正在使用的缓存目录。

活动成功响应缓存按 UID 隔离，全站合计最多1MiB JSON、64项、2秒有效期；
相同账号同时刷新合并，全站最多16个在途刷新。已鉴权的非 GET/HEAD 请求结束后清除缓存，
并阻止修改前的迟到结果重新写入。手动刷新绕过已存响应；首页原有15秒可见轮询不变，
进行中活动的教师人脸/范围设置仍回源。每次活动刷新最多并发处理2门课，
全站最多4条课程上游链路，整体最多8秒；签到写入不占这些限流槽。
冷 Session 补登录合并，不新增轮询、Redis、常驻监控或定时预加载。
刷新失败会明确提示列表可能不是最新，保留本人旧列表，不将旧列表伪装成新数据。

上述是缓存和并发预算，不是整个应用的 RSS/CPU 硬上限。系统文件页缓存可回收，
也可能计入 cgroup 内存；课程数量、上传、外部接口耗时仍会影响峰值。
图片与活动接口返回 `Server-Timing` 和缓存命中头，便于按需定位，无须常驻采样程序。

服务器2已另行部署 `xbt-monitor.timer` 邮件监控（不随此源码包自动安装）：每天北京时间 07:00 检查后端、Nginx、数据库查询、本机 API 和公网 HTTPS API。正常时检查完立即退出，不常驻；异常时在本次执行中每隔15秒重试，连续三次异常发送一封告警，下次检查确认全部恢复后发送恢复邮件，持续异常不重复通知；SMTP 失败会记录日志并在后续检查重试。服务器错过检查时间时，下次启动会补做一次。SMTP 授权只存服务器 `/etc/xbt-monitor/smtp.json`（root 所有、权限 0600），状态保存在 `/var/lib/xbt-monitor`。可通过 `systemctl status xbt-monitor.timer` 和 `journalctl -u xbt-monitor.service` 检查运行情况。此方案不提供使用时报错的即时通知；服务器关机或彻底断网时，本机监控无法发送邮件，不能替代外部监控。

## 修改源码后重新构建

后端需要满足 `Server\go.mod` 要求的 Go 工具链：

```powershell
Set-Location .\Server
go build -trimpath -ldflags="-s -w" -o xbt-server.exe .\cmd\server
```

前端使用 Node.js 24 LTS：

```powershell
Set-Location .\Web
npm ci
npm run build
```

前端 `api.base_url` 保持 `/api`，由本地 preview 或生产 Nginx 代理。

Android 是 WebView 壳，不是独立后端。发布前必须修改
`Android\app\src\main\res\values\strings.xml` 的 `target_url` 为自己的 HTTPS 域名。
debug 下还有独立的资源覆盖，应同步检查；当前源码中的回环地址是原开发测试设置。
使用 Android Studio / 相应 JDK、SDK 构建。不要把数据库密码或服务端密钥写进 Android。

## 再次分享与备份

数据库账号记录不包含在本包中。自己的数据库请另行安全备份。
首次配置后生成的 `Server\config.yaml`、运行日志以及数据库内容不能直接重新打包转发。
请转发最初收到的干净 ZIP，或重新去除敏感数据后再分发。
`SHA256SUMS.json` 记录初始包中文件摘要；首次配置、安装依赖或修改源码后可能增加或改变文件。
保留原项目许可及作者信息，许可文件见 `Android\LICENSE` 和根目录 `LICENSE`。
