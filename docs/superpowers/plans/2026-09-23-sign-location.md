# 签到地点管理与高德候选确认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 Go Server 和 React Web 增加可由管理员确认的高德签到地点管理，并让位置签到通过 `location_id` 使用后端数据库坐标。

**Architecture:** 在 Server 中新增 `SignLocation` 模型、配置和高德 POI client；管理员 API 管理候选地点及启停状态，用户 API 只返回启用地点。现有位置签到请求接收 JSON 顶层 `location_id`，由后端解析为经纬度并注入 `special_params`，Web 使用数据库地点替换现有 `config.yaml` 中的固定坐标。制定计划时部署目录没有 Android；2026-09-24 第二轮已恢复公开 WebView 壳，复用 Web 地点业务，来源及验证结果见交接文档。

**Tech Stack:** Go 1.27、Gin、GORM、PostgreSQL、React 19、TypeScript、Vite、Axios、Tailwind CSS、YAML 配置。

## Global Constraints

- 永久数据目录 `C:\Users\user\AppData\Local\XBT` 不得删除或修改。
- 高德 API Key 只能由 Go Server 读取，不能进入 Web 构建产物或客户端请求。
- 搜索结果为未保存的临时候选；明确保存后初始状态必须是 `pending`，管理员另行启用后才能变为 `enabled`。
- 用户签到请求使用顶层 `location_id`，后端不能信任客户端直接提交的纬度和经度。
- 不增加用户与地点之间的距离校验。
- 非位置签到类型必须保持现有行为。
- 删除地点采用软删除，不能破坏历史数据引用。
- 当前 `C:\Users\user\AppData\Local\Temp\XBT-Deploy`、`Server`、`Web` 均不是 Git 仓库，不能执行真实 commit；每个任务仍需保留可复现的验证命令和变更记录。

2026-09-24 校正：真实浏览器测试发现原 Task 5 把 ID 放入 `special_params` 的示例与 DTO 不符；本计划中的示例现统一为顶层 `location_id`。下方原任务复选框保留计划历史，实际完成状态以交接文档最新章节为准。

---

### Task 1: 建立签到地点模型、迁移和配置结构

**Files:**
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\model\models.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\db\db.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\config\config.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\config.yaml`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\config_example.yaml`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\init.sql`
- Test: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\model\models_test.go`

**Interfaces:**
- Produces `model.SignLocation` with fields `ID`, `Name`, `Address`, `Latitude`, `Longitude`, `AMAPPoiID`, `Status`, `Source`, `CreatedAt`, `UpdatedAt`, `DeletedAt`.
- Produces `config.Config.AMap` with `APIKey` and `CampusAddress`.
- Uses statuses `pending`, `enabled`, `disabled` and sources `amap`, `manual`, `config`.

- [ ] **Step 1: Write the failing model/config tests**

```go
func TestSignLocationHasStableStatuses(t *testing.T) {
    if SignLocationPending != "pending" || SignLocationEnabled != "enabled" || SignLocationDisabled != "disabled" {
        t.Fatalf("unexpected sign location statuses")
    }
}

func TestConfigLoadsAMapFields(t *testing.T) {
    raw := []byte("amap:\n  api_key: test-key\n  campus_address: test-campus\n")
    var cfg Config
    if err := yaml.Unmarshal(raw, &cfg); err != nil { t.Fatal(err) }
    if cfg.AMap.APIKey != "test-key" || cfg.AMap.CampusAddress != "test-campus" { t.Fatalf("unexpected amap config: %#v", cfg.AMap) }
}
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server`:

```powershell
go test ./internal/model ./internal/config
```

Expected: FAIL because the new model constants and `Config.AMap` do not exist.

- [ ] **Step 3: Add the model and configuration types**

Add a GORM soft-delete model with decimal-safe `float64` coordinates and indexes/unique constraints for `amap_poi_id`. Add YAML fields:

```go
type AMapConfig struct {
    APIKey       string `yaml:"api_key"`
    CampusAddress string `yaml:"campus_address"`
}
```

Add `AMap AMapConfig `yaml:"amap"`` to `Config`, and define `SignLocationPending`, `SignLocationEnabled`, and `SignLocationDisabled` constants.

- [ ] **Step 4: Register migration and SQL schema**

Add `&model.SignLocation{}` to `db.New` `AutoMigrate`. Add a matching `CREATE TABLE IF NOT EXISTS sign_locations` block to `init.sql`, including a partial/usable uniqueness strategy for POI IDs and indexes on status/deleted state. Keep the SQL compatible with PostgreSQL already used by the project.

- [ ] **Step 5: Add safe config examples**

Add an empty `amap` block to both config files. Do not place a real key in source or generated frontend files. Set the local `config.yaml` campus address to the verified school address and leave `api_key` empty unless an existing secure deployment value is already present.

