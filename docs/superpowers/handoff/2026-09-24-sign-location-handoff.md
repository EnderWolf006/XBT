# XBT 签到地点功能交接文档

更新时间：2026-09-25 15:32（UTC+8，位置签到页定位排序与地图匹配已发布，见第 20 节；第 16～19 节为前次发布历史）

**当前正式部署：新版 Server/Web 已通过原桌面快捷管理器上线，正式地址仍为 `http://127.0.0.1:38081`；程序和依赖已迁入永久 release/runtime，原数据库及配置保留。高德 Key 按后续明确授权仅保存在受限后端配置，实际加载通过，本轮没有新高德请求。独立演示环境已正常停止，数据保留。Android 尚无手机可达的正式 URL，不生成或安装误导的正式 APK；既有系统 ANR 阻塞结论不变。**

**当前正式 release 为 `20260925-1510`：位置签到列表增加现场定位，按距离排序已启用地点，不自动选择；并列地图入口含“回到目前位置”，确认只匹配150米内最近启用地点。执行仍只提交location_id，不创建地点或提交任意坐标。管理员原采集/地图/搜索恢复保持。有头隔离套件17/17、真实PG及构建通过；七表指纹、54条地点历史、完整配置及lnk保持。真实设备定位和本轮真实高德未验证，不证明教师签到范围或签到成功。**

**搜索仍只展示本次候选，明确保存/恢复才写库，已删记录显式确认后保留旧内容恢复为pending。原搜索、恢复和行内错误修复保持。13:35另一次用户授权的6次高德只读查询仅确认校区主POI，没有确认该校区具体教学楼，详见会话脱敏证据；不等于所有楼栋可检索。此次定位/地图开发额外真实高德请求为0。**

**第五轮结论（历史）：持久统一设备入口已落地，Web 10 项回归、辅助 8 项回归和 Android 9 项重跑通过；但统一 Android 设备回归仍未完整通过。** 最后单轮在真实 WebView 连接后，被模拟器系统的 `System UI isn't responding` 原生弹窗遮挡，界面可见性断言失败，未跳过断言继续。已修复进度文案依赖退出动画、进程树与日志流清理判据；该轮测试资源已清理，当时未替换部署。

**第四轮结果（历史）：已修复 Android 无相机初始化崩溃及释放生命周期，9 项单测通过，构建通过，lint 为 0 errors / 37 warnings。真实设备 WebView 已取得无相机提示、地点操作和旧页面释放的分层证据；统一脚本没有单次全绿，不称为全套 E2E 通过。用户授权的真实高德只读查询成功（仅 1 次、3 个 POI），当时 Key 未持久保存。真实外部签到仍缺指定账号/活动，未执行。** 当时 APK 哈希与完整边界见第 14 节；该轮没有替换现有部署。

**第三轮结论（历史，后续修复见第 14 节）：真实高德当时缺 Key、真实签到缺授权账号/指定活动，均未执行；原 APK 已在自建模拟器中安装并启动，但实际 WebView 地点流程未验收通过。** 当时发现无可用相机时的未捕获异常崩溃，正常合成相机环境下自动化卡在 WebView 连接。第 13 节保留失败现场，不能作为第四轮最新状态。

**第二轮已验证结果：Web lint 0 errors / 0 warnings，8 项真实浏览器回归通过，Go 全量/真实 PostgreSQL 集成及 Server/Web 构建通过；Android 已从公开上游固定提交恢复，Debug APK 构建、1 项既有样例单测及 lint 通过（0 errors / 37 条上游 warnings）。** 第二轮额外修复了 Web `location_id` 请求层级错位。当时新代码、Web 产物和 APK **均未部署/安装**，真实高德与真机验证未进行。第 12 节为第二轮结果；第 7 节及第 8～11 节保留第一轮历史，不能把其中“46 errors / Android 缺失”当作当前状态。

## 1. 项目与数据边界

- 源码工作目录：`C:\Users\user\AppData\Local\Temp\XBT-Deploy`
- 当前正式程序目录：`C:\Users\user\AppData\Local\XBT\releases\20260925-1510`
- Go 后端：`C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server`
- React Web：`C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web`
- Android：`C:\Users\user\AppData\Local\Temp\XBT-Deploy\Android`（第二轮已从公开上游固定提交恢复，详见第 12 节）
- 永久账号数据、数据库配置、密钥、日志和备份：`C:\Users\user\AppData\Local\XBT`
- 部署地址：`http://127.0.0.1:38081`
- 后端健康检查：`http://127.0.0.1:3030/api/health`
- PostgreSQL：`127.0.0.1:5432`

**重要：后续替换代码时不得删除、清空或覆盖 `C:\Users\user\AppData\Local\XBT`。**

当前 `XBT-Deploy`、`Server`、`Web` 目录均未发现可用 Git 仓库，因此本次没有 commit。

## 2. 已完成的功能范围

已按设计实现签到地点管理和位置签到坐标选择：

1. 后端新增 `SignLocation` 模型和数据库 schema。
2. 高德 POI 后端客户端，API Key 只由 Server 使用。
3. 管理员签到地点 API：列表、搜索候选、新增、编辑、启用、停用、软删除。
4. 用户地点 API：`GET /api/sign/locations`。
5. 位置签到请求通过 `location_id` 解析服务端保存的坐标。
6. Web 用户端从后端加载地点并选择地点签到。
7. Web 管理端增加签到地点管理页面。
8. 配置文件地点导入和运行文档。
9. 第一轮 Android 源码目录缺失；第二轮已恢复公开的 WebView + CameraX 壳，地点业务共享 Web，无须另造原生地点 API/UI。构建与设备验证状态见第 12 节。

## 3. 设计与实现文档

设计文档：

```text
C:\Users\user\AppData\Local\Temp\XBT-Deploy\docs\superpowers\specs\2026-09-23-sign-location-design.md
```

实现计划：

```text
C:\Users\user\AppData\Local\Temp\XBT-Deploy\docs\superpowers\plans\2026-09-23-sign-location.md
```

## 4. 主要后端文件

### 数据模型与配置

- `Server/internal/model/models.go`
  - 新增 `SignLocation`。
  - 状态常量：`pending`、`enabled`、`disabled`。
  - 使用 GORM `DeletedAt` 软删除。

- `Server/internal/config/config.go`
  - 新增 `AMapConfig`。
  - 新增可选 `sign_locations` 配置列表。
  - `MaskedDSN()` 已支持 key-value DSN、`postgres://`、`postgresql://`、带引号/转义引号密码脱敏。

- `Server/internal/db/db.go`
  - 注册 `SignLocation` 的 `AutoMigrate`。
  - 启动时补齐 PostgreSQL partial unique index、复合坐标唯一索引和状态 CHECK 约束。

- `Server/init.sql`
  - 新增 `sign_locations` 表。
  - `amap_poi_id` 唯一索引排除 `NULL`、空字符串和软删除记录。
  - 增加名称、地址、六位坐标复合唯一索引。

### 高德客户端

- `Server/internal/amap/client.go`
- `Server/internal/amap/client_test.go`

主要行为：

- `Client.SearchPOI(ctx, keywords)`。
- 后端调用高德 POI text search。
- 支持注入 HTTP client，测试不访问真实网络。
- 解析 `longitude,latitude`。
- 校验经纬度范围。
- 过滤 malformed location。
- 按 POI ID 或名称/地址/坐标去重并稳定排序。
- 网络错误不会把包含 API Key 的 URL通过错误信息返回。

### 地点 Service/API

- `Server/internal/service/sign_location.go`
- `Server/internal/handler/sign_location.go`
- `Server/cmd/server/main.go`
- `Server/API.md`

接口：

```text
GET    /api/admin/sign-locations
POST   /api/admin/sign-locations/search
POST   /api/admin/sign-locations
PUT    /api/admin/sign-locations/:id
POST   /api/admin/sign-locations/:id/enable
POST   /api/admin/sign-locations/:id/disable
DELETE /api/admin/sign-locations/:id
GET    /api/sign/locations
```

规则：

- 管理接口使用 `Auth + AdminOnly`。
- 用户接口只返回 enabled 且未软删除地点。
- 候选搜索结果默认 `pending`。
- 手动新增强制 `pending`、`source=manual`。
- 高德候选强制 `pending`、`source=amap`。
- 删除使用软删除。
- 唯一冲突转换为业务冲突并返回 HTTP 409。
- 输入错误 400，找不到 404，数据库错误 500。
- 缺少 `name/address` 的高德候选会跳过。
- 坐标统一归一化到 6 位小数。

### 位置签到坐标映射

- `Server/internal/dto/types.go`
- `Server/internal/handler/sign.go`
- `Server/internal/service/sign.go`
- `Server/internal/service/sign_location_mapping_test.go`

位置签到 `sign_type=4`：

- 必须传正数 `location_id`。
- 只能使用 enabled 且未软删除地点。
- 后端从数据库注入 `latitude`、`longitude`、`description`。
- 客户端传入的坐标字段会被覆盖，不能伪造最终坐标。
- 非位置签到不要求 `location_id`，原有流程保持兼容。

## 5. 主要 Web 文件

### Web 用户签到

- `Web/src/types/index.ts`
- `Web/src/pages/SignDetail.tsx`
- `Web/src/components/sign/LocationInput.tsx`

行为：

- 位置签到时请求 `/sign/locations`。
- 地点弹窗支持 loading、empty、error 和“重新加载”。
- 用户选择 `selectedLocation`。
- 位置签到提交顶层地点 ID，不再把 ID 放进 `special_params`（第二轮真实浏览器验证发现并修复此契约错位）：

```ts
location_id: activity.sign_type === 4 ? selectedLocation?.id : undefined,
special_params
```

- 不再使用固定 `LOCATION_PRESETS`、`lat`、`lng`、`locationStr`。
- Web 构建产物未发现 `api_key` 或 `restapi.amap.com`。

### Web 管理后台

- `Web/src/pages/SignLocations.tsx`
- `Web/src/components/ProtectedRoute.tsx`
- `Web/src/App.tsx`
- `Web/src/pages/Lobby.tsx`

行为：

- 路由：`/admin/sign-locations`。
- 新增 `AdminRoute`，未登录跳转 `/login`，非管理员跳转 `/`。
- 管理员入口位于 Lobby 顶部，只有 `permission >= 2` 可见。
- 支持全部、待确认、已启用、已停用筛选。
- 默认搜索关键词“教学楼”，支持自定义关键词。
- 搜索关键词超过 64 个字符时拒绝请求。
- 搜索期间按钮进入 loading，避免重复提交。
- 支持手动新增、编辑、明确启用、停用和软删除。
- 删除前要求确认。
- 每次变更后刷新列表。
- 支持名称、地址、纬度、经度校验。

### Lobby 缓存修复

`Web/src/pages/Lobby.tsx` 的活动缓存 JSON 解析已增加 `try/catch`，损坏缓存会清理并回退为空数组。

## 6. 配置导入

相关文件：

- `Server/internal/service/sign_location_import.go`
- `Server/internal/service/sign_location_import_test.go`
- `Server/internal/config/config_import_test.go`
- `Server/locations.example.yaml`
- `Server/config_example.yaml`
- `Server/cmd/server/main.go`

配置导入规则：

- 启动时导入 `sign_locations`。
- 默认状态为 `pending`。
- 来源强制为 `config`。
- 有 `amap_poi_id` 时按 POI ID 幂等。
- 无 POI ID 时按归一化后的六位 `latitude + longitude` 幂等。
- 已有记录只复用，不覆盖 manual/amap 或管理员修改的数据。
- `locations.example.yaml` 只包含占位坐标，明确要求管理员确认，不能直接当作真实教学楼坐标。

高德配置示例：

```yaml
amap:
  api_key: ""
  campus_address: "河南省信阳市罗山县龙池大道236号"
```

真实 API Key 只能放在 Server 配置或永久配置中，不得放到 Web 或 Android 包内。

## 7. 原交接验证记录（历史，不作为本次运行证据）

### Server

已执行：

```powershell
cmd /c "cd /d C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server && go test ./... && go build ./cmd/server"
```

结果：

- `go test ./...` 通过。
- `go build ./cmd/server` 未输出错误，命令成功完成。
- `internal/amap`、`internal/config`、`internal/handler`、`internal/service` 等包均通过。

之前还执行并通过：

```powershell
go test ./internal/amap -v
go test ./internal/service ./internal/handler -v
go test ./internal/service -run ConfiguredSignLocation -v
go test ./...
```

### Web

已执行：

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web
npm run build
```

结果：

- `tsc -b` 通过。
- `vite build` 通过。
- 只有 bundle size warning，不影响构建成功。

### Web 敏感配置扫描

已执行构建产物扫描：

```powershell
$dist='C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\dist'
Select-String -Path "$dist\assets\*.js" -Pattern 'api_key|restapi.amap.com' -CaseSensitive:$false
```

结果：

```text
No AMap key/endpoint strings found in Web dist JS
```

### Android

检查结果：

```text
Test-Path C:\Users\user\AppData\Local\Temp\XBT-Deploy\Android
False
```

当前部署目录没有 Android 源码，无法执行 Android 编译或客户端 UI 验证。后端接口已保留给未来 Android 客户端使用。

### 永久数据目录

本次没有执行任何删除、清空或覆盖 `C:\Users\user\AppData\Local\XBT` 的操作。

## 8. 第一轮验证记录（2026-09-24 15:02～15:14，UTC+8）

### 8.1 Web lint：已实际运行，尚未全绿

首次 `npm run lint`：退出码 1，47 errors / 14 warnings。修复 `SignDetail.tsx:181` 地点加载异常捕获的 `any`，改为 `unknown` 推断和 `instanceof Error` 收窄，保留错误提示行为。

最终再次执行原始 `npm run lint`：退出码 1，**46 errors / 14 warnings**。没有语法错误、遗留固定坐标引用或地点状态未使用错误。以下独立地点页面、组件及路由的集中 lint 退出码为 0：

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web
npm run lint
npx --no-install eslint src\pages\SignLocations.tsx src\components\sign\LocationInput.tsx src\components\ProtectedRoute.tsx src\App.tsx
```

完整剩余分类如下，未顺带重构旧代码：

| 文件（相对 Web） | errors | warnings |
|---|---:|---:|
| `src\api\client.ts` | 1 | 0 |
| `src\components\sign\GestureInput.tsx` | 2 | 0 |
| `src\pages\Courses.tsx` | 3 | 2 |
| `src\pages\FullPhoto.tsx` | 5 | 5 |
| `src\pages\FullScanner.tsx` | 17 | 5 |
| `src\pages\Lobby.tsx` | 2 | 1 |
| `src\pages\Login.tsx` | 1 | 0 |
| `src\pages\SignDetail.tsx` | 8 | 1 |
| `src\pages\Whitelist.tsx` | 4 | 0 |
| `src\store\auth.ts` | 1 | 0 |
| `src\types\index.ts` | 1 | 0 |
| `src\yaml.d.ts` | 1 | 0 |
| **合计** | **46** | **14** |

