
## 公共登录与管理员关闭

运营者明确允许任何人使用时，可设置 `public_access: true`。此模式不查询或写入登录白名单；
登录仍要求用户提供自己的有效学习通手机号和密码，默认赋予普通权限。若额外设置
`public_admin: true`，每个成功登录用户都会获得管理员权限；若设置 `disable_admin: true`，
管理员 API 路由完全不注册（请求返回404），即使登录令牌含管理员权限也无法调用。
这些设置默认均为 `false`，保留原有访问控制。
公网部署必须先启用 HTTPS；公开注册意味着服务器处理并加密保存用户提交的账号凭据，
并不代表匿名访问或绕过学习通服务端限制。

## 低资源图片与活动读取

### 本站图片

`GET /api/media/image?source=<URL编码后的原始地址>` 需要正常登录 JWT；
仅允许 `photo.chaoxing.com`、`p.ananas.chaoxing.com`，原 HTTP 来源升级 HTTPS。
上述来源可重定向至核实的 `p.cldisk.com`，但不能把该域名作为任意原始来源直接提交。
不转发浏览器 Cookie 或 JWT，使用固定学习通页面 Referer；仅返回 JPEG/PNG/GIF/WebP，
禁止私网地址、不安全重定向、自定义端口、用户信息、SVG/HTML 和超过2MiB的文件。
该接口不检查图片是否在当前账号数据库记录中，来源本身为公开头像/封面；
磁盘缓存键仍按登录 UID 隔离，不能将其视为私有图片业务归属鉴权。

成功响应为图片字节，不是 JSON；包含 `Cache-Control: private, max-age=3600`、
`Vary: Authorization`、`X-Content-Type-Options: nosniff`、
`X-Image-Cache: HIT|MISS` 和 `Server-Timing`。
来源非法返回400，繁忙返回429及 `Retry-After: 2`，图片回源失败返回502；
失败为既有错误 JSON，不能把错误正文当图片显示。
服务端缓存最多200MiB、1024项、24小时，包含并发写入预留；全站2个回源并发、
16个等待请求及16个填充任务，每个填充最长8秒。
文件只保存摘要命名的原始图片字节，不解码、缩放或转码；清理和目录权限见部署说明。

### 活动列表

`GET /api/sign/activities` 保持 `{code:0,message:"ok",data:[...]}` 响应形状。
活动中的 `if_get_range` 同时包含教师限定范围和新版 PPT 详情 `ifopenAddress` 的位置校验，
不把旧 `signDetail.ifGetRange=0` 当作没有位置要求。`rules_verified:true` 表示规则已用新版
详情核实；失败时保留的旧版本缓存返回 `false`，前端明确标注“规则待核实”。
规则版本仅用于活动缓存升级，不修改课程选择、个人地点或历史签到记录。
成功响应按 UID 缓存2秒，全站最多1MiB JSON和64项，相同账号在途刷新合并，
全站最多16个刷新任务；失败不缓存。请求头 `Cache-Control: no-cache` 绕过已存结果，
仍可合并同一代的在途刷新。已鉴权非 GET/HEAD 请求完成后清除结果，
旧代请求不能污染修改后的缓存。响应包含 `X-Activity-Cache: HIT|MISS|SHARED`、
`Server-Timing` 和 `Cache-Control: private, no-store`。

每次刷新最多2门课程并发，全站最多4条课程读取链路，整体最多8秒；
超时明确返回504，刷新拥挤返回429，外部活动列表失败返回502，外部登录失效返回401。
并发任务正常结束后的内部取消不视为请求超时；没有已选课程时也正常返回200及空数组。
进行中活动仍回源读取教师最新设置，不延长首页15秒轮询，也不限制签到写入并发。
客户端刷新失败保留本账号旧列表并提示“列表可能不是最新”，不展示其他账号缓存。

## 7. 签到地点接口

### 个人专用部署模式