- [ ] **Step 6: Run tests and compile the Server**

```powershell
go test ./internal/model ./internal/config
 go test ./...
```

Expected: PASS. If the database is unavailable, separate pure package tests from integration startup verification and report the unavailable dependency instead of changing the permanent data directory.

---

### Task 2: Implement the high-level AMap POI client

**Files:**
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\amap\client.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\amap\client_test.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\config\config.go`

**Interfaces:**
- Produces `amap.Client.SearchPOI(ctx context.Context, keywords string) ([]amap.POI, error)`.
- `amap.POI` contains `Name`, `Address`, `Latitude`, `Longitude`, and `POIID`.
- Consumes `config.AMap.APIKey` and `config.AMap.CampusAddress`.

- [ ] **Step 1: Write parser tests before HTTP implementation**

Test valid JSON, missing key, provider error, malformed location, duplicate POI records, and empty keyword. Use an injectable `http.Client` or `RoundTripper` so tests do not call the real AMap service.

```go
func TestParsePOIResponse(t *testing.T) {
    body := []byte(`{"status":"1","pois":[{"id":"p1","name":"第一教学楼","address":"江淮校区","location":"114.100000,32.100000"}]}`)
    got, err := parsePOIResponse(body)
    if err != nil { t.Fatal(err) }
    if len(got) != 1 || got[0].Latitude != 32.1 || got[0].Longitude != 114.1 { t.Fatalf("unexpected result: %#v", got) }
}
```

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
go test ./internal/amap -run 'TestParsePOIResponse|TestSearchPOI' -v
```

Expected: FAIL because the package and parser do not exist.

- [ ] **Step 3: Implement the AMap client**

Call the AMap Web Service POI text search endpoint from the Server only. Require a non-empty API key and campus address. Use `context.Context`, a 10-second request timeout, URL encoding, `keywords` defaulting to `教学楼` only at the handler boundary, and parse `location` as `longitude,latitude`. Reject coordinates outside longitude `[-180,180]` or latitude `[-90,90]`. Convert provider errors into messages safe for the administrator UI without returning the API key.

- [ ] **Step 4: Deduplicate and make result ordering stable**

Deduplicate by non-empty POI ID; for records without an ID use normalized name/address/coordinate as the key. Sort by name then address so repeated searches produce stable UI ordering.

- [ ] **Step 5: Run package tests**

```powershell
go test ./internal/amap -v
```

Expected: PASS without network access or real credentials.

---

### Task 3: Add location service and administrator/user handlers

**Files:**
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\service\sign_location.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\handler\sign_location.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\service\sign_location_test.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\handler\sign_location_test.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\cmd\server\main.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\API.md`

**Interfaces:**
- `SignLocationService.List(ctx, status string) ([]model.SignLocation, error)`.
- `SignLocationService.ListEnabled(ctx) ([]model.SignLocation, error)`.
- `SignLocationService.Create(input CreateSignLocationInput) (model.SignLocation, error)`.
- `SignLocationService.Update(id uint, input UpdateSignLocationInput) error`.
- `SignLocationService.SetStatus(id uint, status string) error`.
- `SignLocationService.SoftDelete(id uint) error`.
- 2026-09-25 调整：`SignLocationService.SearchCandidates(ctx, amap.SearchQuery) ([]SignLocationCandidate, error)` 只读；`SaveCandidate(ctx, SignLocationCandidate) (SaveCandidateResult, error)` 才持久保存。并发唯一冲突回归转移到明确保存操作，保留原 64 路/63 次真实冲突断言。
- `SignLocationHandler` exposes admin CRUD/search and authenticated enabled-list endpoints.

- [ ] **Step 1: Write service tests for validation and status transitions**

Cover: valid coordinates, invalid latitude/longitude, empty name/address, valid status transitions, invalid status, duplicate AMap POI ID, soft-deleted records excluded from enabled list, and idempotent candidate search.

```go
func TestValidateSignLocationRejectsInvalidCoordinates(t *testing.T) {
    err := validateSignLocation(CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 91, Longitude: 114})
    if err == nil { t.Fatal("expected invalid latitude error") }
}
```

- [ ] **Step 2: Run service tests and verify failure**

```powershell
go test ./internal/service -run SignLocation -v
```

Expected: FAIL because the service types and methods do not exist.

- [ ] **Step 3: Implement the service**

Use GORM queries scoped to `deleted_at IS NULL`. Store AMap candidates as `pending`. On candidate import, use `amap_poi_id` when available for idempotency; otherwise use normalized name/address/coordinates. Enabling must be an explicit service operation. Soft delete sets `DeletedAt` and makes the record unavailable to both admin default results and user results.

- [ ] **Step 4: Implement handlers and bind routes**

Add:

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

Use existing `middleware.Auth` and `middleware.AdminOnly`. Return project-standard `common.Success`/`common.Fail` responses. Validate JSON payloads and path IDs. Never serialize the AMap API key.

- [ ] **Step 5: Add API documentation**

Document request/response JSON, statuses, candidate confirmation semantics, errors, and the `location_id` contract in `Server/API.md`.

- [ ] **Step 6: Run Server tests**

```powershell
go test ./internal/service ./internal/handler ./...
```

Expected: PASS.

---

### Task 4: Route location IDs into position-sign execution

**Files:**
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\dto\types.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\handler\sign.go`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\service\sign.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\service\sign_location_mapping_test.go`

**Interfaces:**
- `dto.SignExecuteRequest.LocationID uint `json:"location_id"``.
- `SignService.ResolveLocationSpecial(locationID uint, existing map[string]interface{}) (map[string]interface{}, error)`.
- Existing non-location `special_params` behavior remains unchanged.

- [ ] **Step 1: Write failing mapping tests**

Cover: location sign with enabled location injects stored `latitude`, `longitude`, and `description`; pending/disabled/deleted/nonexistent IDs fail; non-location sign does not require a location ID; client-supplied latitude/longitude are overwritten or rejected for location signs.

```go
func TestLocationSignUsesStoredCoordinates(t *testing.T) {
    got, err := resolveLocationSpecial(enabledLocation(), map[string]interface{}{"latitude": "0"})
    if err != nil { t.Fatal(err) }
    if got["latitude"] != "32.1" || got["longitude"] != "114.1" { t.Fatalf("unexpected special params: %#v", got) }
}
```

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
go test ./internal/service -run LocationSpecial -v
```