共享文件具体范围：`SignDetail.tsx` 第 207、299、304、360、368、380、407、435 行为同学加载、通用签到/照片请求、通用参数和错误处理的 `no-explicit-any`；214 行为同学状态加载的 hooks 依赖警告。`Lobby.tsx` 的 64、136、146 行属于动画、活动加载及 hooks 依赖；`types\index.ts:89` 为旧 `SignParams.special_params` 类型。其他文件均不属于新增地点功能。此分类依据当前代码职责和原交接记录；由于没有 Git 基线，不能逐行证明全部剩余问题的历史引入时间，也不声称共享文件整体 lint 通过。

### 8.2 真实 PostgreSQL：完成，不是模拟数据库替代

使用已安装的 PostgreSQL **18.6**，没有安装工具、修改系统服务或使用生产连接凭据连接数据库。独立集群位于本会话 artifacts 的 `sign-location-validation\pgdata`，只监听 `127.0.0.1:55432`；专用数据库名为 `xbt_sign_location_test`。生产 `5432` 完全未连接、未迁移、未写入、未重启。

新增持久化回归文件：`Server\internal\db\sign_location_integration_test.go`。通过 `XBT_TEST_POSTGRES_DSN` 显式传入临时实例 URL，不输出连接配置。测试检查本机地址和测试数据库名前缀，再为每轮创建独立 `sign_location_it_*` schema；结束关闭连接并删除自己的 schema。变量缺失会显式 SKIP，不计为真实集成成功。

本次临时实例命令如下；`$artifacts` 见 8.3，`pgdata` 必须是本次新建且不存在的目录，端口必须空闲。`trust` 仅用于此回环监听、无真实数据、运行后销毁的测试集群，不得应用于生产。前台 `postgres.exe` 在独立受控进程运行，其余命令在另一进程执行：

```powershell
$pg = 'C:\Program Files\PostgreSQL\18\bin'
& "$pg\initdb.exe" -D "$artifacts\pgdata" -U postgres -A trust --encoding=UTF8 --no-locale
& "$pg\postgres.exe" -D "$artifacts\pgdata" -h 127.0.0.1 -p 55432
# 以下在另一个 PowerShell 进程执行，连接的只是新建测试集群。
& "$pg\createdb.exe" -h 127.0.0.1 -p 55432 -U postgres xbt_sign_location_test
# 将此临时实例 URL 放入 XBT_TEST_POSTGRES_DSN，再执行 8.3 的 Go 测试，不输出 URL。
# 停止仅本次临时实例：
& "$pg\pg_ctl.exe" -D "$artifacts\pgdata" stop -m fast -w
```

覆盖并通过：

- `db.New` 中全部 7 张表的 `AutoMigrate`，以及再次启动时的重复迁移。
- `ensureSignLocationSchema` 的两个唯一索引及非法状态 `23514` CHECK 拒绝；空 POI、多地点、软删除后重新创建。
- 配置首次/重复导入、六位坐标幂等、POI 身份下管理员改名/坐标/启用后不被覆盖、manual/amap 来源保护、非法批次无部分写入。
- 有 POI 和无 POI 两组各 **64 路并发**，测试屏障保证所有请求先查不到记录，再同时创建；每组精确捕获 **63 次 PostgreSQL `23505` 唯一冲突**，最终所有请求返回同一待确认记录，数据库只保留 1 条。
- 不同 POI ID 命中相同名称/地址/坐标的复合唯一冲突，重复搜索保留管理员启用状态。
- 已启用地点列表过滤，以及位置映射覆盖客户端伪造坐标；pending、disabled、软删除地点被拒绝。只调用本地 service，不执行真实签到。

首次运行真实复现两处缺陷并失败，修复后 `go test ./internal/db -run TestPostgresSignLocations -count=3 -v` 连续三轮通过：

| 轮次 | 有 POI：请求/冲突/记录 | 无 POI：请求/冲突/记录 | 整轮耗时 |
|---|---|---|---:|
| 1 | 64 / 63 / 1，全成功 | 64 / 63 / 1，全成功 | 12.38s |
| 2 | 64 / 63 / 1，全成功 | 64 / 63 / 1，全成功 | 15.59s |
| 3 | 64 / 63 / 1，全成功 | 64 / 63 / 1，全成功 | 19.83s |

随后全量 `go test ./... -count=1` 同样设置测试连接变量，集成包再次真实运行通过（15.676s），没有用缓存或 SKIP 代替。全部 POI 搜索均为固定测试桩，不调用高德。

### 8.3 Go / Web 构建及敏感配置扫描

本次输出到隔离 artifacts，**没有覆盖现有 `Server\server.exe`、`xbt-server.exe` 或 `Web\dist`**：

```powershell
$artifacts = 'C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files\sign-location-validation'
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server
# XBT_TEST_POSTGRES_DSN 已通过当前进程环境设置为独立临时实例，禁止使用生产连接。
go test ./internal/db -run TestPostgresSignLocations -count=3 -v
go test ./... -count=1
go build -o "$artifacts\xbt-server-validation.exe" ./cmd/server
Set-Location ..\Web
npm run build -- --outDir "$artifacts\web-dist"
```

Go 全量测试和 Server 构建退出码均为 0。Web `tsc -b` / Vite 构建退出码 0，2238 个模块；仅有大于 500 kB 的 chunk 警告，以及外部 outDir 不自动清空提示。没有使用 `--emptyOutDir`。

用 Node 对新 `web-dist` **全部 5 个文件**进行扫描：`api_key`、高德后端地址、PostgreSQL URL/字段、JWT/凭据字段、私钥标识均无命中；同时仅在内存读取部署目录现有 Server 配置，将非空敏感值及 JSON 转义形式与产物比较，无命中。未输出配置值、账号、DSN 或密钥。此为静态匹配扫描，不等同于全面安全审计。

### 8.4 Android：确切阻塞

本次重新确认 `Test-Path .\Android` 为 False，项目范围搜索 `*.gradle`、`*.kts`、`*.kt`、`*.java` 无结果。没有 Android 源码，无法接入地点列表/UI、提交 `location_id` 或执行 Android 构建/真机验证。没有伪造 Android 完成记录。

## 9. 本次缺陷修复与文件改动

| 文件 | 本次变更 |
|---|---|
| `Server\internal\service\sign_location.go` | `SearchCandidates` 每次回查新建 GORM 查询并清空目标结构，避免复用首次查询的 `ErrRecordNotFound`；唯一冲突时先按 POI 回查，未找到再按复合地点身份回查，找不到则保留业务冲突，不伪造成功。 |
| `Server\internal\db\sign_location_integration_test.go` | 新增可重复执行的真实 PostgreSQL 集成回归；两处已复现缺陷均有持久化测试。 |
| `Web\src\pages\SignDetail.tsx` | 仅修复地点加载 catch 的 `any`，保留其他旧逻辑。 |
| `Server\API.md` | 说明并发冲突复用、独立数据库测试运行方式；更正配置导入按无 POI 六位坐标识别、显式状态实际生效的文档描述。 |
| 本交接文档 | 更新本次运行结果、准确分类、清理边界及剩余事项，保留历史记录。 |

未初始化 Git、未提交；未改动依赖、生产配置或永久目录。构建工具会更新自己的本地缓存；构建产物及测试输出仅存放在会话 artifacts。

## 10. 运行状态和清理

本次开始及结束都只读访问现有部署：

- `http://127.0.0.1:3030/api/health`：HTTP 200、code 0、service `xbt2-server`。
- `http://127.0.0.1:38081/api/health`：同上；Web 根页面 HTTP 200 / HTML。
- 结束核查时现有 Server PID 2620、Web PID 21856、生产 PostgreSQL PID 21660 与开始一致，未重启它们。

另启动新构建的独立 Server，使用本会话生成的纯测试配置及临时数据库，只监听 `127.0.0.1:33030`：

- `/api/health` 返回 HTTP 200 / code 0。
- 未认证 GET `/api/sign/locations` 和 `/api/admin/sign-locations` 均返回 HTTP 401。
- 独立 Server 启动时导入 1 条合成 pending/config 地点；此记录仅在临时数据库。
- 集成测试结束后检查 `sign_location_it_*` schema 数量为 0。

已仅停止本次独立 Server（PID 25764），使用精确临时数据路径 `pg_ctl ... stop -m fast -w` 停止临时 PostgreSQL（PID 5080）。结束时 33030 / 55432 无监听，3030 / 38081 / 5432 原服务仍在。

临时 `pgdata` 与纯测试 `config.yaml` 在实例停止后清理；保留新构建产物和 `postgres-first.txt`、`postgres-fixed.txt`、`go-test-final.txt`、`eslint-final.json`、`lint-final.txt` 作为本次证据。**没有删除、清空、覆盖或修改 `C:\Users\user\AppData\Local\XBT`。**

## 11. 第一轮结论与剩余事项（后续已更新）

以下为第一轮结束时的结论；第二轮用户进一步授权清理全部 lint、浏览器回归及 Android 恢复，最新状态见第 12 节。

原交接的真实 PostgreSQL 验证缺口已补齐，并通过集成复现修复了单元测试未发现的候选冲突缺陷；本次 Go 测试/构建、Web 构建、静态敏感配置扫描及独立实例健康验证均有新鲜成功结果。

仍不能声称“全部交付完成”：

1. 全量 Web lint 仍为 46 errors / 14 warnings；本轮只修地点功能问题，未授权扩大为旧代码清理。
2. Android 必须取得源码后才能实施；当前没有可安全继续的本地操作。
3. 新代码和隔离构建产物**未部署到现有运行服务**；健康接口只能证明现有部署可响应，不能证明其运行新修复。生产迁移、替换或重启须另获许可。
4. 未使用真实高德 Key 搜索、未登录真实账号或执行真实签到/外部写入；也未进行浏览器人工端到端操作或 Android 真机验证。模拟 POI + 真实 PostgreSQL 的通过结果不冒充真实外部服务验证。

## 12. 第二轮：全量 Web lint、隔离浏览器回归、Android 恢复

### 12.1 新授权与边界

用户明确要求先完成其他事项、不要替换新部署；本轮获授权修复全部剩余 lint，并恢复已核实公开上游 Android。仍未替换现有 Web dist/Server 二进制、重启现有服务、修改生产库或永久目录；不安装 APK、不使用真实账号或执行学习通写操作。

### 12.2 Web 根因修复

`npm run lint -- --max-warnings=0` 已退出 0，全部 **0 errors / 0 warnings**，没有关闭规则、添加 eslint-disable、降低门槛或使用 any/双重断言逃逸。

- `utils\errors.ts` 统一通过类型守卫提取错误信息与取消状态，供登录、课程、活动、白名单、地点、签到页面使用。
- 补全通用签到结果/参数、YAML 配置、摄像头列表、原生照片回调和浏览器 BarcodeDetector/zoom/focus 扩展类型。
- 手势路径直接由受控 `value` 派生，不再 effect 中复制/清空状态；保留跳点补齐与至少 4 点规则。
- 活动加载用稳定回调及 ref 控制并发，不把 loading 状态作为回调依赖形成请求循环；课程加载/自动同步依赖完整，并等待刷新完成。
- 刷新图标动画通过 ref 与 requestAnimationFrame 同步 DOM，不为复位触发同步 effect setState。
- 相机镜头和预览回调依赖稳定；照片对象 URL 在退出时从最新 ref 清理，Web 摄像头流在切换/退出时停止。
- 扫码回调用 React 19 `useEffectEvent` 获取最新状态，不因状态重渲染反复启动摄像头；真实异常分支保留日志，不用空 catch 隐藏错误。

### 12.3 浏览器实际发现的额外契约缺陷

第一次可运行的浏览器回归发现：Web 提交 `special_params.location_id`，但 Go `dto.SignExecuteRequest.LocationID` 只绑定顶层 `location_id`。因此虽然类型检查、单元测试均可通过，真实位置请求仍返回“请选择有效的签到地点”。

现已修复 `SignDetail.tsx` 为顶层 `location_id`，位置请求 `special_params={}`，不携带客户端坐标；其他签到类型不新增地点要求。持久化浏览器测试验证选中地点的请求形状，且停用/删除后由真实 Server 返回“签到地点不可用”，不能通过只拦截成功响应掩盖问题。`Server\API.md` 同步补充正确 JSON 示例。

### 12.4 持久化隔离 E2E 运行器

新增 `Web\e2e\run-isolated.mjs`、`Web\e2e\sign-locations.spec.ts`、`Web\playwright.config.ts`，增加必要的 `@playwright/test` 开发依赖及锁文件，使用机器已有 Edge，不下载新的浏览器。

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web
npm run lint -- --max-warnings=0
npx tsc --noEmit --target ES2023 --module ESNext --moduleResolution bundler --lib ES2023,DOM --types node --skipLibCheck e2e\sign-locations.spec.ts playwright.config.ts
$env:XBT_E2E_ARTIFACTS = 'C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files'
npm run test:e2e
```

运行器每次新建 `web-e2e-*` artifacts 子目录，先检查端口空闲，再启动独立 PostgreSQL 55432、独立新 Server 33030 和隔离静态 Web/网关 33081。Server 配置与 JWT 密钥为每轮新生成，只有合成账号及故意无效的凭据密文。网关只允许地点、健康、同学列表及本地签到检查/执行等已审查接口，禁止外部登录、课程同步、照片上传等入口；合成活动/课程列表由浏览器测试返回。正常地点操作真实经过 Server 和 PostgreSQL；`sign/execute` 的停用/删除拒绝在查地点阶段完成，其他回归请求也因无效合成密文在外部调用之前被拒绝，绝不声称完成真实签到。

每次运行都执行未缓存 `go test ./... -count=1`（含真实 PostgreSQL 集成）、隔离 Server 构建及隔离 `npm run build -- --outDir ...`，扫描新构建产物敏感字段及临时后端密钥/连接。退出时关闭自己的 Web 网关、Server，精确路径停止自己的 PostgreSQL，清理临时数据库与配置；保留构建、日志及失败截图。没有复用第一轮成功作为新鲜证据。

已通过的浏览器场景：

1. 管理员真实新增、六位坐标、编辑、状态筛选、明确启用、停用、删除取消及确认软删除；缺失高德 Key 时错误提示。
2. 普通用户管理路由跳转及管理 API 403。
3. 用户无地点提示、必选校验、加载失败与重新加载。
4. 用户选择只发送顶层地点 ID；选择后被停用及软删除，由真实后端拒绝。
5. 活动首次加载、课程空列表仅自动同步一次、保存选择，无请求循环。
6. 手势短路径重置、跳点自动补齐和非位置请求参数保持兼容。
7. 原生相机桥切换、拍照重渲染不重启、退出撤销对象 URL；覆盖 Promise 返回及 Android 实际 void + `xbt-native-photo` 事件协议。
8. 原生扫码事件使用最新 React 回调，进度重渲染不重启相机，关闭进度可取消流程；使用合成二维码及无效合成凭据，在外部调用之前拒绝。

第一次运行器采用同步子进程阻塞了同进程网关事件循环，未形成有效页面验证，已改为异步子进程并确认 finally 清理；此失败没有被算作成功。之后浏览器发现顶层地点契约缺陷并完成修复。最新最终命令结果见本节后续结果记录。

### 12.5 Android 来源、资源及兼容性

公开仓库 <https://github.com/EnderWolf006/XBT>，固定提交 `fb15ac0f1a19a2e7b5e238b1eeb15d4056df96fc`。已仅恢复缺失的 Android 目录，保留 GPL v3 原文为 `Android\LICENSE`，来源及本地差异写入 `Android\UPSTREAM.md`。没有覆盖本地 Server/Web。上游根 LICENSE 与 README 中 Private 徽章描述不一致，不能把此前本地缺失误写为未开源。

`MainActivity.kt` 从 `R.string.target_url` 加载 WebView，启用 JavaScript/DOM storage，桥接 CameraX 拍照/扫码；没有独立 Kotlin 地点列表或签到请求实现。共享 Web 的地点选择及顶层 ID 修复即是其业务兼容实现；新 Web 尚未部署，因此不能声称现有安装客户端已得到新功能。

上游 `strings.xml` 被 `.gitignore` 排除，但 `strings_example.xml` 在 res 目录内实际参与编译并含示例外部域名。已将示例移到 `Android\config`，新增 main 资源默认 `about:blank`，仅 debug 资源使用模拟器到宿主的 `http://10.0.2.2:33081/`。这不是生产配置，真机不能直接照用。