设置 `personal_locations_only: true` 后，`GET /api/sign/locations/settings` 返回
`data.personal_only=true`，管理入口显示“我的常用地点”。`GET /api/sign/locations/personal`
始终只返回当前账号的个人地点；`GET /api/sign/locations` 在此模式下也只返回本人的地点。
个人新增、编辑和删除使用 `/api/sign/locations/personal` 及其 `/:id` 路由，归属由登录令牌确定。
新增和编辑必须显式提供数值 `latitude`（-90～90）和 `longitude`（-180～180），使用 GCJ-02；
缺失、null 或空字符串返回400，明确输入的合法零值仍允许。表单未填写坐标不会默认为0。
管理员权限不能越过个人归属限制。位置签到及扫码传入地点 ID 时，公共旧记录和其他账号的地点均被拒绝。

此模式下 `/api/admin/sign-locations` 的公共列表、保存候选、新增、编辑、删除、恢复和状态操作均返回403；
只保留只读搜索及坐标/地图预览。无创建者的旧公共记录保留在数据库但不再展示或调用，
不能推断归属，需要用户重新保存。默认 `false` 保留原公共地点管理兼容性。
添加位置没有校区参考地址时，地图直接打开全国参考视图，可搜索后明确确认坐标，不会自动保存或签到。

地点管理接口需要 `permission = 2` 管理员权限；用户地点列表只需要登录。地点状态为 `pending`、`enabled`、`disabled`。高德搜索只返回临时候选，不写库；明确保存才新增 `pending`，之后仍须显式启用才能出现在用户列表。删除为软删除，已删除记录不会出现在列表中。

### 7.1 管理员地点列表
`GET /api/admin/sign-locations?status=pending`

`status` 可选：`pending`、`enabled`、`disabled`。不传返回全部未删除记录。

### 7.2 搜索高德候选
`POST /api/admin/sign-locations/search`

```json
{"keywords":"教学楼","scope":"campus"}
```

**2026-09-25 契约调整：此接口不再自动保存。** `keywords` 为空默认“教学楼”，上限 64 个字符。
`scope` 默认为 `campus`：将已配置的 `amap.campus_address` 与建筑关键词组成文本查询，
输入已经包含完整校区文字时不重复追加。`full` 使用管理员输入的完整学校/建筑名称，不追加校区。
未知 scope 返回 400。最多查询 3 页、每页 25 条；短页提前停止，并跨页去重。
常规地点搜索保持高德顺序；地图搜索额外按名称与关键词的匹配程度稳定排序。

