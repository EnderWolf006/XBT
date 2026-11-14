# 隔离签到地点回归

本目录入口直接保存在项目内，不依赖某个 Copilot 会话脚本。

## 环境与运行

Windows，需要已有 Node/npm、Go、PostgreSQL 18 的命令行工具和 Web 依赖。
桌面测试使用已安装的 Microsoft Edge。Android 另需 JDK 21、项目 Gradle
缓存、Android SDK 的 adb/emulator/build-tools，以及已安装的
`system-images\android-36.1\google_apis_playstore\x86_64` 镜像。
运行器不会下载 SDK、镜像或 Gradle 依赖；缺失时明确失败。

在 `Web` 目录运行：

```powershell
$env:XBT_E2E_ARTIFACTS = "$env:TEMP\XBT-E2E-artifacts"
$env:ANDROID_HOME = "D:\Android\Sdk"
npm run test:e2e:helpers
npm run test:e2e
npm run test:android
```

`XBT_E2E_ARTIFACTS` 必须是绝对路径，每次生成唯一 `web-e2e-*` 子目录。
可用 `XBT_POSTGRES_BIN` 指定 PostgreSQL bin（默认
`C:\Program Files\PostgreSQL\18\bin`），用 `XBT_ANDROID_SYSTEM_IMAGE`
指定 SDK 内另一条**已有镜像相对路径**；该设备测试预期支持 APK 的 arm64 ABI。
不应直接运行 `android-device.mjs`，其环境与隔离资源由运行器提供。

只验证当前候选搜索改进和紧密相关的原 CRUD/权限/地点选择，可使用有头 Edge：

```powershell
$env:XBT_E2E_ARTIFACTS = "$env:TEMP\XBT-candidate-validation"
$env:XBT_E2E_HEADED = '1'
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交'
```

有头模式使用独立 Edge context、650ms slowMo，关键候选结果至少停留 2.2 秒并截图。
屏幕底部明确标注隔离验证：账号和高德返回为合成内容，不获取用户已登录会话。
搜索 UI 返回由浏览器路由模拟；明确保存、列表、编辑、启停、删除和用户可选 API
使用真实隔离 Server/PG。Go 隔离集成另外直接验证搜索不写库及保存并发冲突，
高德客户端以本机 HTTP 测试服务器核对校区/完整名称参数和有界请求，不调用真实高德。

新增候选用例覆盖连续搜索替换且库不变、保存为 pending 和管理区 ID 高亮、
已存在内容/启用状态保护、乱序/空结果/失败/长度错误清空旧结果、来源/坐标、
候选 API 显式坐标验证及已删记录不恢复。另有保存响应晚于新查询的回归，
保证上一查询的保存状态不会标到新候选上。不能把合成 POI 测试声称为现实楼栋覆盖率。

后续软删除恢复回归同属 `候选` 选择器：真实保存/编辑/软删的合成地点触发结构化409，
卡片显示旧字段；连续取消5次恢复不发送写请求、不堆toast，确认恢复旧ID为pending并
定位，明确启用后重复恢复不降级。直接API补充确认缺失/非法ID/404/非管理员403；
模拟普通409（即使含“已删除”中文字样）及网络失败不能误显示恢复入口。
Go PG测试额外覆盖恢复/保存混合并发与唯一冲突事务回滚。
`query_keywords` 的页面展示和后端实际构造词有精确断言；没有用真实高德搜索验证命中率。

现场定位与地图取点定向回归：

```powershell
$env:XBT_E2E_HEADED = '1'
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交|坐标采集|地图中心'
```

浏览器定位成功/拒绝/超时仅在独立测试context使用明确的能力桩，公开北京坐标用于验证
WGS-84→GCJ-02契约，不修改系统GPS，不读取用户实际位置、不宣称物理设备定位已验证。
坐标转换预览和保存走真实隔离Server/PG；地图UI使用醒目标为SYNTHETIC的图及受控响应，
Go HTTP测试另行验证官方请求参数、服务端平移、图片净化和Key/URL不回传。
覆盖拒绝重试仍单条行内错误、51米警告、50米边界（Go）、名称必填、确认前不填坐标/不写库、
平移/缩放重新确认、GCJ-02/时间/来源、保存pending及新来源POI清空；
各采集/地图UI用例断言没有签到执行请求。新增PG子用例验证预览前后总记录数不变、
重新采集已启用地点必须pending，原搜索/恢复并发用例同轮继续执行。
本轮开发不调用真实高德，地图覆盖不代表真实楼栋收录、教师范围或签到成功。

位置签到页选点扩展（保留上述全部回归）：

```powershell
npm run test:e2e -- --grep '候选|管理员真实 CRUD|普通用户|用户选择只提交|坐标采集|地图中心|签到选点|用户无地点'
```