本机发现已有 JDK 21、`D:\Android\Sdk` 平台 36、构建工具及 Gradle 8.13 缓存；不能再把“常规 C 盘路径不存在”当作 SDK 缺失。实际完成的构建命令及结果如下，没有自动安装 SDK 或接受许可证。

### 12.6 最终新鲜命令结果

**Web / Go（最终串行运行，退出码 0）：**

- `npm run lint -- --max-warnings=0`：0 errors / 0 warnings。
- E2E spec 与 Playwright 配置的独立 `tsc --noEmit ...`：通过；应用 `tsc -b` 由构建同时执行通过。
- `go test ./... -count=1`：所有包通过；真实 PostgreSQL 集成包耗时 **15.307s**。并发测试仍严格断言有/无 POI 两组各 64 路、各 63 次真实唯一冲突、各 1 条记录，没有降低断言或增大原 90 秒总体限时。
- 隔离 `go build -o ... ./cmd/server`：通过；`npm run build -- --outDir ...`：通过，2239 模块、Vite 1m 6s，只有大 chunk 和外部 outDir 不自动清空提示。
- 新构建产物敏感字段、后端地址及本次临时密钥/数据库连接扫描：无命中。
- **Playwright 8 passed（45.0s）**，实际启动系统 Edge；覆盖 12.4 的全部八项。

最终证据目录：

```text
C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files\web-e2e-1nNAQh
```

其中 `commands.log` 保存 Go/构建/临时数据库输出，`browser-tests.log` 保存 8 项浏览器成功结果，`web-dist` 和 `server-e2e.exe` 为隔离构建产物。此前 7 项通过记录不是最后这轮 8 项的替代。

并行 Android 构建期间的 `web-e2e-CoWZWN` 运行曾在集成测试 90 秒总限时上失败，尚未进入浏览器；该失败保留，不计为通过。Android 结束后串行完整重跑获得上述全部成功结果，未靠修改并发断言绕过失败。

**Android：**

第一次离线运行因缓存缺少声明的 AGP 8.13.2 插件而失败，不是 SDK 或源码缺失。确认官方 Google Maven 可达后，按原项目依赖版本正常解析缺失依赖；未降级插件、未修改系统代理或仓库配置、未下载大 SDK、未接受许可证。联网运行完成编译/打包/单元测试，但 lint 报 1 error / 37 warnings：`ImageProxy.image` 使用 CameraX 实验 API 未显式 opt-in。

仅在 `MainActivity.kt` 的 `analyzeQrFrame` 上补充：

```kotlin
@androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
```

这是局部 API 契约声明，不是禁用 lint。再次执行：

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Android
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
.\gradlew.bat --offline --no-daemon --max-workers=2 -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

最终 **BUILD SUCCESSFUL（4m 32s，退出码 0）**。日志出现一次 Kotlin 编译 daemon 启动重试，工具恢复后完成构建；不把该瞬时日志当最终构建失败或隐去最终退出码。

- `assembleDebug`：生成 APK；没有构建生产 release 或安装到设备。
- `testDebugUnitTest`：现有 `ExampleUnitTest` **1 test / 0 failures / 0 errors / 0 skipped**，只是上游样例测试，不代表原生地点业务或 CameraX 真机测试覆盖。
- `lintDebug`：XML 报告 **0 errors / 37 warnings**。保留上游 WebView API 可用性、Insets/旧 API、依赖版本、图标、未使用资源、ABI 等告警；未扩大为清理全部 Android 告警，也未生成 baseline 或关闭规则。
- `aapt2 dump resources` 核对实际 APK 的 `target_url` 为 debug 的 `http://10.0.2.2:33081/`，不含示例外部域名、高德后端地址、数据库/JWT/凭据配置标识。此资源匹配扫描不等于完整二进制安全审计。

APK 绝对路径（第二轮当时的产物；第四轮已在此路径生成新 APK，当前哈希见第 14.3 节，不能继续使用下面的旧哈希校验当前文件）：

```text
C:\Users\user\AppData\Local\Temp\XBT-Deploy\Android\app\build\outputs\apk\debug\app-debug.apk
```

大小：19,319,627 bytes。SHA256：

```text
A36A321980CC11C3D213DE2AC22A26035A3B3C26B6012D8C332CE49D460AF210
```

Android XML/HTML 报告位于 `Android\app\build\test-results\testDebugUnitTest` 与 `Android\app\build\reports\lint-results-debug.*`；本次离线首次、联网、最终离线命令记录分别为会话 artifacts 中 `android-build-offline.txt`、`android-build-online.txt`、`android-build-final.txt`。

### 12.7 清理、现有部署及剩余边界

16:19 最终检查：

- 所有六轮 `web-e2e-*` 目录中的临时 `pgdata` 和 `config.yaml` 均已删除；33030、33081、55432 均无监听。仅保留验证日志、构建和失败证据。
- 临时上游 Git 稀疏检出已清理；项目 Android 源码、固定提交来源记录和 GPL 原文均保留。
- 原 Server / Web / PostgreSQL 仍为 PID **2620 / 21856 / 21660**；3030 和 38081 的健康接口均 HTTP 200 / code 0。
- 现有部署文件写入时间早于本轮：`Server\server.exe` 为 14:46:48，`Server\xbt-server.exe` 为 2026-09-22 11:07，`Web\dist\index.html` 及 assets 为 14:47:47。本轮构建全部另存 artifacts，没有执行替换。
- 未删除、清空、覆盖或修改 `C:\Users\user\AppData\Local\XBT`，未连接生产数据库；没有停止其他用户的服务或全局 Gradle daemon。

仍未完成/未授权的事项仅限：真实高德 Key 搜索（本轮隔离配置故意为空，不读取永久凭据）、真实外部签到、Android 设备/模拟器安装与真机验证、生产部署、release 目标配置及签名。不能把桌面 Edge 的桥协议模拟当作 CameraX 设备验证。主资源默认 `about:blank`、debug 指向隔离宿主地址，均不是可直接发布的生产地址。

### 12.8 第二轮文件清单

- Web 原有源码：`src\api\client.ts`、`src\components\sign\GestureInput.tsx`、`src\pages\Courses.tsx`、`FullPhoto.tsx`、`FullScanner.tsx`、`Lobby.tsx`、`Login.tsx`、`SignDetail.tsx`、`SignLocations.tsx`、`Whitelist.tsx`、`src\store\auth.ts`、`src\types\index.ts`、`src\yaml.d.ts`。
- Web 新增/工具：`src\utils\errors.ts`、`src\browser.d.ts`、`e2e\run-isolated.mjs`、`e2e\sign-locations.spec.ts`、`playwright.config.ts`，以及 `package.json` / `package-lock.json` 的必要测试依赖和命令。
- Android：恢复上游目录和 LICENSE；新增 `UPSTREAM.md`、main/debug 安全地址资源；将资源目录中的示例移至 `config`；`MainActivity.kt` 仅增加上述 CameraX 局部 opt-in。
- 文档：`Server\API.md`、本交接文档、原设计及实现计划，所有有效示例统一顶层 `location_id`；嵌套写法只作为错误历史说明保留。
- 保留第一轮 Server 并发修复与持久化 PostgreSQL 回归；第二轮没有修改生产 Server 配置或重写后端业务。

## 13. 第三轮：真实高德条件与隔离 Android 设备验证

本节保留第三轮失败记录；相机修复、新 APK、后续设备分层证据及新授权高德查询见第 14 节。

### 13.1 高德及外部签到边界

用户要求验证真实高德、真实外部签到和 Android 设备运行，但继续禁止替换部署、改生产库或读取永久目录凭据。

2026-09-24 16:25 的临时 Go 探针仅在内存解析项目 `Server\config.yaml` 的 `amap` 配置，结果为：

```json
{"key_configured":false,"campus_configured":true,"requests":0,"result":"missing_project_amap_configuration"}
```

因此真实高德查询仍被**项目配置缺少 Key**阻塞，没有调用无 Key API 冒充验证，没有打印校区地址或其他配置。脱敏证据为会话 artifacts 中 `amap-live-readonly.json`；临时探针源码已删除。没有搜索或读取永久 `XBT` 目录秘密文件。

真实外部签到没有获得授权测试账号和指定活动，仍明确阻塞。不能从现有账号中选择、不能使用活跃活动碰运气，也没有向真实服务执行签到或上传照片。设备测试继续只使用独立库的合成账号与故意无效密文；设备模式网关额外禁止 `/api/sign/` 下除 `locations` 外的所有入口，`sign/execute` 不转发给后端。

### 13.2 实际设备、首次安装及环境发现

- `adb devices -l` 初始无任何连接设备。已有工具为 ADB 36.0.2、Emulator 36.3.10、WHPX；已有 AVD 为 `Medium_Phone_API_36.1`，镜像 Android 36.1 / x86_64，无需下载。
- 原 AVD 注册中的绝对路径失效，但当前用户目录中实际配置存在。仅复制该配置到会话 `android-device-probe\avd\XBTProbe.avd` 并创建自己的注册，未复制原用户数据、SD 卡或快照。所有设置改动仅作用于这个临时副本。
- 以 `-read-only -no-snapshot-load -no-snapshot-save -no-window -no-audio` 启动 `emulator-5556`，没有 `wipe-data`、真实账号或物理摄像头输入。首次冷启动较慢，第一次 180 秒等待超时；根据系统已进入包管理/Launcher 的实际启动进展，再次有限等待后 `sys.boot_completed=1`、`Service package: found`。
- 实际设备 ABI 为 `x86_64,arm64-v8a`。确认同包原先不存在后，以 `adb -s emulator-5556 install --no-streaming ...\app-debug.apk` 安装**第二轮原 arm64 APK**，返回 `Success`，`pm path` 确认包存在。SHA256 仍为第 12.6 节值，没有修改 release/debug ABI 或重新构建 APK。ABI 列表支持翻译与“APK 已实际安装”是两项独立证据。
- 初始 Google Play 服务反复 ANR，`dumpsys activity exit-info` 确认 XBT 首次因 `DEPENDENCY DIED` 被系统终止。仅在可丢弃副本停用 GMS；没有修改原 AVD 的服务设置。
- 第一次测试脚本把启动期间 `pidof` 的正常未出现状态当作错误，已改为明确识别空结果的有限轮询；其他 ADB 错误仍失败。桌面 `connectOverCDP` 不适配 WebView 的 `Browser.setDownloadBehavior`，已改为现有 Playwright Android 专用 API、`omitDriverInstall: true`，不安装额外驱动 APK。

**真实兼容问题，不能隐藏：** 为避免物理相机读取，首次使用 `-camera-back none -camera-front none`，但系统镜像仍声明相机硬件特性。原 APK 在 `NativeCameraPunchController` 初始化时直接调用 `providerFuture.get()`（`MainActivity.kt:148`），未处理 `ExecutionException / CameraUnavailableException`，在没有可用相机时使主线程崩溃。仅安装成功、存在过 WebView socket 都不能算设备流程通过。脱敏堆栈保存在 `android-device-probe\camera-unavailable-redacted.txt`。

父会话已批准仅在临时副本使用 `emulated` 合成前后相机、停用该副本 GMS，做一次有明确启动期限的替代验证。它不是 `webcam`，没有读取物理环境；不以这一环境调整宣称“无相机崩溃已修复”。正常虚拟相机验证的最终结果和清理在后续小节记录。

### 13.3 最后一次设备尝试：安装/启动有证据，地点流程未通过

替代实例实际启动参数为：

```text
emulator.exe -avd XBTProbe -read-only -no-snapshot-load -no-snapshot-save -no-window -no-audio -no-boot-anim -camera-back emulated -camera-front emulated -memory 2048 -cores 2 -gpu swiftshader -port 5556
```

`ANDROID_AVD_HOME` 仅在该启动进程指向会话内临时 `android-device-probe\avd`。八分钟启动等待到期时 `sys.boot_completed` 仍为空，但包管理、AMS 和屏幕服务已经就绪、`dumpsys media.camera` 报告 **2 个相机**。记录这次超时，不将其算作按期启动成功。

父会话允许最后一次有限的安装/应用/WebView 尝试，不再追加冷启动等待或重建。原 APK 再次返回 `install Success`；其后读取到 **`sys.boot_completed=1`、应用 PID**。`am start -W` 自身曾返回 `Status: timeout`，因此不能仅因进程存在而宣称 Activity 完整验收成功。

最后一次自动化使用既有 Playwright 的 Android 专用 API（不安装 driver APK），但最终失败：

```text
androidDevice.webView: Timeout 60000ms exceeded while waiting for event "webview"
```