Expected: FAIL because location resolution is not implemented.

- [ ] **Step 3: Implement server-side coordinate resolution**

For `sign_type == xxt.SignLocation`, require a positive `location_id`, query only enabled/non-deleted records, and construct the location special map from database values. Ignore client latitude, longitude, and description values. For all other sign types, preserve current request behavior and do not require `location_id`.

- [ ] **Step 4: Keep代签 behavior consistent**

Resolve the selected location once per request and use the same verified location for the target user. Do not allow each client-side retry to change coordinates. Keep existing record and retry semantics unchanged.

- [ ] **Step 5: Run all Server tests and build**

```powershell
go test ./...
go build ./cmd/server
```

Expected: PASS and a successful Server build.

---

### Task 5: Add Web types, API calls, and dynamic user location selection

**Files:**
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\types\index.ts`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\pages\SignDetail.tsx`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\components\sign\LocationInput.tsx`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\config.yaml`

**Interfaces:**
- Add `SignLocation { id:number; name:string; address:string; latitude:number; longitude:number; status?:string }`.
- `SignDetail` loads `GET /sign/locations` and stores `selectedLocation: SignLocation | null`.
- Position sign requests send `location_id`, not client-controlled coordinate fields.

- [ ] **Step 1: Update type definitions and add focused UI tests if test tooling exists**

If the project has no component test dependency, use TypeScript compile/build as the focused regression check and add pure helper tests only if an existing test runner is present. The required type contract is:

```ts
export interface SignLocation {
  id: number;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  status?: string;
}
```

- [ ] **Step 2: Replace fixed config presets for position signing**

Remove runtime use of `LOCATION_PRESETS` for `sign_type === 4`. Keep unrelated config fields intact. Load enabled locations on the sign detail page, display loading/empty/error states, and default to no selection so a user must explicitly choose a location.

- [ ] **Step 3: Update the location picker UI**

Render server locations with `id`, `name`, and `address`. The selected state compares `selectedLocation.id`. Do not display or allow editing of raw coordinates in the normal user UI.

- [ ] **Step 4: Submit only `location_id` for position signs**

Remove the client-coordinate assignments from `special_params`:

```ts
special_params.latitude = lat;
special_params.longitude = lng;
special_params.description = locationStr;
```

Send the selected ID at the top level of the `/sign/execute` JSON body instead:

```ts
{
  // Other existing request fields remain unchanged.
  location_id: activity.sign_type === 4 ? selectedLocation?.id : undefined,
  special_params
}
```

Keep the existing validation, retry, cancellation, classmate selection, and progress UI behavior.

- [ ] **Step 5: Run Web checks**

Run from `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web`:

```powershell
npm run lint
npm run build
```

Expected: PASS. Confirm the generated `dist` output contains no AMap API key or `api_key` value.

---

### Task 6: Build the Web administrator location management page

**Files:**
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\pages\SignLocations.tsx`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\App.tsx`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\pages\Lobby.tsx` or the existing admin navigation location discovered during implementation
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\src\types\index.ts`