`campus_address` 是文字检索条件，不是城市代码或地理围栏，不能放入高德 `city` 参数。
契约依据：[高德关键字搜索官方文档](https://lbs.amap.com/api/webservice/guide/api-advanced/search)。
学校级 POI 不代表某栋楼坐标，也不保证结果位于目标校区；必须核对名称、地址及高德坐标。
Key 仅在服务端配置，不返回客户端。

响应 `data` 是候选数组（无数据库 ID 或状态；空结果为 `[]`）：

```json
[{"name":"合成教学楼","address":"合成校区地址","latitude":31.123457,"longitude":113.123457,"amap_poi_id":"synthetic-poi","source":"amap"}]
```

响应顶层新增 `query_keywords`：本次后端实际构造并发送的检索词，不包含 Key。
搜索失败时，只要查询构造有效也返回该字段，便于检查详细道路地址是否让搜索过窄。
它由客户端请求所用的同一 `QueryKeywords` 函数生成，不由前端猜测。
若校区配置是道路门牌地址，可以显式使用 `scope=full` 和完整“学校 + 校区 + 楼名”；
不自动删改配置文本，不保证高德收录校内每栋建筑。

### 7.2.0 地图中心只读搜索
`POST /api/sign/locations/search-map`
`POST /api/admin/sign-locations/search-map`

请求和响应数据结构与管理员候选搜索相同，但地图搜索会强制使用 `scope=full`，
仅按用户输入原词搜索，不附加服务端配置的 `campus_address`。最多查询 3 页、每页 25 条，
短页提前停止并跨页去重；候选优先展示名称完全匹配及包含关键词的结果，其他结果仍保留。
该接口用途仅为地图选点控件移动地图中心：
登录用户路由只要求已登录，管理员路由仍要求管理员。该接口只通过服务端高德代理返回候选，
不泄漏 Key、不写库、不创建 POI、不自动保存或启用地点。前端若只返回一个候选，可将地图中心
移动到该候选 GCJ-02 坐标；若返回多个候选，必须展示候选列表让用户明确选择，不能随机使用第一项。
无论用户签到 selectionMode 还是管理员地点登记，搜索结果都只是视图参考；仍需用户核对中心十字并明确确认。
用户签到确认仍只匹配 150 米内最近的已启用地点，不证明教师签到范围。

### 7.2.1 明确保存选中候选
`POST /api/admin/sign-locations/candidates`

请求为上述单个候选对象。名称、地址必须非空，纬度和经度必须显式提供有限数值并在合法范围内；
不能省略坐标而默认为零。服务端固定来源为 `amap`，新记录状态为 `pending`，不能在请求中直接启用。
响应 `data` 为 `{"location":{...完整已保存地点...},"created":true}`。

重复确认返回同一记录及 `created:false`，不覆盖管理员编辑过的名称/地址/坐标，不降级已有启停状态。
坐标规范到六位；并发插入命中唯一约束后使用新查询回查，不同 POI ID 的复合唯一冲突也复用记录。
已删除 POI 或相同名称/地址/坐标的已删记录仍返回 409，保存操作不自动恢复或重建。
2026-09-25 后续兼容扩展：409 的 `data` 提供结构化状态及匹配的旧记录：

```json
{"error_code":"SIGN_LOCATION_DELETED","location":{"id":123,"name":"旧名称","address":"旧地址","latitude":31,"longitude":113,"status":"disabled"}}
```

`location` 实际是完整旧地点记录（包括软删字段）；管理员匹配优先相同 POI，
否则相同名称/地址/六位坐标。前端必须同时校验 HTTP 409、`error_code` 和合法地点 ID，
不能从中文文案或任意网络错误推断“可恢复”。卡片展示旧内容及恢复入口，
重复错误只在该卡片保留一条反馈，不重复铺满 toast。
此接口仅接受管理员明确确认的数据，不会再请求高德。

### 7.2.2 显式恢复被删除的旧地点
`POST /api/admin/sign-locations/:id/restore`

```json
{"confirmed":true}
```

仅管理员可操作。有效正整数 ID 和 `confirmed=true` 必需；缺少确认返回 400，
不存在 ID 返回 404。界面必须先展示真实确认框，明确“恢复旧记录、置待确认、
保留旧内容、不自动启用”，取消不发写请求。

事务内锁定目标旧记录，仅清除其 `deleted_at`、将 `status` 改为 `pending`
（正常更新 `updated_at`），保留 ID、来源、POI、名称、地址、坐标及创建时间。
响应 `data` 仍为 `{location,created,restored}`，首次恢复 `restored=true`；
已恢复/原本未删除则 `restored=false` 且不更改其当前启用/停用状态。
同一旧 ID 的并发恢复最多一次执行状态转换。

如果旧 POI 或复合身份已被其他未删除地点占用，返回 409 和
`data.error_code=SIGN_LOCATION_CONFLICT`；事务回滚，旧记录仍保持删除，
不会删除/覆盖现存地点，也不偷偷恢复其他 ID。不存在返回
`SIGN_LOCATION_NOT_FOUND`，其余恢复失败返回 `SIGN_LOCATION_RESTORE_FAILED`。
恢复后页面定位该旧 ID，管理员仍须核对内容并另行明确启用。

Web 新搜索替换临时区，不改变已保存列表。保存后切换管理区到“全部”、定位并高亮对应 ID，
候选区显示“已保存”或“已存在”及查看入口；不能将搜索结果的数量当新增数据库行数。

### 7.3 手动创建地点
`POST /api/admin/sign-locations`

```json
{"name":"第一教学楼","address":"江淮校区","latitude":32.1,"longitude":114.1}
```

创建结果默认为 `pending`；坐标必须满足纬度 `[-90,90]`、经度 `[-180,180]`。不能通过创建接口直接启用。

坐标统一为 GCJ-02。`source` 白名单为 `manual`、`device_gps`、`map_pick`；
省略、未知值或直接传 `amap` 都归为 `manual`。后两种采集来源强制清空
`amap_poi_id`，不接受客户端指定 POI 归属。旧 `manual` 输入的 POI 兼容行为保留；
真正高德候选仍应走 `/candidates`，不能靠创建接口伪造高德来源。
管理员必须手填名称和地址；采集坐标不会推断楼名、自动保存或自动启用。

### 7.4 编辑、启用、停用和删除
- `PUT /api/admin/sign-locations/:id`：更新 `name`、`address`、`latitude`、`longitude`。
- `POST /api/admin/sign-locations/:id/enable`：显式启用地点。
- `POST /api/admin/sign-locations/:id/disable`：停用地点。
- `DELETE /api/admin/sign-locations/:id`：软删除地点。

路径 ID 必须为正整数。地点不存在、已删除或参数不合法时返回失败响应。
编辑时显式传 `source=device_gps` 或 `map_pick` 表示重新采集点位：
同时清空旧 POI 并重置为 `pending`，即使原记录已启用也需要重新确认。
不传来源的旧编辑请求保持原状态/来源；显式 `manual` 表示人工调整坐标来源。

### 7.4.1 浏览器定位的只读坐标预览
`POST /api/admin/sign-locations/coordinate-preview`

```json
{"latitude":39.915,"longitude":116.404,"accuracy":51,"captured_at":"2026-09-25T06:00:00Z"}
```

这是公开转换测试样例，不是实际设备或教学楼。四个字段必填，输入为 WGS-84，
精度为非负米数、时间为 RFC3339。服务端近似转换为 GCJ-02，响应 `data`：
`{point:{latitude,longitude},coordinate_system:"GCJ-02",converted,accuracy,captured_at,poor_accuracy,warning}`。
坐标保留六位；精度大于50米时 `poor_accuracy=true`，仍可人工命名后登记为待确认。
算法适用范围外保持原点并返回 `converted=false`，需要人工核对。
该无数据库依赖的处理器不写库，不请求高德，不记录位置正文。
坐标转换参考公开样例：[coordtransform](https://github.com/wandergis/coordtransform)；
近似转换和设备报告精度都不能证明点位于老师设定的签到范围内。

前端仅在用户点击后调用浏览器 Geolocation，要求安全上下文、high accuracy、
10秒超时和 `maximumAge=0`；权限拒绝、不可用和超时显示一条可恢复的表单内错误。
用户点击“使用定位点”才填入表单，仍须独立点击保存。

### 7.4.2 静态地图中心预览
`POST /api/admin/sign-locations/map-preview`

```json
{"center":{"latitude":39.916404,"longitude":116.410244},"zoom":16,"direction":"east","meters":100}
```

`center` 是 GCJ-02，提供时经纬度必须完整；`zoom` 为1–17。
可选平移 `direction=north/south/east/west` 和 `meters` 1–1000，使用服务端球面距离公式
计算新中心，不使用浏览器像素猜算经纬度。响应 `data`：
`{center,zoom,coordinate_system:"GCJ-02",image_data:"data:image/png;base64,...",campus_reference}`。
其中 `center` 与请求上游静态图的六位中心完全一致。
缺少/null中心时，仅将配置的校园文字地理编码为视图参考；非唯一结果失败，不猜地点。
已知中心每次只发静态图请求；首次校区参考最多地理编码+静态图各一次，总请求期限10秒。

浏览器仅请求本项目接口；服务端访问官方高德 HTTPS，禁跟随重定向、限制响应4MB，
只接受600×400图片并解码重新PNG编码，不返回上游URL、Key或原始错误。
失败为502安全中文说明，不返回伪地图。前端固定十字、显示服务端中心、方向距离和缩放；
每次新预览清除确认，图片加载成功且管理员勾选已核对楼栋后才能“使用中心点”。
初始校区中心不是楼栋，不自动填表或保存。地图本身不提供签到范围证明。
两种预览均为管理员接口，未登录401、非管理员403，`Cache-Control: no-store`。
正式用户主动打开地图会使用已有服务端高德配额；开发验收使用本机HTTP桩/页面受控响应，
不新增前端Key，不请求真实高德，不执行任何签到。

### 7.4.3 登录用户位置签到页的只读预览

新增等价路由，复用上述处理器：

- `POST /api/sign/locations/coordinate-preview`
- `POST /api/sign/locations/map-preview`

只要求登录，未登录仍401；普通用户可预览，但没有增加任何管理列表/搜索/创建/
编辑/启用/恢复权限，管理员原路由仍要求admin。两种用户预览均不写数据库，
坐标格式、精度、静态图净化、超时和Key保护规则与管理员预览相同。

`sign_type=4` 的“选择签到位置”列表顶部提供现场定位，点击后才采集，
由后端转换GCJ-02后对已启用地点按球面距离近到远排序，显示距离，不自动选择。
只有最近地点实际距离不超过150米才提供“使用最近地点”；更远时说明无附近启用地点，
保留手动点选原列表。距离比较使用未四舍五入的米数，不用显示文案判断。

并列的“打开地图选择位置”使用相同静态图/中心十字；“回到目前位置”必须重新采集
并成功转换后才能更新中心，拒绝/失败只显示行内原因，不把校区参考点当当前位置。
每次移动或缩放清除确认。签到页地图确认后直接将地图中心作为本次签到点，
不查询附近已启用地点、不创建地点；关闭选点窗口后的迟到响应不会再改变已选点。
列表中的手动选点仍要求选择启用地点。
签到页与管理员地点新增/编辑的坐标采集均使用高德 JavaScript API 2.0 交互地图，
平移与缩放由地图 SDK 连续渲染，固定中心十字对应实时地图中心。地点搜索只移动
地图中心并需人工核对；管理员确认后坐标仅填入表单，仍需手填名称/地址并明确保存。

交互地图配置接口 `GET /api/sign/locations/map-config` 只允许登录用户调用，
返回浏览器可见的 JS API Key 及限时代理路径；它不会返回安全密钥。
部署时需在 Server 配置中分别填写 `amap.js_api_key`（Web端 JS API Key）
与 `amap.security_js_code`。JS API Key 本来会出现在浏览器网络请求中，应在高德控制台
配置实际 Web 来源白名单；安全密钥只保留在 Server 配置，由
`GET /api/amap-service/:grant/*path` 固定转发至官方 `webapi.amap.com` /
`restapi.amap.com` HTTPS 端点并注入，不允许客户端指定上游主机或方法。
代理使用短时随机授权、每授权请求数上限、10秒超时及8MB响应上限，并拦截可能回显凭据的响应。
不要将安全密钥放进前端、APK、日志或源码仓库。该地图配置与既有 `amap.api_key`
（Web Service Key）相互独立，不能互换。

列表手动执行仍使用顶层 `location_id`，其坐标和描述由服务端取库存记录覆盖客户端值。
明确确认的地图点位使用 `location_mode:"map_pick"` 和顶层 `map_location`；
该模式只用于位置签到，要求 GCJ-02 的合法经纬度，并使用确认的物理位置，不匹配附近地点。
网站内部与地点存储保持 GCJ-02；XXT 客户端仅在提交边界将带坐标系标记的 GCJ-02 转为 BD-09。
该适配同时覆盖现场定位、常用地点和携带常用地点的二维码签到，不改数据库原值。
已标记 BD-09 的内部参数不重复转换，未标记的旧直接调用参数保留原有透传行为。
地点 ID 解析后会移除旧 `special_params.location`，避免它覆盖经过归属校验的数据库点位。
接口成功仍只表示学习通返回接受状态，不包含其最终地图落点回读。
可选服务器配置 `sign_location_offset: {latitude: -0.000093, longitude: 0.000027}`
表示在提交边界先对 GCJ-02 加上述角度差，再转 BD-09；默认两项为零，不启用。
此偏移影响所有用户后续携带网站地点的签到，但不改变地图预览、坐标保存或已存在签到记录。
提交时使用偏移后的 GCJ-02 通过高德逆地理编码获取完整地址，加“中国”前缀后作为学习通
`address`（扫码为 `location.address` / `mockData.description`），不包含地图选点或偏移调试文字。
反查超时、失败或无地址时，返回失败且不提交学习通；坐标仍按原规则转 BD-09。
地址用词取决于高德数据，不保证与学习通原生地址逐字相同，也不控制其结果页布局。
两种地点来源不可混用；不能用 `special_params` 的坐标或嵌套ID替代这两种契约。

2026-09-25 新增的“一键现场定位并签到”是受限的例外：前端先通过
`/sign/locations/coordinate-preview` 将本次浏览器 WGS-84 定位转换为 GCJ-02，
随后在 `/sign/execute` 明确提交 `location_mode:"device_gps"` 与完整
`device_location`。该模式不能同时带 `location_id`，也不读取、创建、启用或匹配地点记录：

```json
{
  "activity_id": 123,
  "target_uid": 456,
  "sign_type": 4,
  "course_id": 789,
  "class_id": 101,
  "location_mode": "device_gps",
  "device_location": {
    "latitude": 39.916404,
    "longitude": 116.410244,
    "accuracy": 20,
    "captured_at": "2026-09-25T06:00:00Z",
    "coordinate_system": "GCJ-02"
  },
  "special_params": {}
}
```

服务端要求坐标、精度和采集时间完整；纬经度必须是有限合法值，精度必须为非负有限值，
时间必须为 RFC3339，且坐标系只能是已经转换的 `GCJ-02`。服务端忽略此模式中所有
`special_params`，只用本次 `device_location` 生成上游位置参数；地址描述会明确标注为
“浏览器现场定位”及坐标/精度，绝不伪造楼栋或可信设备证明。该请求仍不保证满足教师
签到范围或上游一定签到成功。精度大于 50 米时前端会警告，但会把实际精度一并提交。
非位置签到不得传入上述模式或设备坐标。

签到页地图取点使用另一明确模式 `location_mode:"map_pick"`，由用户在地图上确认中心十字后，
前端将回显的 GCJ-02 中心作为本次签到坐标，不查找或匹配附近的数据库地点：

```json
{
  "activity_id": 123,
  "target_uid": 456,
  "sign_type": 4,
  "course_id": 789,
  "class_id": 101,
  "location_mode": "map_pick",
  "map_location": {
    "latitude": 39.916404,
    "longitude": 116.410244,
    "coordinate_system": "GCJ-02"
  },
  "special_params": {}
}
```

该模式不接受 `location_id`、`device_location` 或非位置签到类型。后端校验坐标范围并直接
以地图确认坐标构造上游参数；描述明确标注为“地图选择点”，不代表已启用地点或教师签到范围。
请求不会新建或修改地点记录，也不保证上游签到成功。
手动选择列表只使用本项目已启用地点；地图点位与一键现场定位直接使用明确提交的本次坐标。
上述任何方式都不能证明教师设定的签到范围或真实签到结果。

### 7.5 用户启用地点列表
`GET /api/sign/locations`

返回未删除且 `status = enabled` 的公共地点，以及当前登录用户自己的个人地点。个人地点以登录令牌中的学习通 UID 作为所有者；管理员地点接口不会列出个人地点。列表手动选择签到应提交 `location_id`，不能以客户端坐标覆盖服务端保存的地点坐标；一键现场定位使用 7.4.3 所述 `device_gps` 契约，地图确认点使用 `map_pick` 契约，两者均直接使用本次坐标且不依赖此列表。

个人常用地点接口需要登录，不要求管理员权限：

- `POST /api/sign/locations/personal`：创建个人地点，JSON 字段为 `name`、`address`、`latitude`、`longitude`。
- `PUT /api/sign/locations/personal/:id`：仅更新当前用户自己的地点。
- `DELETE /api/sign/locations/personal/:id`：仅软删除当前用户自己的地点。

个人地点只对所属 UID 返回和开放签到使用；尝试读取或修改其他用户的地点会返回未找到。不同用户可以保存相同坐标和名称。

手动选择地点时，`POST /api/sign/execute` 的 `location_id` 必须是请求 JSON 的**顶层正整数**，不是 `special_params.location_id`：

```json
{
  "activity_id": 123,
  "target_uid": 456,
  "sign_type": 4,
  "course_id": 789,
  "class_id": 101,
  "location_id": 1,
  "special_params": {}
}
```

这是请求形状示例，不能直接对真实活动执行。地点停用或删除后，签到结果为 `success=false` / `message="签到地点不可用"`；实际坐标始终由 Server 从启用地点记录读取。二维码签到（`sign_type: 2`）也可选提交 `location_id`：Server 校验地点属于当前操作用户或为公共启用地点，使用数据库坐标覆盖客户端坐标，并保留 `enc`、`c`。省略地点时二维码原有无位置行为不变；其他类型保持原有参数契约。

### 7.6 配置文件批量导入与部署

在 Server 配置中可选添加 `sign_locations` 列表，每项包含 `name`、`address`、`latitude`、`longitude`，并可填写 `amap_poi_id`；导入时 `source` 始终为 `config`，省略 `status` 默认为 `pending`，显式状态必须是 `pending`、`enabled` 或 `disabled`。只有已人工核实的地点才能在配置中显式标为 `enabled`。格式示例见 `locations.example.yaml`。示例坐标是占位值，未经核实不得用于真实教学楼。

服务启动时会先校验全部条目，再以 POI ID 或（没有 POI ID 时）六位小数经纬度幂等导入。重复启动不会新增重复记录；已有 `manual`/`amap` 记录，以及已经被管理员编辑、启用或停用的记录不会被配置覆盖。无 POI ID 的配置项修改名称、地址不改变导入身份，修改坐标则会被视为新地点。候选仍须管理员确认后才能启用。

### 7.7 真实 PostgreSQL 隔离回归

持久化测试：`internal\db\sign_location_integration_test.go`。测试只接受本机、数据库名以 `xbt_sign_location_test` 开头的 PostgreSQL URL；每次运行创建独立 schema，在结束时删除自己创建的 schema。未设置 `XBT_TEST_POSTGRES_DSN` 时明确跳过，不代表集成验证通过。不要把生产连接信息传给测试。

使用已安装的 PostgreSQL 工具在**新建的临时目录**初始化集群，只绑定 `127.0.0.1`，选择空闲端口；创建专用测试数据库后，通过环境变量传入该实例的 URL（不要打印连接配置）。在 Server 目录执行：

```powershell
go test ./internal/db -run TestPostgresSignLocations -count=3 -v
go test ./... -count=1
```

覆盖完整 AutoMigrate 与重复启动、地点索引/状态约束、配置幂等及管理员修改保护、连续只读搜索、明确保存幂等及删除保护、软删除和启用状态过滤、服务端坐标覆盖，以及有/无 POI ID 两组 64 路并发保存。并发测试通过屏障强制触发每组 63 次真实 PostgreSQL `23505` 冲突，要求全部请求返回同一记录。新增32路恢复+32路保存的混合并发、旧ID/管理员字段保留、启停幂等、恢复唯一冲突回滚和非法ID检查。全部 POI 均为测试桩，不调用高德或学习通。测试完成后仅停止、清理本次临时实例，不能停止生产 PostgreSQL。

高德候选搜索前，在后端配置 `amap.api_key`；校区关键词模式还须配置 `amap.campus_address`。Key 只保留在受限 Server 配置，不要提交到 Web 或 Android。管理员先搜索，再明确保存，核实后才调用启用接口。部署时保留永久目录 `C:\Users\user\AppData\Local\XBT` 的数据、密钥及原配置；只按授权备份和更新具体程序/入口，不能清空或覆盖整个目录。