代码已经观察到原生 WebView 调试 socket，仍未能建立可执行地点断言的连接；连接/发现失败根因尚未完全确定，不能直接归咎于 APK 或宣称正常合成相机环境仍因同一原因崩溃。**本轮没有取得实际 WebView 地点页面、地点选择截图或管理员 CRUD 通过证据，没有验证到设备端 403 断言。** 上一轮桌面 Edge 的 8 项通过不能替代此项。

最后一次为避免重建，复用了 `web-e2e-gM8lrb` 已成功构建的隔离 Server/Web；新建独立 PostgreSQL 和合成账号，仍不连接生产。自动化子进程配置 120 秒上限；外层在 180 秒观察窗结束时仍未退出，随后停止本次测试与模拟器进程树，没有继续重试。实际产物目录：

```text
C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files\web-e2e-iTfx7E
```

`android-tests.log` 是失败证据，不是通过报告。前三次准备目录为 `web-e2e-vRl4Bm`、`web-e2e-YSCGyN`、`web-e2e-gM8lrb`，保留各自失败。`gM8lrb` 中未缓存 Go 全量测试通过（真实 PostgreSQL 集成包 **30.304s**），Server/Web 构建完成（2239 模块，Vite **5.67s**）；这些基础结果不能抵消随后设备自动化的失败。最后复用轮没有重新运行 Go/构建，不能称为该轮新鲜构建成功。

新增的设备实验模式没有通过端到端验收，**已从项目回归入口撤出**，恢复原有 `Web\e2e\run-isolated.mjs`，避免将未验证的设备模式交付为可用功能。两份尝试脚本仅作为诊断快照保留在会话 `android-device-probe` 下：

- `android-device-attempt.mjs`
- `android-run-isolated-attempt.mjs`

这些快照依赖原项目上下文，不是可直接运行的独立工具。项目当前 `npm run test:e2e` 仍是原有桌面浏览器隔离回归，不含本轮失败的设备实验。撤出后重新执行 `npm run lint -- --max-warnings=0` 和 `node --check e2e\run-isolated.mjs`，退出码均 0。

### 13.4 清理、未变更边界与续做条件

17:29 最后核查：

- 自建模拟器和测试进程树已停止；ADB 设备列表与转发列表为空，33030、33081、55432、5556、5557 均无监听。没有停止原有生产服务，也没有执行全局 `adb kill-server`。
- 所有 **10 个**本会话 `web-e2e-*` 目录的 `pgdata` 和临时 `config.yaml` 均不存在；本轮整个自建 `android-device-probe\avd` 数据/配置目录已删除，仅保留日志、合成配置快照和失败诊断脚本。项目内临时高德探针空目录亦已移除。
- 原生产 PID 仍为 3030→2620、38081→21856、5432→21660；两处健康接口仍 HTTP 200 / code 0。原 Server 可执行文件和 `Web\dist` 写入时间保持第 12.7 节记录。
- 原 AVD 注册/配置最后写入为 **2026-02-10**，原用户数据镜像/覆盖层为 **2026-02-10 / 2026-02-20**，均早于本轮；没有改写原 AVD、用户盘或快照。没有读取原设备私人内容。
- 原 APK 未修改，SHA256 仍为 `A36A321980CC11C3D213DE2AC22A26035A3B3C26B6012D8C332CE49D460AF210`；没有修改 ABI、release 配置、部署或永久 `XBT` 目录。本轮只更新本交接与 `Android\UPSTREAM.md`，设备脚本实验已撤出项目。

第三轮结束时的续做条件（第四轮已完成其中的相机修复及新授权高德查询）：

1. 真实高德：提供合法可用的项目高德 Web 服务 Key，才可做已授权的一次只读查询；不通过永久目录凭据寻找替代。
2. 真实签到：用户明确指定授权测试账号、活动和写入范围后再进行；当前仍未执行。
3. Android：继续排查真实 WebView 的发现/连接路径，或选择稳定的授权设备重新跑地点流程；需要新的续做授权，不能把本轮安装/启动证据当验收通过。物理真机、扫码/拍照和真实外部签到均未验证。
4. 保留兼容缺陷：无可用 CameraX 相机时 `providerFuture.get()` 异常未处理导致应用崩溃。本轮未修复它，也没有用有相机环境替代该缺陷的结论；后续宜做局部初始化失败处理及无相机回归，不扩大为通用相机重构。

## 14. 第四轮：Android 相机根因修复、设备分层验证与真实高德

### 14.1 实际修复范围

本轮没有将已定位的崩溃继续仅列待办，也没有修改 release 地址、ABI、生产配置或 Web 业务源码。

- 新增 `CameraInitialization.kt`，在实际 CameraX 完成监听器中处理 `ExecutionException`、`CancellationException` 和 `InterruptedException`，保留线程中断标志。未知编程错误不普遍吞掉。失败日志保留原因，界面收到明确中文提示。
- `MainActivity.kt` 的初始化错误显示为可关闭的原生提示：“相机不可用……扫码和拍照暂不可用，其他功能仍可使用。”它不替换 WebView，也不把相机失败伪装成相机就绪。
- 保留前置镜头不可用时回退后置的行为；没有可用镜头、已知 CameraX 绑定异常、未就绪拍照和拍照失败均明确报告，不再使用该处宽泛 `runCatching` 或空照片错误回调。
- 原 `onDestroy()` 从未接入视图释放流程，现通过 `AndroidView.onRelease` 调用：先关闭初始化状态，再取消本控制器待绑定任务、解绑、移除 JS 桥、关闭扫码器/执行器，最后销毁 WebView。没有取消应用共享的 `ProcessCameraProvider` Future。
- 晚到的初始化成功/失败、扫码结果、相机状态和照片不会再发布到已释放的 WebView。非相机的地点业务仍由原 Web 实现承担，没有新增独立 Kotlin 地点 API。

### 14.2 持久化回归：新增 8 项，共 9 项通过

`Android\app\src\test\java\com\github\enderwolf006\xbt\CameraInitializationTest.kt` 的 8 项均实际执行通过，不是只有上游 `2 + 2` 样例：

| 测试 | 验证点 |
|---|---|
| `successfulInitializationDeliversProviderWithoutError` | 正常 Future 交付 provider，不产生错误 |
| `failedFutureDoesNotEscapeAndPublishesVisibleActionableError` | 失败 Future 不抛出到调用线程，保留原始原因并发布明确中文提示 |
| `cancelledFutureReportsUnavailableInsteadOfPretendingReady` | 取消不伪装成功，不绑定相机 |
| `interruptionIsPreservedAndReported` | 中断标志保留，同时报告不可用 |
| `closingIgnoresLateCompletionWithoutCancellingSharedFuture` | 关闭后不读取/交付晚结果，不取消共享 Future |
| `closingDuringCompletionPreventsLateReadyCallback` | 取值期间发生关闭，也不会触发晚成功回调 |
| `failureAfterCloseDoesNotUpdateVisibleState` | 关闭后的失败不更新已销毁界面 |
| `unexpectedProgrammingErrorsAreNotSwallowed` | 非预期编程错误保持可见，不宽泛吞异常 |

加上原 `ExampleUnitTest` 1 项，总计 **9 tests / 0 failures / 0 errors**。这些 JVM 测试验证初始化与关闭策略；实际原生错误提示可见性另有下面的设备证据，不把 JVM 回调断言冒充屏幕验收。

### 14.3 实际构建、lint 与当前 APK

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Android
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
.\gradlew.bat --offline --no-daemon --max-workers=2 -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

最终 **BUILD SUCCESSFUL，4m 16s，退出码 0**；52 tasks，18 executed、34 up-to-date。第一次编译因错误提示 UI 被插入非 Composable 绘制回调而失败，已修正插入位置后完整重新执行，不把首次失败算成功。

Android lint XML 为 **0 errors / 37 warnings**，没有新增 baseline 或关闭规则。保留原 `arm64-v8a`、applicationId、版本号和 release 默认 `about:blank`；debug 仍是 `http://10.0.2.2:33081/`，不是可直接发布的生产地址。`aapt2` 核对资源及 ABI，后端敏感配置标识匹配数为 0；这不是完整二进制安全审计。

当前 APK：

```text
C:\Users\user\AppData\Local\Temp\XBT-Deploy\Android\app\build\outputs\apk\debug\app-debug.apk
```

大小 **19,325,469 bytes**，SHA256：

```text
D4229899C6469FEF60A14BD5D57C1F86266E2E57F096F3214662EE29D03F69D5
```

第 12～13 节的 `A36A...AF210` 仅对应修复前 APK。旧 APK 单独保存在会话 `android-camera-fix\before-camera-fix.apk`，没有覆盖生产安装。最终命令记录为 `android-camera-fix\build-tests-lint.txt`，首次编译失败另存 `build-initial-failed.txt`；XML/HTML 报告仍位于 `Android\app\build`。

### 14.4 同一受控设备的分层实测

仅创建一次 `XBTCameraFix` 临时 AVD，使用已有 Android 36.1 镜像和独立空白数据。启动为只读、不加载/保存快照、无音频、前后相机均 `none`，故障注入条件明确为 **cameraCount=0**。没有宿主 webcam、原 AVD 用户数据或物理设备输入。为减轻前轮软件渲染冷启动负载，临时副本使用 4 核、3072 MB、720×1280、宿主 GPU 且禁 Vulkan；设置不写原 AVD。仅该副本停用 GMS。

有界启动/安装脚本记录约 **205.641s**，`boot_completed=1`、ABI 为 `x86_64,arm64-v8a`，当前新 APK 安装成功。期间没有重启/重建模拟器；后续夹具修正始终在同一实例上继续。

| 层次 | 实际结果与证据 |
|---|---|
| DevTools 连接 | 显式转发当前应用的 `webview_devtools_remote_<pid>`，核对 `/json/version`、`/json/list` 后，用公开选项 `connectOverCDP(..., { noDefaults: true })` 成功连接真实 WebView。该选项跳过此前不支持的默认下载管理命令，没有修改 Playwright 依赖。 |
| 无相机错误 | 原生桥报告中文相机不可用；UIAutomator 和实际整屏截图确认提示及“其他功能仍可使用”可见、可关闭，WebView 继续运行。最终 crash buffer 未发现 XBT 致命异常，应用仍存活。 |
| 地点功能 | `web-e2e-7hoBqO` 的设备脚本已通过管理员新增、编辑、筛选、启用、六位坐标、用户选择、停用后不可选、删除和刷新断言。对应 API 操作是真实隔离 PostgreSQL / Server，不是地点响应 mock。 |
| 请求边界 | 抓取设备请求确认顶层 `location_id`、空 `special_params`，隔离网关实际返回 HTTP 403。请求没有转发给 Server 的执行入口，更没有到真实签到服务。活动、空同学列表及预检结果由浏览器合成；这些不是外部平台联调。 |
| 释放/新建 Activity | 独立 `release-check.mjs` 退出码 **0**，确认原桥存在、随后旧 WebView 收到 close 事件且 `isClosed()` 为 true。使用 `0x10008000`，即 `NEW_TASK | CLEAR_TASK`，含义为结束旧 Activity/任务并建立新 Activity，不是旋转屏幕等配置变化的 recreate。 |
| 释放后的回调 | 代码已接入 `onRelease → onDestroy → initialization.close`，共享 Future 所有权、晚成功、晚失败由第 14.2 节持久化单测覆盖。本轮设备直接观察到的是旧 WebView 销毁，没有伪称采集到了独立 controller 释放日志。 |

重要：**统一设备自动化脚本没有单次全绿，不能将上述分层事实改写为全套 Android E2E 通过。** `7hoBqO` 在地点断言之后因不受支持的 `--activity-new-task` 参数失败；查验 `am help` 后，独立脚本以正确 flags 完成释放断言。另一次 `l27QzC` 已观察到请求/403，但页面错误文案等待超时。这些失败仍保留，不删除以制造全绿结果。

过程中还修正/记录了夹具问题：`initdb` 的 45 秒上限过短；写入合成 localStorage 后只跳 hash 不会重新初始化 Zustand，因此需 reload；严格网关会阻断预检，故只在浏览器模拟合成预检/空同学数据，而不是开放外部签到。遇到过模拟器系统自身的 System UI ANR 弹窗，点一次 Wait 后重新读到真实错误提示。没有将这些环境/夹具问题归为已修复的产品缺陷。

设备证据根目录：

```text
C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files
```

- `android-camera-fix\boot-install.json`、`activity-release.json`、`caught-camera-errors.txt`：安装、旧页面释放、已捕获错误。
- `web-e2e-Q9JL1S\test-results\camera-error-native.png`：实际中文非阻断提示。
- `web-e2e-7hoBqO\test-results\android-location-selection.png`：真实 WebView 已选择合成地点；已查看确认不含 token、真实账号或真实校区数据。
- `web-e2e-7hoBqO\test-results\android-webview.png` / `android-screen.png`：删除后的页面/整屏证据。整屏截图仍可见原生确认对话框外壳，不能据此声称完整原生对话框呈现已通过；地点层依据为 WebView 状态及 API 断言。
- 相关失败轮 `e0Pc5U`、`HUJz7p`、`Q9JL1S`、`67eBT0`、`7hoBqO`、`l27QzC` 的命令/自动化日志保留。诊断脚本保存在会话 `android-camera-fix`，未将非全绿实验加入项目默认回归入口。

### 14.5 新授权的一次真实高德只读查询

用户提供运行时 Key 后，18:29:43 仅通过现有后端 `AMap.SearchPOI` 客户端请求官方 HTTPS `/v3/place/text` **1 次**：关键词“教学楼”，使用既有 `campus_address`，第 1 页、页大小 3，附加 `citylimit=true`；禁止重定向和额外请求。没有改高德账号权限、白名单或生产配置。

| 脱敏字段 | 实际值 |
|---|---|
| HTTP | 200 |
| 高德业务 status / infocode / info | `1` / `10000` / `OK` |
| 原始返回 POI | 3 |
| 原始坐标可解析且范围合法 | 3 |
| 后端归一化结果 | 3 |
| 过滤数量 | 0 |
| 归一化坐标有效 | true |

**这些结果仅说明本次 API 和坐标解析有效，不代表已人工核实 3 个 POI 均位于目标校区，更不代表可以直接启用。** 未输出或保存地点名称、地址和坐标，没有把 POI 写入数据库、启用地点或触发签到。

敏感值只从已接收授权消息进入本地内存，再通过子进程标准输入传递；没有在命令参数中写字面值，没有写项目/永久配置或生成的源码、日志、截图和报告，也不输出完整请求 URL/异常原文。项目配置仍不保存该 Key，不能把本次验证当作生产服务已经配置好高德。相关生成文件、配置和 APK 的值匹配检查为 0。

脱敏结果为 `amap-authorized-readonly.json`，不含凭据的探针源码快照为 `amap-live-probe-source.go`；项目中的临时探针目录已经清理。本次只读成功不等于真实签到通过。

