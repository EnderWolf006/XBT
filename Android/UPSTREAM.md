# Android 源码恢复与本地验证

- 公开上游：<https://github.com/EnderWolf006/XBT>
- 固定提交：`fb15ac0f1a19a2e7b5e238b1eeb15d4056df96fc`
- 恢复日期：2026-09-24
- 范围：仅恢复原先缺失的 `Android` 目录；未覆盖本地 Server、Web 或任何永久数据。
- 许可：上游根 `LICENSE` 为 GNU GPL v3，原文保留在本目录 `LICENSE`。Android 子目录未发现另外的许可证。上游 README 的 Private 徽章与公开仓库及 LICENSE 描述不一致，不能把徽章当作未开源的证据。

## 与签到地点功能的关系

`MainActivity.kt` 是 WebView + CameraX 原生壳，从 `R.string.target_url` 加载远程 Web，启用 JavaScript 和 DOM storage；没有单独的原生地点 API 或地点 UI，也没有内置 Web 业务包。地点列表、管理员管理、选择与顶层 `location_id` 提交均复用本地 Web 实现，不应重复实现一套 Kotlin 业务逻辑。没有替换现有部署。第三轮失败记录见交接第 13 节；第四轮已修复相机初始化异常，并在自建、已清理的无相机实例取得真实 WebView 地点及释放的分层证据，详见第 14 节。统一设备脚本非单次全绿，不称为全套 E2E 通过。

`XBTCameraBridge.takePhoto()` 的真实协议为返回 void，稍后派发 `xbt-native-photo` 自定义事件，其 `detail.base64` 为照片数据。Web 浏览器回归应保留此事件形状测试，不能只测试 Promise 返回值。

## 本地资源调整

上游将 `app/src/main/res/values/strings.xml` 加入 `.gitignore`，但保留了位于资源目录内、会实际参与编译的 `strings_example.xml`（包含示例外部域名）。因此不是 Java/Kotlin 源码缺失，而是运行配置未提交。

为避免构建或测试默认访问不明外部服务：

- 将示例移至 `config\strings_example.xml`，避免重复资源并使示例不参与编译。
- 新建主资源 `strings.xml`，默认 `target_url=about:blank`；release 没有可用部署目标，发布前必须显式配置合法的 Web 地址。
- 新建 debug 专用资源，目标 `http://10.0.2.2:33081/` 仅用于 Android 模拟器访问宿主隔离 Web。宿主测试结束后此地址不可用，不是生产地址，也不适用于未经设置的真机。

不要把服务端高德 Key、数据库连接或账号密码放入 Android 资源。保留上游清单、release 目标及 `arm64-v8a` ABI 限制；`analyzeQrFrame` 的局部 CameraX opt-in 解决过实际 lint 阻断。第四轮另修复初始化异常、可见错误和视图释放，未关闭 lint、未通用重构相机业务。是否能在 x86 模拟器安装取决于镜像的 ABI/翻译支持，不能只凭 x86 标签推断。

## 构建

本机已有 JDK 21、Android SDK `D:\Android\Sdk`（含平台 36）和 Gradle 8.13 缓存。仅在构建进程设置 `ANDROID_HOME` / `ANDROID_SDK_ROOT`；不要为本次测试修改系统环境或自动接受 SDK 许可证。

```powershell
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
.\gradlew.bat --offline --no-daemon --max-workers=2 -Pandroid.builder.sdkDownload=false :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

实际构建结果、阻塞及完整验证记录见 `..\docs\superpowers\handoff\2026-09-24-sign-location-handoff.md`。上游的样例单元测试不是地点功能验收，桌面浏览器原生桥模拟也不等于 Android 真机测试。

## 相机修复与设备证据（2026-09-24）

第三轮确认了无可用 CameraX 相机时，`providerFuture.get()` 未处理异常导致主线程崩溃。第四轮新增 `CameraInitialization.kt`，处理失败/取消/中断，关闭后忽略晚回调、不取消共享 Future；通过实际 `AndroidView.onRelease` 释放控制器和 WebView。原生中文提示明确相机不可用，但不阻断非相机 WebView 业务。

新增 8 项持久单测，加原样例共 **9 项通过**；离线构建通过，lint **0 errors / 37 warnings**。当前 Debug APK 大小 19,325,469 bytes，SHA256：

```text
D4229899C6469FEF60A14BD5D57C1F86266E2E57F096F3214662EE29D03F69D5
```

此哈希替代第二轮产物的旧哈希，文件仍位于 `app\build\outputs\apk\debug\app-debug.apk`。

同一临时 Android 36.1 实例明确报告 0 个相机，新 APK 安装成功；实际确认中文错误可见、应用不因该异常退出、真实 WebView 可操作合成地点。显式 DevTools socket 转发加公开 `noDefaults: true` 选项解决了默认桌面 CDP 下载管理命令不受支持的问题。旧 WebView 在 `NEW_TASK | CLEAR_TASK` 结束旧 Activity/新建任务的独立断言中关闭，不等同于配置变化 recreate；晚回调由持久化单测覆盖。

地点 CRUD、选择、顶层 ID 和隔离网关 403 有分层证据，但统一设备脚本非一次全绿，失败日志与界面呈现问题如实保留。活动/预检/同学数据为合成，执行请求未转发。没有物理真机、正常相机扫码/拍照或真实签到验证。所有测试设置（包括停用 GMS）仅作用于已删除的自建副本，没有使用宿主 webcam 或原 AVD 用户数据。完整命令、截图与边界见交接第 14 节。

## 持久统一设备入口（第五轮）

从 `Web` 目录运行 `npm run test:android`，依赖与环境变量见
`..\Web\e2e\README.md`。入口包含新鲜隔离 Go/PostgreSQL、Web lint/build、
Android 离线构建与 `testDebugUnitTest --rerun`、专用只读无相机 AVD、
真实 DevTools 连接、原生确认框操作和最终清理，不依赖会话脚本。

第五轮实际重跑 9 项 JVM 测试通过，Android lint 0 errors / 37 warnings，
APK 哈希保持上值。Web 10 项和运行器辅助 8 项回归通过。
但最终统一设备运行 `cpYg1p` 在真实 WebView 连接后，被模拟器系统
`System UI isn't responding` 弹窗遮挡，相机提示可见性断言失败，整套 exit 1；
没有跳过断言或再次冷启动。后续地点/原生确认框/释放的统一断言未执行。
完整失败、清理修复及已清除资源记录见交接第 15 节。