**Interfaces:**
- Page consumes the admin endpoints from Task 3.
- Page displays `pending`, `enabled`, and `disabled` records and never treats a pending record as selectable for users.

- [ ] **Step 1: Implement list and status filter UI**

Add loading, empty, error, and status filter states. Display name, address, source, POI ID where available, and status.

- [ ] **Step 2: Implement automatic and keyword POI search**

Provide a default “搜索教学楼” action and a keyword input/action. Show candidates returned by the server as pending records. Disable repeated submission while searching and show server error messages through the existing toast pattern.

- [ ] **Step 3: Implement confirmation and CRUD actions**

Add explicit buttons for enable, disable, edit, manual create, and soft delete. Require confirmation before delete. Refresh the list after every mutation. Validate name/address/coordinate fields before manual submission.

- [ ] **Step 4: Register a protected admin route**

Add `/admin/sign-locations` under the existing protected route tree. Reuse existing admin authentication behavior and match the current mobile-first visual style.

- [ ] **Step 5: Run Web checks**

```powershell
npm run lint
npm run build
```

Expected: PASS with no new TypeScript or ESLint errors.

---

### Task 7: Add configuration import and operational documentation

**Files:**
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\config\config.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\internal\service\sign_location_import.go`
- Create: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\locations.example.yaml`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\API.md`
- Modify: `C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server\config_example.yaml`

**Interfaces:**
- Config supports an optional `sign_locations` list with name, address, latitude, longitude, optional POI ID, and status/source defaults.
- Import is idempotent and does not overwrite administrator-edited values.

- [ ] **Step 1: Write import idempotency tests**

Cover first import, repeated import, duplicate POI ID, duplicate fallback identity, invalid coordinates, and preservation of an existing enabled/admin-edited record.

- [ ] **Step 2: Implement import service**

On startup or explicit initialization, validate all rows before writing. Use `source=config`, default status `pending` unless explicitly and safely configured otherwise, and upsert only records identified as config-owned. Never touch existing rows with `source=manual` or `source=amap` after administrator changes.

- [ ] **Step 3: Add example without real secrets**

Document the format and include example school building placeholders only as examples; do not insert unverified real teaching-building coordinates.

- [ ] **Step 4: Run tests and document operations**

```powershell
go test ./...
```

Document how to set `amap.api_key`, run a candidate search, confirm a location, and preserve `C:\Users\user\AppData\Local\XBT` during deployment.

---

### Task 8: End-to-end verification and deployment-safe handoff

**Files:**
- Modify only files required by previous tasks.
- Do not modify: `C:\Users\user\AppData\Local\XBT`.

- [ ] **Step 1: Run complete Server verification**

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Server
go test ./...
go build ./cmd/server
```

Expected: all tests pass and the Server binary builds.

- [ ] **Step 2: Run complete Web verification**

```powershell
Set-Location C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web
npm run lint
npm run build
```

Expected: lint and production build pass.

- [ ] **Step 3: Verify secret non-leakage**

```powershell
Select-String -Path C:\Users\user\AppData\Local\Temp\XBT-Deploy\Web\dist\* -Pattern 'amap.api_key|api_key|restapi.amap.com' -CaseSensitive:$false
```

Expected: no matches containing a real key or backend AMap endpoint in the Web bundle.

- [ ] **Step 4: Verify runtime API behavior**

With PostgreSQL and the Server running:

```powershell
Invoke-WebRequest http://127.0.0.1:3030/api/health
```

Then manually verify: admin can search candidates; candidates are pending; enable makes a location appear in `GET /api/sign/locations`; Web position sign requires a selected location; disabled/deleted locations fail; non-location signs still work.

- [ ] **Step 5: Review final diff and deployment boundary**

Because no Git repository is present, inspect changed files using the file list and compare against this plan. Confirm no generated scratch files, real API keys, database dumps, or changes under `C:\Users\user\AppData\Local\XBT` were added. Record the actual Android source/build/device status from the latest handoff; the original missing-source limitation was superseded by recovery of the public WebView shell on 2026-09-24.

---

## Self-review checklist

- [x] Spec coverage: data model, AMap POI search, pending confirmation, CRUD, config import, user `location_id`, Web admin, Web user selection, security, soft delete, errors, and tests each have tasks.
- [x] Placeholder scan: no unfinished implementation placeholder is used as a substitute for an action.
- [x] Type consistency: `SignLocation`, `location_id`, `SignLocationService`, AMap client, status constants, and route names are consistent across tasks.
- [x] Scope check: Android was not silently treated as available; the plan records the missing directory and preserves the shared API contract.
- [x] Deployment safety: the permanent data directory is explicitly excluded from all tasks.