### 14.6 清理、最终文件与剩余边界

18:33 最终核对：自建模拟器已停止、ADB 设备和转发列表为空，测试端口无监听；全部 **16 个**会话 `web-e2e-*` 目录的临时数据库和 `config.yaml` 均已删除，新的自建 `android-camera-fix\avd` 已清理，仅留证据/脚本/构建。没有删除原 AVD 或其他用户目录。

原服务仍为 3030→2620、38081→21856、5432→21660，两处健康接口 HTTP 200 / code 0；`server.exe` 14:46:48、`xbt-server.exe` 9 月 22 日 11:07、`Web\dist\index.html` 14:47:47 未改。原 AVD 注册/配置与用户盘写入时间仍在 2 月。永久 `C:\Users\user\AppData\Local\XBT` 未读写，没有替换部署。

本轮持久项目改动仅：

- `Android\app\src\main\java\com\github\enderwolf006\xbt\MainActivity.kt`
- 新增同目录 `CameraInitialization.kt`
- 新增 `Android\app\src\test\java\com\github\enderwolf006\xbt\CameraInitializationTest.kt`
- `Android\UPSTREAM.md` 与本交接文档

剩余限制：真实外部签到仍没有指定授权账号/活动，禁止执行；物理真机、正常相机扫码/拍照没有验证；统一设备脚本尚非一次全绿，不能扩大成功口径。高德只读条件已解除并成功验证一次，但 Key 没有持久配置。上述限制与已经完成的崩溃修复、9 项单测、真实 WebView 分层证据分别记录。

## 15. 第五轮：持久统一设备入口与进度反馈修复

### 15.1 恢复与根因

19:33 恢复时先核对现有修改、日志和进程：没有遗留自建模拟器或测试端口监听，
最近失败轮次的临时数据库/配置已清理，未删除正在使用的数据。保留第四轮全部
Android 修复、9 项单测和分层证据，没有重新拉取源码或替换生产部署。

两个失败原因分别处理，不归并为“Android 不可用”：

- `l27QzC` 的错误反馈等待：`ProgressCard` 的 `AnimatePresence mode="wait"`
  使关键状态/错误文案依赖旧内容退出动画。首次在页面加载后替换 rAF 的试验
  `8Wctk2` 没有拦住动画库已缓存的函数，不能作为有效证据。改为模块加载前包装、
  显示“正在尝试签到”后暂停 rAF，旧代码在 `vjwRbJ` **真实失败，exit 1**。
  产品修复移除关键文案的退出等待，保留外卡装饰动画、状态含义及业务重试行为，
  使用即时文本和 `aria-live`。新回归同时覆盖合成 HTTP 拒绝与合成成功结果。
- `7hoBqO` 的确认框残留：CDP `dialog.accept()` 不能代替 Android 原生按钮；
  旧流程虽继续了 JS/后端操作，原生确认框仍可能遮挡页面。新设备脚本按当前
  测试 App 的包名、确认文字和按钮 resource-id 实际点击取消/确认，每次检查
  原生框消失；取消后还检查地点仍存在，确认后检查列表为空。

### 15.2 持久入口与隔离措施

新增 `Web\e2e\run-android.mjs`、`android-device.mjs`、`processes.mjs`、
`gateway.mjs`、`helpers.node.mjs` 和 `README.md`；修改现有 `run-isolated.mjs`、
`sign-locations.spec.ts`、`package.json` 及 `src\components\sign\ProgressCard.tsx`。
设备脚本不再依赖会话目录/固定 AVD 名或绝对项目路径。

运行方法、依赖和限时见 `Web\e2e\README.md`：

```powershell
# 在 Web 目录；产物路径必须为绝对路径
$env:XBT_E2E_ARTIFACTS = "$env:TEMP\XBT-E2E-artifacts"
$env:ANDROID_HOME = "D:\Android\Sdk"
npm run test:e2e:helpers
npm run test:e2e
npm run test:android
```

统一入口创建独立 PostgreSQL/Server/Web，执行真实数据库 Go 测试、构建、lint
和敏感配置扫描；Android 使用已有镜像生成专用无相机 AVD、独立模拟器 home，
不读取原 AVD 用户盘。不使用物理输入、真实账号、真实签到或高德查询。

保留实际 PID/socket + `noDefaults:true`、登录 reload、合成 check/空同学、
完整 403 正文及失败 UI、顶层 `location_id`、原生确认框和旧页面关闭断言。
网关提供合成活动，在设备模式拒绝所有执行入口并记录零转发要求；不是用 API
成功来替代 UI 断言。`0x10008000` 是 `NEW_TASK|CLEAR_TASK`，不称为 recreate。

所有命令有限时；冷启动上限 12 分钟、设备断言 300 秒，不循环冷启动重试。
finally 先关闭自己创建的连接和进程，再删除对应数据库/配置/AVD。进程树按 PID
与父进程归属处理；无法确认停止时保留数据并报错，不按名称杀进程。

### 15.3 新鲜验证记录

| 命令/证据 | 实际结果 |
|---|---|
| `npm run test:e2e:helpers` | 最终 **8/8，exit 0**；包括整体期限、首因保留、根/子进程退出以及原生启动器退出后后代仍存活的清理 |
| `npm run lint -- --max-warnings=0` | exit 0，0 errors / 0 warnings |
| E2E 独立 TypeScript 检查与 Node 入口语法检查 | exit 0 |
| `npm run test:e2e`，`web-e2e-DSAA7D` | **10/10，36.3 秒，整套 exit 0**；原 8 项保留，新增两项暂停 rAF 后关键文案可见 |
| 同一 Web 入口内 Go 全量/真实 PostgreSQL、Server/Web build、敏感配置扫描 | 均通过；没有覆盖部署产物 |
| 首次 Android 入口 `web-e2e-yHn4vZ` | **exit 1，尚未启动模拟器**；Windows `NoDefaultCurrentDirectoryInExePath=1` 不查找当前目录的裸 `gradlew.bat` |
| 最小夹具修复 | 使用显式 `.\gradlew.bat`；不修改机器安全环境设置，离线 `--version` 验证 Gradle 8.13 / JDK 21 |
| Android 入口 `web-e2e-Yh3Ppk` | Gradle **BUILD SUCCESSFUL in 1m17s**，之后安装前 ADB 不可用，清理检查又覆盖首因；整套失败，不能推断宿主崩溃 |
| 最后有依据的定界复跑 `web-e2e-cpYg1p` | **整套 exit 1**；安装成功、0 相机、真实 WebView/原生桥连接成功，但系统 ANR 框遮挡，中文提示可见性断言失败 |
| `cpYg1p` 内 Go 全量/真实 PostgreSQL | 全部通过，`internal/db` **10.127s**，没有缓存替代真实数据库测试 |
| `cpYg1p` 内 Web 构建 | 2239 模块，Vite **4.30s**；lint 和新产物敏感配置扫描通过 |
| `cpYg1p` 内 Android Gradle | **BUILD SUCCESSFUL in 1m31s**；`testDebugUnitTest --rerun` 实际重跑 **9/9**，XML 时间为本轮 20:19，lint **0 errors / 37 warnings** |

`Yh3Ppk` 的 Kotlin 未修改，单测曾显示 UP-TO-DATE，不能将该轮当作重新执行测试体；
最终 `cpYg1p` 已用 `--rerun` 重跑 9 项，记录在 `unified-android-build-final.json`。
APK 仍为
19,325,469 bytes，SHA256 仍为
`D4229899C6469FEF60A14BD5D57C1F86266E2E57F096F3214662EE29D03F69D5`。

本轮没有再次调用高德或保存 Key。真实外部签到仍缺用户指定授权账号和活动，
物理设备/正常相机能力尚未验证；不能以合成网关验证扩大成功口径。
### 15.4 最后定界运行的确切阻塞

`cpYg1p` 工作预算从 20:16:05 至 20:46:05，实际约 20:26 已失败并进入清理，
没有耗尽预算再添加冷启动。`android-environment.json` 确认 `bootCompleted=true`、
`installed=true`、`cameraCount=0`、ABI 为 `x86_64,arm64-v8a`。

`test-results\android-failure.json` 保留了已经通过的真实 Activity/WebView/原生桥
检查。桥的错误状态包含“相机不可用”，但随后的 UIAutomator 可见性断言返回 false。
`android-failed-ui.xml` 的顶层是 **package=android** 的系统对话框：
`System UI isn't responding`，而不是 XBT 的相机错误提示。
没有点击系统 Wait、关闭其他 App 或跳过此断言制造全绿。

因此，本轮**没有执行到**地点 CRUD、原生 Cancel/OK 消失、403 可见反馈、
旧 WebView 关闭的后续统一断言。第四轮分层通过不填补这一缺口。新的原生确认
处理实现有辅助控件解析测试，但尚不能宣称它已在一次完整设备运行中验收通过。
该阻塞需要稳定运行的 Android 系统环境，不是再提供签到账号或读取永久配置可解决。

最后一次的清理还暴露了夹具缺陷：把 Node 子进程的日志流 `close` 当成进程退出
判据，等待 5 秒超时后保留了两个自建目录。修复后先记录本次进程树的
PID、父 PID 和创建时间；根进程退出后仍按该身份清理已记录后代，不按进程名处理；
确认进程树退出后主动关闭自己的日志流，不因流状态独立判断进程是否存活。
以原生 PowerShell 启动器复现“根退出、后代仍活、流未关闭”，最终辅助回归通过。
最初使用 Node 启动器的测试因其 Windows job 会随父进程退出而杀子进程而失败，
已更换准确夹具，不删除退出确认断言。

这项清理修复完成了独立辅助验证，**没有再启动模拟器重跑**，也不将修复后的
清理测试算作设备回归成功。`run-failure.json` 与 `android-run-state.json`
保留首因及附加清理异常，不覆盖历史失败。

### 15.5 最终清理、持久产物与续做边界

20:39 的 `unified-cleanup-final.json` 核实：

- 测试 33030、33081、55432、5556、5557 端口无监听，ADB 设备与转发计数均为 0。
- 本轮 `DSAA7D`、`yHn4vZ`、`Yh3Ppk`、`cpYg1p` 的 `pgdata`、临时配置、
  `avd`、`android-home` 均不存在。`cpYg1p` 两个保留目录只在确认无 SDK 模拟器
  进程、无测试监听后精确删除；排除了属于其他应用的同名进程，未终止它们。
- 原服务 PID 3030→2620、38081→21856、5432→21660 未变；前两者健康接口仍
  HTTP 200 / code 0。部署 `server.exe`、`xbt-server.exe`、`Web\dist\index.html`
  大小和写入时间与第 14 节一致。
- 仅核对原 AVD 元数据，注册/配置和用户盘时间仍为 2 月，未读取其用户盘内容。
  永久 XBT 目录没有读写，没有真实签到、高德新请求或 Key 持久化。

最终 `unified-validation-verified.txt` 为辅助 **8/8**、全量 lint **0/0**、
E2E TypeScript 检查通过的记录。项目可复用入口仍是 `npm run test:android`，
详细依赖、限时、失败证据和清理约束见 `Web\e2e\README.md`，不再依赖会话脚本。

此轮交付包含产品进度反馈修复和持久设备运行器，但**“统一 Android 自动化一次
完整通过”目标仍被上述系统 ANR 阻塞**。真实外部签到仍缺指定授权账号/活动，
物理真机和正常相机能力仍未验证；不以这些限制掩盖已通过的 Web/JVM/辅助回归，
也不以已通过部分冒充全部完成。

## 16. 正式本地部署与后端高德配置（2026-09-25 02:06～02:51，UTC+8）

### 16.1 授权、启动入口与持久落点

用户后续明确授权正式替换 Server/Web、更新现有快捷启动脚本，以及将已提供的
高德 Key 正式持久保存。该授权允许本节必要的正式库备份、迁移和精确停启，
但不允许清空数据、重建账号、真实外部签到或混入预览模拟服务。

- 原快捷方式：`D:\桌面\Tool\学不通签到.lnk`，文件字节与部署前一致。
- 实际目标仍为永久目录 `XBT-Manager.ps1`，保留 PowerShell
  `-NoExit -NoProfile -ExecutionPolicy Bypass -File`、原工作目录及可见窗口方式。
- 管理器仅三处必要修改：程序 root 指向永久 release；PG root 指向永久 runtime；
  `npm run dev` 改为 `npm run preview` 服务正式构建的 dist。菜单、端口、
  后台隐藏窗口、日志位置、重复启动判据和自动打开浏览器调用保持。
- 新程序：`C:\Users\user\AppData\Local\XBT\releases\20260925-0206`。
- 持久依赖：`C:\Users\user\AppData\Local\XBT\runtime\pgsql` 和
  `runtime\node_modules`。两份既有 PG worker 仅调整运行时路径，未注册任何新
  计划任务、系统服务或自启动。正式运行不依赖 Temp 项目或 Copilot 预览进程。
- 正式 URL 仍为 `http://127.0.0.1:38081`；API 为 loopback 3030，
  PostgreSQL 为原 5432；没有擅自开放 LAN/防火墙。

### 16.2 修改前备份、实际恢复迁移与数据保留

受限回滚目录：

```text
C:\Users\user\AppData\Local\XBT\backups\release-20260925-0206
```

目录只供当前 Windows 用户及 SYSTEM 访问，包含原 exe、Web 源码/产物、
管理器/worker/快捷方式、秘密配置和 `xbt-before.dump`，不可上传整个目录或日志。
先完成备份和 `pg_restore --list` 检查，再把真实业务库备份恢复到受限隔离副本
55433，使用新版 Server 33031 执行真实 AutoMigrate；两个验证实例已停止，
恢复副本保密保留，未当作正式库运行。

| 原表 | 升级前/恢复迁移后/正式重启后行数 |
| --- | --- |
| courses | 40 |
| sign_activities | 4 |
| sign_records | 2 |
| user_courses | 40 |
| users | 1 |
| whitelists | 1 |

不只比行数：所有原表、原列的逐行聚合指纹一致。原永久 PG 数据仍在
`XBT\postgres-data`，没有 drop/truncate、恢复覆盖或重置账号。新地点表初次迁移为
0 行，02:38 只读复核为 1 行；部署检查没有新增/删除地点，运行期间新增记录
原样保留，不以“恢复为空”维持断言。两个地点唯一索引和状态 CHECK 均存在。

### 16.3 本轮新鲜构建及正式验证

以下均为本次正式部署新鲜执行结果，不复用第 15 节的测试成功作为本轮结果。
完整命令和私有输出保存在回滚目录 `prepare.mjs`、`prepare-private.log`、
`prepare-result.json`；构建输出直接写独立永久 release，未覆盖项目旧 exe/dist。