新用例覆盖149米可匹配、151米不匹配、空集不造点、非enabled过滤及距离排序；
普通用户坐标预览200，地图在隔离空Key配置下返回明确502（说明已通过登录鉴权进入处理器，
不表示真实地图加载通过），匿名401、管理写和管理列表403。
缺少顶层 `location_id` 的本机execute请求，即使携带客户端坐标/嵌套ID也被拒绝；
Go无DB/无外部客户端的单测证明该拒绝发生在外部访问之前。

有头选点流程只用独立context能力桩、明确合成地图 SDK 及真实隔离地点：
列表定位拒绝可重试、按距离排序但不自动选中；签到页交互地图拖动过程连续更新中心，确认后直接保存为本次签到坐标，
不请求或匹配附近启用地点，执行请求只包含 `location_mode:"map_pick"` 与确认的
`map_location`。地图“回到目前位置”拒绝不乱跳、成功使用服务端转换点、缩放清确认。
只选择但未执行签到的UI用例断言execute请求0、管理写请求0。
不修改系统GPS、不获取实际设备地理位置、不调用真实高德或学习通。
管理员静态地图的拖动用例仍验证指针移动期间图像跟手平移；签到地图由隔离 SDK 桩验证
交互式地图中心在连续拖动时更新。E2E 不调用真实高德，真实 JS API Key 白名单、
服务器安全代理及实际设备瓦片加载仍需部署配置后单独验收。

需要空闲的 55432、33030、33081 端口，Android 另需 5556/5557。
不允许并发运行这两个完整入口；端口被占用时失败，不停止占用者。

## 测试与边界

两个完整入口均创建独立 PostgreSQL 数据目录，执行新鲜 Go 全量/真实数据库
测试、Server 构建、Web 全量 lint/build 及敏感配置扫描，再使用隔离 Web。
不会覆盖 `Web\dist` 或部署的 Server，不访问永久 XBT 目录、生产库或原 AVD
用户盘。账号、课程、活动均为合成数据，测试凭据不能用于真实签到。

Android 入口先离线执行 `assembleDebug testDebugUnitTest --rerun lintDebug`，保留并重跑既有
9 项 JVM 单测及 release ABI；从已有系统镜像生成专用 AVD，禁用此临时设备的
GMS、相机、音频和快照，安装测试 APK。只操作核对名称匹配的自建设备，
不会安装到物理设备或覆盖已有同包应用。

设备的 HTTP 代理仅允许隔离站点；网关拒绝外部域名、HTTPS CONNECT、高德查询、
照片上传及真实签到执行。活动、同学、预检在网关返回合成结果，所有设备
`sign/execute` 都返回完整 403，验证页面实际显示拒绝原因与“失败”，并记录
转发计数为零。该测试不代表真实外部签到成功。

设备断言覆盖无相机不崩溃/中文提示、管理员新增编辑筛选启停删除、用户选择、
顶层 `location_id`、网关拒绝反馈、真实原生确认框取消与确认，以及
`NEW_TASK|CLEAR_TASK` 后旧 WebView 的 close/isClosed。最后一项是结束旧
Activity/新建任务，**不是**配置变化 recreate。

CDP 使用实际 PID 的 `webview_devtools_remote_<pid>`，先检查 DevTools HTTP，
再用公开 `noDefaults:true` 连接一次。账号切换后 reload。确认框由当前测试 App
的原生 Cancel/OK 按钮处理，不使用会遗留原生框的 CDP dialog.accept()。

## 超时、产物与清理

工作整体预算 30 分钟，记录于 `run-budget.json`，每步取自身上限与剩余预算的较小值。
期限到后仍执行独立限时的 finally 清理，不继续启动新的测试工作。
一般准备命令上限 180 秒，Android Gradle 600 秒；模拟器仅单轮冷启动，
上限 12 分钟（现有 API 36.1 镜像曾需数分钟首次初始化），每个 ADB 命令
5–60 秒，完整设备断言 300 秒。超时失败，不自动重复冷启动。

`commands.log`、`android-system.log`、`android-tests.log`、`test-results`、
环境/APK 哈希、网关计数及独立构建产物保留以便诊断。`android-run-state.json`
保留当前阶段、模拟器退出码、原始失败及附加清理错误，不以清理失败覆盖首因。
GMS 修改只在 `boot_completed` 后执行，启动期只读 ADB 暂时离线可在期限内等待。
不保存真实凭据；
合成临时配置、数据库和自建 AVD 在 finally 中移除。进程按本次启动的
PID/父子关系停止，删除数据之前确认清理成功；归属不明或无法停止时保留数据
并明确报错，不按进程名杀进程，也不删除其他会话资源。

若设备中出现系统 ANR 或非测试 App 的弹窗，不可通过宽泛点击“确定/等待”
或删断言制造成功，应保留原生 UI、错误和阶段记录，报告环境失败。

2026-09-24 最新验收：Web 10 项、辅助 8 项、Android JVM 9 项通过；统一设备
入口尚未一次完整通过。最后受控运行已安装并连接真实 WebView，但系统
`System UI isn't responding` 框遮挡了相机提示，断言失败即终止。
原生确认取消/确认及后续设备断言不能因此标记为通过，详见项目交接第 15 节。