| 命令/检查 | 本轮结果 |
| --- | --- |
| Server：`go test ./... -count=1` | exit 0 |
| Server：`go build -o <release>\Server\xbt-server.exe ./cmd/server` | exit 0 |
| Web：`npm run lint -- --max-warnings=0` | exit 0，0 errors / 0 warnings |
| Web：`npm run build -- --outDir <release>\Web\dist` | exit 0，`VITE_API_BASE_URL=/api` |
| 真实 dump 恢复 + 新 Server 实际迁移 | exit 0，所有原数据指纹一致 |
| `node <backup>\production-check.mjs` | exit 0；健康、鉴权、静态字节、schema、配置与秘密扫描通过 |
| 实际 Go `config.Load` 指定正式目录的针对检查 | exit 0；Key/校区均加载，不输出值、不发外部请求 |
| `node <backup>\formal-ui-check.mjs` | exit 0；独立 Edge context 登录页渲染、未登录管理页重定向通过，运行时 JS 错误 0 |
| `node <backup>\menu-smoke.mjs` | exit 0；02:50 原菜单再次启动/调起浏览器返回成功，状态准确显示原三 PID，0 退出 |

正式 3030 与 38081 的 `/api/health` 均 HTTP 200；两个地点 API 在未认证时均
401。正式首页及其两个 JS/CSS 引用与新 release 字节一致。未向真实登录表单输入
账号密码；正式登录链路对外成功、真实签到和照片上传没有宣称通过。

新产物 SHA-256：

```text
Server\xbt-server.exe
ebef53f470fe82ed2c31583e18ff06c2d829a3f293ba48aeed3abc0b9e906d4c

Web\dist\index.html
7fd28ace31e0bf5a97b392761d1b1b73da6d4666702216663c3d4ae76aaacae8
```

`stage-check.json` 确认正式产物不含预览账号、fixture/网关逻辑。
`production-check.json` 再以当前真实后端秘密值扫描 exe 和 Web 产物，
未发现 Key/JWT/凭据密钥/数据库密码内嵌。私有配置不打包进 Web/APK。

### 16.4 原快捷方式实测与运行生命周期

通过 Explorer 实际打开原 `.lnk`，使用本次管理器窗口输入原菜单，
没有用 preview runner 代替正式启动：

- 菜单 1：正式三服务启动；重复菜单 1 三个 PID 不变，原自动打开浏览器调用保留。
- 菜单 4：实际生成 `backups\xbt-20260925-022804.dump`，
  `pg_restore --list` 可读，新备份文件权限已受限。
- 菜单 2：3030/38081/5432 全部正常停止，预览三服务未被误停。
- 菜单 1 再启动：PG 从永久 runtime 启动，新 API 从永久 release 启动。
- 菜单 3 与 0：状态功能保留；0 退出脚本。原 `.lnk` 的 `-NoExit` 使 PowerShell
  提示符继续存在，这是原行为。初始诊断误期待进程直接消失，已通过只读本次
  控制台的“选项 0 → PS 提示符”纠正，不是产品退出失败。
- 随后仅关闭本次验证管理器 PID 2624，正式三服务仍保持相同 PID 与健康状态。
  菜单 5 含原有重建数据库操作，仅静态核对保留，**没有执行**。

最后核实的正式 PID：

| 服务 | 端口 | PID | 运行来源 |
| --- | --- | --- | --- |
| Server | 3030 | 18732 | 永久 release 的 `Server\xbt-server.exe` |
| Web | 38081 | 22464 | 永久 release Web + 已有 Node |
| PostgreSQL | 5432 | 22400 | 永久 `runtime\pgsql\bin\postgres.exe` |

PID 会在用户后续重启时变化；操作前必须重新确认身份，不能照抄这些 PID 结束进程。
02:51 的 `deployment-final.json` 再次确认上述 PID、原六表指纹及配置/产物检查通过；
正式进程命令不引用 Temp 项目或预览，两个正式配置仅当前用户/SYSTEM 可访问，
测试及预览端口仍全部关闭。

### 16.5 高德正式配置与 Android 边界

准确 Key 从本会话原授权消息在本机内存恢复；校区使用既有项目配置中此前真实
只读探针所用值，不猜测学校。只向正式 `XBT\server-config.yaml` 新增 `amap`
段，其余字段解析后严格相等；运行副本和原配置均为当前用户/SYSTEM 两条显式
授权且禁止继承。原无 AMap 配置备份、授权后新配置备份均受限保存。

实际 Go 配置加载器检查通过，原菜单重启后读取新配置。本轮**高德请求 0 次**；
此前仅一次 HTTP 200 / status 1 / code 10000、3 POI 的证据仍是历史只读结果，
不表示人工核实都在目标校区，更不表示可直接启用或真实签到通过。

Android 是 WebView 壳，地点/高德能力使用同一个后端，不应将 WebService Key
嵌入 Android 资源或 APK。现有配置位置：

- `Android\app\src\main\res\values\strings.xml`：`target_url=about:blank`。
- `Android\app\src\debug\res\values\strings.xml`：`http://10.0.2.2:33081/`，
  仅旧隔离模拟器预览目标，当前预览已停，不能当正式地址。

尚未确定手机可达的正式 URL、LAN/USB/域名连接方案及设备，用户当时不在；
不自行开防火墙或猜地址，不新增 URL 设置功能、不生成误导的正式 APK。
**Android 尚未接入本次正式部署，也未安装验证。** 第 15 节系统 ANR、物理设备
和真实相机/扫码能力未验证的结论保持；本轮未启动模拟器。

### 16.6 预览收尾、文档与回退

正式切换成功后，通过各自 STOP 正常关闭预览 2576/14816/29608 和本次独立可见
Edge 监督器 15156；两监督命令均 exit 0，状态为 `stopped`/`browser-closed`，
预览 `cleanupErrors=[]`。33081/33030/55432 及迁移验证 55433/33031 均无监听。
仅关闭本任务浏览器，不结束用户其他浏览器；演示 PG、配置及报告保留，未迁入正式库。

原快捷用法和回退步骤见永久 `XBT\DEPLOYMENT.md`。已准备但未激活
`<backup>\XBT-Manager.rollback.ps1`：沿用原菜单，指向受限 `previous` 旧程序，
仍使用永久 PG runtime。依赖路径及 PowerShell 语法已验证；回退时先用原菜单 2
停止，再保存当前入口并替换该脚本，原快捷菜单 1 启动即可。
**只回退程序入口，不自动还原数据库或旧密钥配置，不执行菜单 5。**
任何数据库恢复都须另行评估上线后新增写入，不能用旧 dump 抹掉新数据。

保留问题不扩修：预览可见演示曾发现 toast 悬停遮挡按钮，照片权限拒绝提示
时序不稳定、扫码权限拒绝后启动遮罩；相关历史证据仍在会话演示目录。
此前模拟账号/课程/活动/执行不算正式真实业务验收；本轮仅声明电脑正式部署完成，
不声明 Android 或真实外部签到全流程完成。

## 17. 只读候选搜索、明确保存与正式更新（2026-09-25 03:01～03:40，UTC+8）

### 17.1 根因与新的使用语义

原服务 `SearchCandidates` 在每次搜索后直接创建 pending 记录；Web 随后重新读取
全部已保存地点，而列表按 name/id 排序，所以旧结果累计，新结果没有独立的显示位置。
原高德客户端仅把用户词传给 keywords，却把整段校园地址传给 city。
按[高德关键字搜索文档](https://lbs.amap.com/api/webservice/guide/api-advanced/search)，
city 用于城市名/城市代码/区县代码，不能将校园地址当作地理范围。

现已实现并正式发布：

- `POST /api/admin/sign-locations/search` 只返回无数据库 ID/状态的临时候选，不写库。
  `scope=campus`（默认）组合既有校区文字和建筑关键词；输入已含完整校区文字则不重复追加。
  `scope=full` 使用完整学校/建筑名称，不追加校区。每次仅一页、最多 25 条，保留上游顺序；
  不猜校区中心、地理围栏或楼栋坐标，也不引入地图 SDK。
- Web 提供教学楼、图书馆、宿舍、食堂关键词捷径及检索方式选择，显示实际名称、地址、
  高德来源、POI ID、经纬度，并说明学校整体 POI 不等于某栋楼，需人工核对。
- “本次搜索结果”和“已保存地点”分区。新搜索即清空临时区；
  loading/空结果/错误均有明确反馈，旧请求晚返回不会覆盖新查询。
- 新增管理员 `POST /api/admin/sign-locations/candidates`，只有明确点击保存才入库。
  新地点固定 `source=amap`、`status=pending`；名称/地址和显式有限坐标校验，
  六位坐标规范及原唯一约束保留。源字段或状态不能由客户端提升为直接启用。
- 原 23505 并发回查修复迁入明确保存操作，保留 fresh query/清空旧 ID 的处理及
  不同 POI 的复合唯一冲突兼容。重复保存返回 `created=false` 和原记录，
  不覆盖管理员编辑，不改变原启停状态。已删 POI/相同名称地址坐标返回 409，
  不通过候选恢复或重建；手动新增原有行为不变。
- 保存后管理区切回“全部”、定位并高亮该数据库 ID，候选显示“已保存”或“已存在”
  及查看入口。保存响应晚于下一次查询时，不把旧候选的保存状态误标到新结果上。
  已保存的全部历史记录仍保留，不自动删除或启用任何地点。

### 17.2 持久测试与本轮新鲜结果

入口仍为项目内 `Web\e2e\run-isolated.mjs`，新增可选 `XBT_E2E_HEADED=1`。
依赖现有 Node/Go/PostgreSQL/Edge，没有下载新工具，也没有启动 Android。
每轮独立 PG 55432、Server 33030、Web 33081，合成账号；真实账号/token 不读取。

```powershell
# 在 Web 目录；产物目录必须为独立绝对路径
$env:XBT_E2E_ARTIFACTS = "$env:TEMP\XBT-candidate-validation"
$env:XBT_E2E_HEADED = '1'
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交'

# 本次最终构建的针对复核
npm run test:e2e -- --grep '候选'
```

实际证据根：
`C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files\candidate-search-20260925`。

| 本次运行 | 结果及覆盖 |
| --- | --- |
| `web-e2e-uJpkXX` | exit 0，首轮 6/6：原 CRUD/状态/确认删除、普通权限、连续候选与保存定位/编辑保护、乱序/空/失败/完整名称、候选 API 验证/删除保护、用户顶层 ID 及停用删除拒绝 |
| `web-e2e-43IjJt` | exit 0，最终候选 4/4：重跑上述三个候选用例，新增“保存期间换查询”用例 |
| 两轮 `go test ./... -count=1` | exit 0，均实际连接本轮独立 PG，不是跳过集成 |
| 两轮真实 PG 并发 | 每轮有/无 POI 两组各 64 路明确保存；每组强制且断言 63 次真实 23505、全部返回同一行；复合冲突、删除/编辑保护及只读搜索行数断言通过 |
| 两轮 Go build、Web lint/build、构建秘密扫描 | 全部 exit 0；lint 0 errors / 0 warnings |
| 最终 E2E/产品 TypeScript | exit 0 |

共 **7 项唯一相关浏览器/API 用例**经过实际执行；不是“某一轮 7/7”，两轮分别
6/6 和 4/4。有头 Edge 使用 650ms slowMo、关键结果停留 2.2 秒以上，截图留在
各轮 `test-results`。页面显示隔离标识，不关闭或控制用户原已登录浏览器。

覆盖性质严格区分：

- 页面搜索响应为 Playwright 合成 POI；校区/完整名称的真实 HTTP 参数由 Go 本机
  httptest 上游断言。未把测试桩结果当作真实校园楼栋数据。
- 页面确认保存、编辑、启停、删除、用户可选 API 使用真实隔离 Server/PG。
  保存/删除保护的补充用例为直接 API 测试，不冒称每条都是 UI 点击。
- 连续搜索的数据库零写入另由真实 PG + 服务层搜索验证；
  API 校验补充了缺失坐标、非法纬度、非法来源/启用状态及已删记录 409。
- 原照片/扫码能力、Android 系统 ANR、真实登录/外部签到不在本轮范围。

### 17.3 新快照、切换与正式结果

新的受限备份：

```text
C:\Users\user\AppData\Local\XBT\backups\release-20260925-0315
```

包含当前正式 `20260925-0206` 的程序/静态产物、原管理器/worker/快捷方式、
完整配置及 `xbt-before.dump`。实际库已不是上一轮仅 1 条地点的数据：
本次初始快照 **sign_locations 总行数 54（包括软删历史）**。
真实 dump 已恢复到隔离 55433，以新 Server 33031 执行实际迁移，
全部七表原列指纹一致；验证实例正常停止，`cleanupErrors=[]`。

切换前又在仅停止正式 API/Web 后生成 `xbt-cutover.dump` 和
`database-before-cutover.json`，避免把准备期间的新增用户数据排除在最终校验之外。
PG PID **22400** 全程保持，没有重启 PG、改 worker、清空表或恢复覆盖数据。

新的正式 release：
`C:\Users\user\AppData\Local\XBT\releases\20260925-0315`。
直接使用最终隔离回归构建的产品 exe/dist，字节校验一致，不包含测试网关、
合成账号或 POI fixture。管理器本轮**只改一处 release 路径**，原快捷 `.lnk`
字节和所有配置字节（含高德 Key/校区）不变。

原快捷经 Explorer 实际启动新版本；重复菜单 1 PID 不变且打开网页返回成功，
菜单 0 保持原 `-NoExit` 行为。本次验证窗口 28704 已关闭，服务继续独立运行。
检测到用户原先已打开的管理器窗口 **2940**，没有擅自关闭或操作；
其内存中可能仍是旧路径，用户下次启停应重新打开原快捷，而非继续使用旧窗口。

| 项目 | 最终结果 |
| --- | --- |
| 正式地址 | `http://127.0.0.1:38081` |
| 当前进程 | API 1376 / Web 30784 / PG 22400 |
| health | 3030 和 38081 均 HTTP 200 |
| 未登录鉴权 | 用户/管理地点 GET、候选确认 POST 均 401 |
| 正式静态文件 | index 和两个 JS/CSS 引用与新构建逐字节一致 |
| 空白独立 Edge context | 登录页渲染及未登录管理页重定向通过，JS 错误 0；未输入真实凭据 |
| 数据 | courses 40、activities 4、locations 54、records 2、user_courses 40、users 1、whitelists 1；七表全部原列指纹与切换快照一致 |
| 配置/Key | 原完整字节保持，正式配置与运行副本仅当前用户/SYSTEM 可访问；产物无后端秘密 |
| 清理 | 两轮合成 PG/config 已移除，有头测试窗口正常关闭；33030/33081/55432/33031/55433/38082 均无监听；真实恢复副本保密保留但已停止 |

新 SHA-256：

```text
Server\xbt-server.exe
16a9e54d6facfcf8041a94a45f9673d9b6fc9d89353ae72f4d15e1209613d9b9

Web\dist\index.html
5f35036e456daa0431b59327391c313d4cff37942a811372c915391fbd48fc8e
```

正式 `production-check.json`、`formal-ui-check.json`、
`deployment-final.json` 和 `menu-validation.json` 均保存在本轮受限备份。
本轮没有真实高德新查询、真实对外签到或 Android 操作。

### 17.4 使用、文件与回退

刷新正式网页，进入“签到地点”：

1. 选择“校区 + 建筑关键词”，点击教学楼/图书馆等捷径后搜索；或选完整名称并输入完整学校及楼名。
2. 在“本次搜索结果”中核对实际地点信息，点击“确认保存为待确认”。
3. 页面定位到已保存记录，必要时编辑；核实后再“明确启用”。旧历史记录仍在管理区，可自行管理。

现实楼栋是否被高德收录、查询能否覆盖某一所学校所有建筑，本轮没有对外验证，
不能承诺“输入学校即可精确找到每栋楼”。只修正了查询组合和产品读写/展示语义。

主要改动：Server 的 amap client/测试、地点 service/handler、路由及 PG 集成测试；
Web 的 SignLocations/types、持久 e2e/gateway/有头配置；
API 文档、设计/计划对应契约、e2e README 和本交接。
没有新增产品依赖，没有改 Android、toast 或相机实现。

永久 `XBT\DEPLOYMENT.md` 已切换到新版本及本轮备份。
`XBT-Manager.rollback.ps1` 是本轮修改前的原入口，指回永久 `20260925-0206`，
已准备但未激活。需要回退时先通过原菜单停服务，保存当前入口后换该脚本并重开快捷；
**仅回退程序，不还原数据库、旧配置或抹除新记录，也不执行菜单 5**。
回退旧程序会恢复旧版搜索自动保存语义，须知悉这一行为差异。

## 18. 已删候选显式恢复、行内提示及检索词透明度（2026-09-25 12:02～12:27，UTC+8）

### 18.1 用户问题与已修范围

用户截图的多条“该候选对应的地点已被删除”来自保存候选的软删冲突，不是高德
坐标解析失败。前版只拒绝自动恢复，却没有可操作的显式恢复入口；Axios 错误拦截
还丢弃了 HTTP/data 结构，页面重复保存会每次新增 toast，遮挡实际操作。

本轮已正式发布以下紧密相关修复：

- 保存仍不自动恢复。遇已删匹配，HTTP 409 的 `data` 返回
  `error_code=SIGN_LOCATION_DELETED` 和实际旧地点 `location`，匹配优先相同
  POI，否则同名称/地址/六位坐标。结构只向管理员返回，不包含账号、Key 等秘密。
- `ApiError` 保留响应状态及结构化字段，候选 UI 使用状态、错误码和合法 ID 判断，
  不解析中文句子。普通 409、网络失败即使文案提到“已删除”，也不显示恢复入口。
- 每张候选卡只有一条可更新的行内错误。已删冲突出现后，原保存按钮变为
  “确认恢复旧地点为待确认”，展示旧记录 ID、旧名称、地址及坐标；
  同步忙锁防止连续点击产生同一操作并发，候选成功 toast 使用固定 ID 去重。
  新搜索/晚到响应的隔离仍保留，上一查询的错误不会标到新结果。
- 新增管理员 `POST /api/admin/sign-locations/:id/restore`，
  必须有效 ID 和 `{"confirmed":true}`。前端真实原生确认框明确说明恢复旧记录、
  保留旧内容、置待确认、不自动启用；取消不发送请求。
- 恢复事务内 `SELECT FOR UPDATE` 锁定同一旧 ID，只清除软删、置 `pending`
  并正常更新更新时间；名称、地址、坐标、来源、POI、创建时间和身份均保持。
  已恢复/未删除则幂等返回 `restored=false`，不改变原启用/停用状态。
  唯一冲突返回独立 `SIGN_LOCATION_CONFLICT`，事务回滚而非覆盖其他地点。
- 保存/恢复后继续定位高亮旧管理记录，恢复后仍须人工核实并另行明确启用。
  本轮没有批量恢复历史记录，也没有对生产地点执行恢复、删除或测试写入。

### 18.2 楼栋检索：本轮改善与未解决边界

只在本机私下检查当前 `campus_address` 的形态：17 个字符，含道路或数字类标记，
无空格且不含“校区”字样；没有在报告中回传其内容，也没有更改配置。
这提示“完整详细地址 + 楼名”可能过窄，但不能仅凭形态证明真实高德命中原因。

本轮提取客户端共用的 `QueryKeywords` 函数，实际 HTTP 参数和管理员响应顶层
`query_keywords` 使用同一构造逻辑。查询失败但构造有效时也返回该字段，
页面显示“实际检索词”，不是前端猜测。维持上一轮显式 campus/full 模式及
单次第一页 25 条，不加分类过滤、不猜围栏、不自动删改地址或重复请求。
页面指导在配置是详细门牌地址时切换完整名称，输入学校全名、校区及楼栋正式名称，
而不是道路门牌；仍明确学校级 POI 不能冒充楼栋坐标。

**本轮高德新请求为 0，现实楼栋检索精度仍未验证/未宣称解决。**
没有地图 SDK、校区中心代替楼坐标、Android 或真实签到操作。
如后续需要诊断真实命中，须用户提供一个具体学校/楼名并授权最少两次只读文本查询，
对比当前校区组合和完整名称；未获授权之前不自行调用。
如改为先选校区再周边搜索，必须另行确认地点选择、半径和调用范围，不能擅自扩大。

### 18.3 恢复执行与本轮新鲜验证

12:17 恢复现场时正式入口仍为 `0315`，API1376/Web30784/PG22400，没有提前发布，
也没有遗留本轮 PG/UI 测试进程。最后命令确切失败是 Web TypeScript exit 2：
新 `ApiError` 参数属性触发项目 `erasableSyntaxOnly` 的 TS1294，不是模拟器或
PostgreSQL 环境阻塞。改为显式字段赋值后产品/E2E 类型检查 exit 0。
新增测试曾因补丁插入位置导致 Go 语法检查失败，修正后才启动完整隔离回归；
这些早期失败不冒充通过或正式上线证据。

最终持久入口（已有工具，不装新依赖）：

```powershell
# Web 目录；使用独立绝对路径保存本轮产物
$env:XBT_E2E_ARTIFACTS = "$env:TEMP\XBT-restore-validation"
$env:XBT_E2E_HEADED = '1'
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交'
```

本轮实际产物：
`C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files\candidate-restore-20260925\web-e2e-QDbxy5`。

| 新鲜验证 | 结果 |
| --- | --- |
| 有头 Edge 定向回归 | **9/9，整套 exit 0，1.6 分钟**；650ms slowMo、关键截图前至少停留2.2秒 |
| 删除冲突 UI | 合成地点先真实保存/编辑/启用/删除；冲突仅一条卡片提示，5次真实取消不发送恢复请求、不堆toast；确认恢复同一ID为pending，旧字段保持并高亮 |
| 结构化错误 UI | 普通409（含“已删除”中文）及网络失败不误判恢复入口，多次重试仍一条内联错误 |
| 其余7项用例 | 原CRUD/状态/删除确认、非管理员、连续只读搜索/保存定位/编辑保护、搜索乱序/空/失败/完整名称、候选API验证、保存期间新搜索隔离、用户顶层location_id及停用删除拒绝 |
| 真实 PostgreSQL | 全Go实际连接独立PG；原两组64路保存各63次23505；新增32路恢复+32路保存混合并发仅一次恢复且同ID/原字段、恢复唯一冲突回滚、重复恢复保留启停、非法ID断言通过 |
| `go test ./... -count=1` / Go build | exit 0 |
| Web lint / build | exit 0，lint 0 errors / 0 warnings |
| 产品及E2E TypeScript | 修正后 exit 0 |
| 秘密/演示产物扫描 | exit 0；正式产物不含后端配置值或合成演示网关 |

有头 UI 的高德返回和账号仍明确标注合成；保存/编辑/删除/恢复和地点列表使用
真实独立 Server/PG，未读取正式用户 token 或操作用户现有浏览器登录状态。
缺少确认、非法ID、404、非管理员403等有部分直接API覆盖，不冒称全部UI点击。
搜索零写和服务端查询词另有真实PG/本机HTTP测试服务器断言，不表示真实高德命中率。

关键截图 `deleted-inline-five-cancels-no-toast.png`、
`restored-old-fields-pending-highlight.png` 及
`ordinary-error-not-restorable-no-toast.png` 位于该轮 `test-results`；
已目视核对第一张无堆叠toast、显示唯一旧记录和恢复按钮，只有合成数据。

### 18.4 安全正式发布、数据与资源

本轮新受限备份：
`C:\Users\user\AppData\Local\XBT\backups\release-20260925-1220`。
备份前版 `0315` 的真实程序、入口、worker、快捷方式及完整配置，并新做
`xbt-before.dump`；恢复到独立55433、用新Server33031实际迁移，七表原列指纹一致。
随后仅精确停止当前API1376/Web30784，再生成 `xbt-cutover.dump` 及切换时最新
`database-before-cutover.json`，防止漏掉准备期间用户新数据。PG22400全程未重启。

新正式 release：
`C:\Users\user\AppData\Local\XBT\releases\20260925-1220`，
使用本轮通过的独立构建 exe/dist。原 `.lnk` 字节不变，管理器只改一处release路径，
PG/runtime及worker均不变，完整正式配置字节（含Key/校区）保留。
配置和运行副本均仅当前用户/SYSTEM可访问，未把秘密写入源码、前端或APK。

原快捷经 Explorer 实际启动新版本，重复菜单1不创建新PID且打开网页返回成功；
菜单0仍保持原 `-NoExit` 语义，本轮验证窗口17420关闭后服务独立存活。
用户已有的其他管理器/浏览器窗口均未擅自操作，下次启停应重新打开原快捷。

| 正式最终核对（12:27） | 结果 |
| --- | --- |
| 地址 | `http://127.0.0.1:38081` |
| PID | API **23648** / Web **30820** / PG **22400** |
| 七表数量及指纹 | courses40 / activities4 / locations54 / records2 / user_courses40 / users1 / whitelists1；全部原列指纹与切换快照一致，locations含软删历史 |
| health / 鉴权 | 3030、38081 health均200；地点GET、候选保存POST、恢复POST未登录均401 |
| 静态及浏览器 | 首页+两个JS/CSS与新构建字节一致；独立空Edge登录页及访问保护通过，JS错误0，未输入真实凭据 |
| 清理 | 本轮合成PG/config移除、测试Edge已关闭；33030/33081/55432/33031/55433/38082无监听；受限真实恢复副本保留但已停止 |

新 SHA-256：

```text
Server\xbt-server.exe
22172f741c9cd39ae2a0589f060139a5b859fedb7826ed64a977896a8ff202ff

Web\dist\index.html
f25c8beb4eaa9909673824d48c2a271f154db025571f830cff7711d1eb243c1b
```

证据为本轮备份内 `prepare-result.json`、`production-check.json`、
`formal-ui-check.json`、`menu-validation.json`、`deployment-final.json`。
`XBT-Manager.rollback.ps1` 为切换前入口，指回保留的永久0315，语法已检查但未激活。
回退只回退程序，不恢复数据库/旧配置、不执行菜单5或清空新记录。
0315不提供显式恢复和内联错误修复，回退会恢复该已知限制。

相关API/设计、e2e README、错误类型和持久测试已更新；永久 `XBT\DEPLOYMENT.md`
记录新版、使用与回退。Android、物理设备、外部签到和原相机实现均未改动。

## 19. 浏览器现场定位与地图中心取点（2026-09-25 13:49～14:19，UTC+8）

### 19.1 实现与使用边界

管理员进入“签到地点”→“手动新增”或已有地点“编辑”：

1. **浏览器现场定位**：用户点击后才调用 Geolocation，`enableHighAccuracy=true`、
   `timeout=10000`、`maximumAge=0`。WGS-84坐标提交管理员只读预览接口，
   服务端近似转换为六位GCJ-02，显示原始精度与采集时间。精度大于50米明确警告，
   不强行伪装楼栋级精度；拒绝权限、超时、不支持和非安全上下文只有一条可重试的行内错误。
   点击“使用定位点”才填表，不产生数据库写入，不猜名称。
2. **打开地图取点**：优先刚采集/当前编辑点，否则校园配置仅作为参考中心，
   明确“尚未选中楼栋”。浏览器仅请求本项目API，后端使用既有Key访问官方静态地图；
   固定中央十字，方向按钮按25/100/500米平移，服务端球面距离算法回显实际中心，
   可缩放1–17级。没有用浏览器像素反推经纬度。每次平移/缩放清除确认，
   图片有效加载并勾选人工核对后，才能“使用中心点”填表。
3. 名称、地址必须管理员手填，再独立点击“保存地点”。`device_gps`/`map_pick`
   创建和重新采集编辑均强制 `pending`、清空旧POI；编辑原启用地点也不会直接继续启用。
   原普通编辑及搜索/明确保存/恢复/并发唯一性保留。未知创建来源和伪造 `amap` 降为 `manual`。

所有页面明确：坐标采集/取点**不能证明处于老师设定签到范围**，不能代替现场核实，
不会自动提交签到。转换为公开近似算法，不是测绘保证；公开北京样例
WGS-84(经116.404/纬39.915)→GCJ-02(经116.41024449916938/纬39.91640428150164)
作为单测依据，未拿学校中心冒充楼坐标。

后端新增管理员 `POST /coordinate-preview`、`POST /map-preview`
（均位于 `/api/admin/sign-locations` 下），未登录401/非管理员403。
两者无DB依赖、`no-store`。地图已知中心只调用一次静态图；
首次无中心最多校园地理编码+静态图各一次，总期限10秒，不猜多候选校区。
上游限4MB、禁重定向、校验600×400 PNG/JPEG并重编码净化，只回图片data URI及中心；
错误为固定安全中文，不回Key、上游URL/正文，不新增前端Key。
用户在正式页主动打开地图将使用既有高德服务配额；本轮开发/验收未调用真实高德。

### 19.2 文件改动

- Server：`cmd\server\main.go` 注册受admin保护的预览路由；
  新 `internal\geo\coordinates.go` / `coordinates_test.go`，
  `internal\amap\static_map.go` / `static_map_test.go`，
  `internal\handler\location_capture.go` / `location_capture_test.go`。
- Server：`internal\service\sign_location.go` 来源白名单/重新采集pending及清POI；
  `sign_location_task3_test.go` 与 `internal\db\sign_location_integration_test.go` 定向回归。
  **未改任何模型、PG表结构或迁移定义。**
- Web：新 `src\components\LocationCapture.tsx`，接入 `src\pages\SignLocations.tsx`；
  modal可滚动、来源展示、表单保存错误行内反馈。
  `e2e\gateway.mjs`仅补两条精确白名单；`e2e\sign-locations.spec.ts`加3项回归。
- 文档：`Server\API.md`、`Web\e2e\README.md`、本交接及永久 `XBT\DEPLOYMENT.md`。
  正式管理器仅release路径一处变化，原lnk和worker字节保持。

### 19.3 本轮新鲜验收

持久命令（Web目录，使用已有PG工具）：

```powershell
$env:XBT_POSTGRES_BIN = 'C:\Users\user\AppData\Local\XBT\runtime\pgsql\bin'
$env:XBT_E2E_ARTIFACTS = 'C:\Users\user\.copilot\session-state\726451fd-dd1d-463c-9388-12772c8e8d8e\files\location-capture-20260925'
$env:XBT_E2E_HEADED = '1'
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交|坐标采集|地图中心'
```

本次目录 `...\location-capture-20260925\web-e2e-6Ep9zY`。
整套 **exit0、有头12/12（2.1分钟）**，非历史结果：

| 验收 | 实际结果 |
| --- | --- |
| Go | `go test ./... -count=1` 同轮连独立PG通过；新公开坐标样例、非法值/范围外、米数平移、地图参数/Key安全、预览/精度50米边界及来源保护通过 |
| 真实PG | AutoMigrate/索引、预览总行数零变化、新来源pending/清POI/编辑重置、原配置幂等、两组64并发保存各63次真实23505及32恢复+32保存混合并发通过 |
| Web | lint **0 errors/0 warnings**，`tsc -b`、E2E独立类型检查、Server/Web独立构建、后端秘密与演示代码扫描均exit0 |
| 新有头UI3项 | 拒绝重复点击单条行内错误、51米警告、名称必填不写、真实转换预览和保存；地图确认前不填表/不写、平移缩放清确认、显式保存pending；不安全上下文/超时与admin鉴权 |
| 原有头UI9项 | CRUD/启停/删除取消确认、权限、连续搜索/乱序/空错、已有记录保护、已删候选取消5次零写/确认保留字段、普通409/网络错误、保存中新搜索、顶层location_id拒绝检查通过 |

**覆盖性质**：新增定位测试仅在独立浏览器context使用公开样例的能力桩，
没有修改系统GPS/模拟设备位置、未读取用户真实地理位置。坐标转换、管理操作及保存使用真实隔离Server/PG。
地图UI使用标为 `SYNTHETIC MAP - NOT A REAL BUILDING` 的受控图/响应；
Go本机HTTP桩另验真正代理请求、图片净化及服务端平移，不宣称测试了真实地图收录。
新增采集/地图用例断言签到执行请求0；原地点状态拒绝回归仅本机API拒绝，
没有对外签到。没有真实高德、真实学习通登录/签到、图片上传、Android或物理设备操作。

截图位于该目录 `test-results` 下的 `capture-permission-inline-not-toast.png`、
`capture-accuracy-name-required-no-write.png`、
`map-reference-pan-zoom-no-selection-no-write.png`、`map-pick-explicit-save-pending.png`。
命令与浏览器原始结果为 `commands.log`、`browser-tests.log`。
合成数据库/config在可靠finally中删除，浏览器关闭，构建及脱敏截图保留。

### 19.4 正式安全发布与回退

新受限备份：`C:\Users\user\AppData\Local\XBT\backups\release-20260925-1415`。
先备份原1220程序/入口/配置/lnk/worker，生成新鲜 `xbt-before.dump`，
恢复到独立55433并用新Server33031实际启动验证：七表所有原列指纹完全一致。
确认后才精确停旧API23648/Web30820，PG22400保持，再生成切换瞬间
`xbt-cutover.dump`/指纹快照，未写/清空/恢复正式数据库。

新永久release：`C:\Users\user\AppData\Local\XBT\releases\20260925-1415`，
直接采用本轮通过的独立exe/dist，不含测试网关/合成账号或Key。
原管理器只把1220路径改为1415；原快捷
`D:\桌面\Tool\学不通签到.lnk` 字节不变。完整配置、PG runtime及worker不变，
配置/备份/发布目录仅当前用户与SYSTEM可访问。没有新增服务、自启、开放防火墙。

通过Explorer原快捷、本轮新窗口15720执行菜单1，启动/打开网页正常；
重复菜单1仍同PID，菜单0保留原NoExit控制台。关闭该验证窗口后正式服务独立存活。
没有操作用户已有管理器8348或用户浏览器。菜单2/4原代码未动，本轮为保持PG不重启
不重复执行；菜单5绝未执行。

| 正式14:19核对 | 结果 |
| --- | --- |
| URL / PID | `http://127.0.0.1:38081`；API **31184** / Web **28728** / PG **22400** |
| 数据保留 | courses40 / sign_activities4 / sign_locations54（含软删）/ sign_records2 / user_courses40 / users1 / whitelists1，全部七表指纹保持 |
| HTTP / 页面 | 双health200/code0；地点列表、候选保存、恢复及两个新预览未登录401；正式新静态字节一致，独立空登录页/访问保护通过，JS错误0 |
| 资源 | 33030/33081/55432/33031/55433/38082无监听；合成PG/config已删除，受限真实恢复副本停止保留 |
| 秘密 / 原入口 | Web/exe不含实际后端秘密；完整配置/lnk/worker字节保持，管理器只有release路径变化 |

SHA-256：

```text
Server\xbt-server.exe
ea1f48b86f58d82a346d841a63e50e495dcd4ff8f34c4065eaffa242566325e4

Web\dist\index.html
d19d40b95ab0ef2cdf10a12f20ba20fb9ee2c61a57a4c38677b26ec988bcf9b0
```

备份内 `prepare-result.json`、`stage-check.json`、`cutover-snapshot.json`、
`production-check.json`、`formal-ui-check.json`、`menu-validation.json`、
`deployment-final.json` 记录本轮实际结果。回退入口 `XBT-Manager.rollback.ps1`
指回保留的1220，语法验证通过、未激活。只退程序/入口，不恢复旧数据库或配置，
不执行菜单5；1220保留搜索/恢复但无此次采集/地图功能。

## 20. 位置签到页定位排序与地图匹配（2026-09-25，UTC+8）

### 20.1 新流程与接口边界

`sign_type=4` 保留原“点击选择地点”。其底部列表顶部增加“现场定位”，
用户点击后才以highAccuracy、10秒、maximumAge=0请求浏览器位置，经服务端转换GCJ-02，
对启用地点计算球面距离、近到远排序并显示距离，不自动选中。
最近点不超过150米才提供“使用最近地点”；否则明确无附近启用地点，原手动列表仍可使用。
权限拒绝、超时、非安全上下文均为可重试行内错误，不堆toast。

原选择框旁增加“打开地图选择位置”，复用静态图代理和固定十字、
25/100/500米方向移动及缩放；“回到目前位置”每次重新采集并服务端转换成功后才改中心。
定位失败保留原中心并说明原因，不把校园参考冒充当前位置。每次移动清确认。
地图确认与“使用最近地点”均重新读取启用列表，最多选150米内最近的正整数ID；
无匹配不关闭/不伪装已选，关闭窗口后的迟到匹配也不覆盖选择。

登录组新增 `POST /api/sign/locations/coordinate-preview` 和 `/map-preview`，
复用原无DB handler。匿名401；普通用户仅获得只读预览，管理搜索、列表、创建、
启用、恢复等权限不变。原管理员采集/地图功能和搜索恢复行为保持。
执行始终只提交顶层 `location_id`，服务端取库存坐标；客户端坐标或嵌套ID不能替代。
这只是本项目启用地点选择，不证明教师签到范围，不自动创建/启用地点或签到。

改动文件：`Server\cmd\server\main.go`、
`Server\internal\service\sign_location_mapping_test.go`；
`Web\src\pages\SignDetail.tsx`、共享 `components\LocationCapture.tsx`，
新 `components\sign\SignLocationPicker.tsx`、`utils\locationPreview.ts`、
`utils\locationMatching.ts`；`Web\e2e\gateway.mjs`、`sign-locations.spec.ts`，
以及API/e2e/交接/部署说明。未改Go模型、PG schema或正式配置。

### 20.2 本轮测试证据与覆盖性质

命令：Web目录设置已有 `XBT_POSTGRES_BIN`、`XBT_E2E_HEADED=1`，
`XBT_E2E_ARTIFACTS=...\files\sign-pick-20260925` 后执行：

```powershell
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交|坐标采集|地图中心|签到选点|用户无地点'
```

首次静态检查发现新增Go测试插入位置错误及effect清理lint警告，已修正；
距离逻辑另拆为不依赖浏览器API的纯模块，便于直接验证150米边界。
修正后Go定向、Web lint/产品/E2E类型检查exit0。
首轮 `web-e2e-WIq4kF` 整套exit1、有头16/17：仅距离显示测试写死149.0米失败，
真实六位坐标入库后的子午线距离显示148.9米。产品149/151米匹配边界、
地图匹配、全部原搜索/恢复/采集均通过。已将显示断言改为按真实返回入库纬度独立计算，
并保留148.8～149.2米范围断言，不放宽150米选择阈值。
首轮Go全量/真实PG、Server/Web构建和秘密扫描通过，测试PG/config已清理。

复跑目录 `web-e2e-4SVxup`，最终完整套件 **17/17、exit0、4.7分钟**；
同轮Go全量/真实隔离PG（含原64并发保存、混合恢复及采集来源保护）、Server/Web构建、
lint 0错误/0警告、秘密扫描通过；最终产品/E2E类型检查exit0。不能将首轮16项当整套通过。
普通用户地图API在隔离空Key配置返回明确502（已通过鉴权，不表示真实图片成功）；
地图有头响应使用明确SYNTHETIC图，Go旧HTTP桩验证真实代理净化/参数。
定位仅独立context能力桩、公开坐标样例，不改系统GPS或读取真实设备位置。
选点两个有头用例断言execute与管理写请求0；另有明确的本机execute拒绝用例验证缺少ID，
没有对外学习通/超星调用。开发真实高德0，不宣称实际定位、地图收录或签到成功。

### 20.3 本轮正式发布与最终核对

新鲜受限备份：`C:\Users\user\AppData\Local\XBT\backups\release-20260925-1510`。
原1415程序、入口、完整配置、lnk及worker备份后，对最新真实PG生成
`xbt-before.dump` 并恢复到独立55433，用新Server33031启动验证七表全部原列指纹保持。
staging静态/代理及秘密扫描通过后，精确停止现场核实的旧API31184/Web28728，
PG22400全程未重启；再取 `xbt-cutover.dump` 及切换时最新指纹，未写或恢复正式库。

新永久程序：`C:\Users\user\AppData\Local\XBT\releases\20260925-1510`，
采用最终通过的4SVxup独立构建。管理器仅1415→1510路径一处变化，
原 `D:\桌面\Tool\学不通签到.lnk` 字节不变。完整配置/Key、worker和PG运行方式保留。
原快捷通过Explorer打开本轮新管理器21248，菜单1启动并打开网页、
重复菜单1同PID、菜单0保留NoExit均实际核对；关闭本轮窗口后服务仍独立存活。
用户已有管理器19908未操作。未执行菜单5，也未为验收执行会停PG的菜单2。

| 15:32最终核对 | 结果 |
| --- | --- |
| 正式地址 / PID | `http://127.0.0.1:38081`；API **31672** / Web **13876** / PG **22400** |
| 数据与指纹 | courses40 / sign_activities4 / sign_locations54含软删 / sign_records2 / user_courses40 / users1 / whitelists1；七表全部原列聚合指纹与切换快照一致 |
| 健康与鉴权 | 3030及38081 health均200/code0；管理/用户地点接口以及用户/管理员两个预览匿名均401 |
| 正式UI及产物 | 首页及两个JS/CSS与新release字节一致，独立空登录页及重定向通过，JS错误0，未输入真实账号 |
| 保密及原入口 | 配置/lnk/worker字节不变，manager仅release变化；Web/exe无实际秘密，配置与备份ACL仅当前用户/SYSTEM |
| 清理 | 两轮合成PG/config及测试Edge已清理；33030/33081/55432/33031/55433/38082无监听；受限真实恢复副本停止保留 |

SHA-256：

```text
Server\xbt-server.exe
376019cc0efa265fe541c71c2ab107bcf1931ab4eee342bbd8c15afb8a3078ee

Web\dist\index.html
47e73bce3edd585e99a60f1ce7c540fab129cca665dab55c45829b166697288b
```

备份内prepare/stage/production/formal-ui/menu/deployment-final等JSON记录实际结果。
`XBT-Manager.rollback.ps1` 指向保留的1415，语法已验证，未激活；回退只回退程序和入口，
不恢复旧数据库/配置、不删除新数据或执行菜单5。1415保留管理员采集功能，但无此次签到页选点扩展。
未改schema、未新增前端Key、未请求真实高德、未对外签到或上传，未碰Android、系统GPS、
防火墙、自启动或用户浏览器会话。真实高德地图和设备定位仍须用户主动使用后核实，不冒称成功。

### 20.4 后续调整：地图确认点直接签到（2026-09-26）

签到页地图确认后直接保存中心十字坐标为本次签到点，不再查询附近启用地点或按150米匹配；
用户仍需在页面点击“立即签到”提交。列表内现场定位的“使用最近地点”行为保持不变，
手动列表选择仍使用已启用地点 ID。

`POST /api/sign/execute` 为地图点位新增 `location_mode:"map_pick"` 与 `map_location`
坐标对象。后端检查位置类型、GCJ-02 标记和坐标范围，不混用 `location_id`、
`device_location`，并以地图坐标构造明确标注“地图选择点”的上游参数，不创建地点。
此模式不证明教师签到范围，且不会自动代替页面的最终签到操作。

### 20.5 地图拖动跟手试验（2026-09-26）

为避免把现有静态地图改成需新增客户端Key的第三方JS SDK，地图图片在拖动时先连续跟手移动，
利用20%图像留边裁切视口，松手后请求新中心图并替换，地图确认坐标仍按原静态地图比例计算。
点击、按钮平移/缩放和后端地图预览API契约不变。地图请求失败会恢复旧图与原中心对齐；
指针取消会复位临时偏移。该方式改善短距离拖动的即时反馈，但仍非真实瓦片式连续地图，
长距离移动时等待新图的刷新感仍存在。
