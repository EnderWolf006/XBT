package com.github.enderwolf006.xbt

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.Image
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color as ComposeColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.github.enderwolf006.xbt.ui.theme.XBTTheme
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        filePathCallback?.onReceiveValue(uris.toTypedArray())
        filePathCallback = null
    }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { isGranted ->
        if (!isGranted) {
            Toast.makeText(this, "需要相机权限以支持扫描或拍摄", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
        )

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }

        setContent {
            XBTTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = ComposeColor.Transparent
                ) {
                    MainScreen(
                        onShowFileChooser = { callback ->
                            filePathCallback = callback
                            fileChooserLauncher.launch("image/*")
                        },
                        onRequestCameraPermission = {
                            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                        },
                    )
                }
            }
        }
    }
}

private class NativeCameraPunchController(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
    private val previewView: PreviewView,
    private val webView: WebView,
    private val hasCameraPermission: () -> Boolean,
    private val requestCameraPermission: () -> Unit,
) {
    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var isScannerActive = false
    private var requestedFacing = CameraSelector.LENS_FACING_BACK
    private val mainHandler = Handler(Looper.getMainLooper())
    private val bindRunnable = Runnable { bindCamera() }
    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val barcodeScanner = BarcodeScanning.getClient()
    private var lastQrPayload = ""
    private var lastQrEmitAt = 0L
    @Volatile private var lastCameraActive = false
    @Volatile private var lastCameraError = ""

    init {
        previewView.visibility = View.GONE
        previewView.scaleType = PreviewView.ScaleType.FILL_CENTER
        previewView.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        previewView.setBackgroundColor(AndroidColor.BLACK)

        webView.addJavascriptInterface(JsBridge(), "XBTCameraBridge")

        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener(
            {
                cameraProvider = providerFuture.get()
                if (isScannerActive) {
                    scheduleBind()
                }
            },
            ContextCompat.getMainExecutor(context)
        )
    }

    fun onDestroy() {
        mainHandler.removeCallbacks(bindRunnable)
        cameraProvider?.unbindAll()
        previewView.visibility = View.GONE
        barcodeScanner.close()
        cameraExecutor.shutdown()
    }

    private fun scheduleBind() {
        mainHandler.removeCallbacks(bindRunnable)
        // 合并连续的激活/切换镜头请求，避免重复重绑造成黑帧。
        mainHandler.post(bindRunnable)
    }

    private fun bindCamera() {
        val provider = cameraProvider ?: return
        if (!isScannerActive) {
            provider.unbindAll()
            previewView.visibility = View.GONE
            return
        }
        if (!hasCameraPermission()) {
            previewView.visibility = View.GONE
            emitCameraState(false, "no-camera-permission")
            requestCameraPermission()
            return
        }

        val selector = CameraSelector.Builder()
            .requireLensFacing(requestedFacing)
            .build()

        val preview = Preview.Builder().build().also {
            it.surfaceProvider = previewView.surfaceProvider
        }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
            .also { imageAnalysis ->
                imageAnalysis.setAnalyzer(cameraExecutor) { imageProxy ->
                    analyzeQrFrame(imageProxy)
                }
            }

        runCatching {
            provider.unbindAll()
            camera = provider.bindToLifecycle(lifecycleOwner, selector, preview, analysis)
            previewView.visibility = View.VISIBLE
            emitCameraState(true, null)
        }.onFailure {
            if (requestedFacing == CameraSelector.LENS_FACING_FRONT) {
                requestedFacing = CameraSelector.LENS_FACING_BACK
                bindCamera()
            } else {
                previewView.visibility = View.GONE
                val detail = "${it.javaClass.simpleName}:${it.message ?: "bind-failed"}"
                emitCameraState(false, detail)
            }
        }
    }

    private fun setScannerActive(active: Boolean) {
        if (isScannerActive == active) {
            return
        }
        isScannerActive = active
        if (!active) {
            emitCameraState(false, "inactive")
        }
        scheduleBind()
    }

    private fun setLensFacing(mode: String?) {
        val targetFacing = if (mode.equals("user", ignoreCase = true)) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        if (requestedFacing == targetFacing) {
            return
        }
        requestedFacing = targetFacing
        if (isScannerActive) {
            scheduleBind()
        }
    }

    private fun applyPinchDelta(rawDelta: Float): Float {
        val cam = camera ?: return 1f
        val zoomState = cam.cameraInfo.zoomState.value ?: return 1f
        val current = zoomState.zoomRatio
        val target = (current + rawDelta).coerceIn(zoomState.minZoomRatio, zoomState.maxZoomRatio)
        cam.cameraControl.setZoomRatio(target)
        return target
    }

    private fun analyzeQrFrame(imageProxy: ImageProxy) {
        val image = imageProxy.image
        if (image == null) {
            imageProxy.close()
            return
        }
        val inputImage = InputImage.fromMediaImage(image, imageProxy.imageInfo.rotationDegrees)
        barcodeScanner.process(inputImage)
            .addOnSuccessListener { barcodes ->
                emitFirstQr(barcodes)
            }
            .addOnCompleteListener {
                imageProxy.close()
            }
    }

    private fun emitFirstQr(barcodes: List<Barcode>) {
        val qrText = barcodes.firstOrNull { it.rawValue?.isNotBlank() == true }?.rawValue ?: return
        val now = System.currentTimeMillis()
        if (qrText == lastQrPayload && now - lastQrEmitAt < 700L) return
        lastQrPayload = qrText
        lastQrEmitAt = now

        val escaped = qrText
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "")

        val js = """
            (function() {
                window.dispatchEvent(new CustomEvent('xbt-native-qr', { detail: { text: '$escaped' } }));
            })();
        """.trimIndent()

        webView.post {
            webView.evaluateJavascript(js, null)
        }
    }

    private fun emitCameraState(active: Boolean, error: String?) {
        lastCameraActive = active
        lastCameraError = error ?: ""
        val safeError = (error ?: "")
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", " ")
            .replace("\r", " ")
        val js = """
            (function() {
                window.dispatchEvent(new CustomEvent('xbt-native-camera-state', { detail: { active: ${if (active) "true" else "false"}, error: '$safeError' } }));
            })();
        """.trimIndent()
        webView.post {
            webView.evaluateJavascript(js, null)
        }
    }

    private inner class JsBridge {
        @JavascriptInterface
        fun isReady(): Boolean = true

        @JavascriptInterface
        fun getCameraState(): String {
            val safeError = lastCameraError
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", " ")
                .replace("\r", " ")
            return """{"active":${if (lastCameraActive) "true" else "false"},"error":"$safeError"}"""
        }

        @JavascriptInterface
        fun setScannerActive(active: Boolean) {
            webView.post { this@NativeCameraPunchController.setScannerActive(active) }
        }

        @JavascriptInterface
        fun setLensFacing(mode: String?) {
            webView.post { this@NativeCameraPunchController.setLensFacing(mode) }
        }

        @JavascriptInterface
        fun zoomByPinchDelta(delta: Float): Float {
            var result = 1f
            val latch = CountDownLatch(1)
            webView.post {
                result = applyPinchDelta(delta)
                latch.countDown()
            }
            latch.await(120, TimeUnit.MILLISECONDS)
            return result
        }

        @JavascriptInterface
        fun syncPunchHole(left: Float, top: Float, width: Float, height: Float) {
            // 当前扫码页视频区域是全屏，先保留参数用于后续扩展：
            // 当视频区域不是全屏时，可基于这里做原生遮罩裁切。
            webView.post {
                previewView.visibility = if (isScannerActive) View.VISIBLE else View.GONE
            }
        }
    }
}

private data class WebShellHolder(
    val webView: WebView,
    val cameraController: NativeCameraPunchController,
)

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MainScreen(
    onShowFileChooser: (ValueCallback<Array<Uri>>) -> Unit,
    onRequestCameraPermission: () -> Unit,
) {
    val context = LocalContext.current
    val url = context.getString(R.string.target_url)
    val exitMessage = context.getString(R.string.exit_press_again)

    var webView: WebView? by remember { mutableStateOf(null) }
    var lastBackPressTime by remember { mutableLongStateOf(0L) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var loadProgress by remember { mutableIntStateOf(0) }

    // 控制状态
    var isFirstLoadComplete by remember { mutableStateOf(false) }
    var isMainFrameVisualReady by remember { mutableStateOf(false) }
    var mainFrameVisualReadyAt by remember { mutableLongStateOf(0L) }
    var isManualRefresh by remember { mutableStateOf(false) }
    var showLoadingScreen by remember { mutableStateOf(true) }
    var splashEntered by remember { mutableStateOf(false) }
    var splashExiting by remember { mutableStateOf(false) }
    var splashShownAt by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val splashExitDurationMs = 360
    val splashOverlayAlpha by animateFloatAsState(
        targetValue = if (showLoadingScreen && splashEntered) 1f else 0f,
        animationSpec = tween(durationMillis = 260, easing = FastOutSlowInEasing),
        label = "splash-overlay-alpha"
    )
    val splashWaveProgress by animateFloatAsState(
        targetValue = if (splashExiting) 1f else 0f,
        animationSpec = tween(
            durationMillis = splashExitDurationMs,
            easing = CubicBezierEasing(0.4f, 0f, 1f, 1f)
        ),
        label = "splash-wave"
    )
    // 防止出场动画起始帧“漏底”：前段保持全遮罩，随后再开始擦除。
    val splashRevealProgress = ((splashWaveProgress - 0.08f) / 0.92f).coerceIn(0f, 1f)
    val splashExitFadeAlpha = if (splashExiting) {
        val t = ((splashRevealProgress - 0.45f) / 0.55f).coerceIn(0f, 1f)
        val eased = t * t * (3f - 2f * t)
        1f - eased * 0.5f
    } else {
        1f
    }
    val splashMaxArcDepthPx = with(LocalDensity.current) { 120.dp.toPx() }

    LaunchedEffect(showLoadingScreen) {
        if (showLoadingScreen) {
            splashEntered = false
            kotlinx.coroutines.delay(16L)
            splashEntered = true
        } else {
            splashEntered = false
        }
    }

    // Web 加载中显示启动页；最短显示 0.5s 后播放出场动画。
    LaunchedEffect(isFirstLoadComplete, isManualRefresh) {
        if (errorMessage != null) {
            showLoadingScreen = false
            splashEntered = false
            splashExiting = false
            return@LaunchedEffect
        }

        if (!isFirstLoadComplete) {
            if (!showLoadingScreen) {
                showLoadingScreen = true
                splashShownAt = System.currentTimeMillis()
            }
            splashExiting = false
            return@LaunchedEffect
        }

        if (showLoadingScreen) {
            val elapsed = System.currentTimeMillis() - splashShownAt
            val minStay = 600L
            if (elapsed < minStay) {
                kotlinx.coroutines.delay(minStay - elapsed)
            }
            val visualStableElapsed = System.currentTimeMillis() - mainFrameVisualReadyAt
            val minVisualStable = 100L
            if (visualStableElapsed < minVisualStable) {
                kotlinx.coroutines.delay(minVisualStable - visualStableElapsed)
            }
            splashExiting = true
            kotlinx.coroutines.delay(splashExitDurationMs.toLong())
            showLoadingScreen = false
            splashExiting = false
        }
    }

    val density = context.resources.displayMetrics.density
    val statusBarHeight = remember {
        val resourceId = context.resources.getIdentifier("status_bar_height", "dimen", "android")
        if (resourceId > 0) context.resources.getDimensionPixelSize(resourceId) / density else 0f
    }
    val navigationBarHeight = remember {
        val resourceId = context.resources.getIdentifier("navigation_bar_height", "dimen", "android")
        if (resourceId > 0) context.resources.getDimensionPixelSize(resourceId) / density else 0f
    }

    BackHandler {
        val currentWebView = webView
        if (errorMessage != null) {
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastBackPressTime < 2000) {
                (context as? ComponentActivity)?.finish()
            } else {
                lastBackPressTime = currentTime
                Toast.makeText(context, exitMessage, Toast.LENGTH_SHORT).show()
            }
        } else if (currentWebView != null && currentWebView.canGoBack()) {
            currentWebView.goBack()
        } else {
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastBackPressTime < 2000) {
                (context as? ComponentActivity)?.finish()
            } else {
                lastBackPressTime = currentTime
                Toast.makeText(context, exitMessage, Toast.LENGTH_SHORT).show()
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                val root = FrameLayout(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                    // 避免应用启动首帧 WebView 尚未绘制时出现黑屏闪烁
                    setBackgroundColor(AndroidColor.rgb(255, 250, 251))
                }

                val preview = PreviewView(ctx).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                }

                val innerWebView = object : WebView(ctx) {
                    private var hasCancelledByMultiTouch = false

                    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
                        val pointers = ev.pointerCount
                        if (pointers >= 3) {
                            if (!hasCancelledByMultiTouch) {
                                val cancelEvent = MotionEvent.obtain(ev)
                                cancelEvent.action = MotionEvent.ACTION_CANCEL
                                super.dispatchTouchEvent(cancelEvent)
                                cancelEvent.recycle()
                                hasCancelledByMultiTouch = true
                            }
                            // 吞掉三指及以上触摸，避免 WebView 状态机被系统手势打乱
                            return true
                        }

                        when (ev.actionMasked) {
                            MotionEvent.ACTION_DOWN,
                            MotionEvent.ACTION_UP,
                            MotionEvent.ACTION_CANCEL -> hasCancelledByMultiTouch = false
                        }
                        return super.dispatchTouchEvent(ev)
                    }
                }.apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )

                    webViewClient = object : WebViewClient() {
                        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                            super.onPageStarted(view, url, favicon)
                            errorMessage = null
                            loadProgress = 0
                            isMainFrameVisualReady = false
                            mainFrameVisualReadyAt = 0L
                        }

                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            loadProgress = 100
                            val js = """
                                (function() {
                                    document.documentElement.style.setProperty('--sat', '${statusBarHeight}px');
                                    document.documentElement.style.setProperty('--sab', '${navigationBarHeight}px');
                                    document.documentElement.style.setProperty('--spacing-safe-top', '${statusBarHeight}px');
                                    document.documentElement.style.setProperty('--spacing-safe-bottom', '${navigationBarHeight}px');
                                })();
                            """.trimIndent()
                            view?.evaluateJavascript(js, null)

                            // 只有当 WebView 首帧已提交到渲染管线后，才允许启动页退出。
                            if (view != null) {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                    view.postVisualStateCallback(
                                        System.nanoTime(),
                                        object : WebView.VisualStateCallback() {
                                            override fun onComplete(requestId: Long) {
                                                // 再等 2 帧，规避 release 包偶发首帧纹理提交抖动
                                                view.postOnAnimation {
                                                    view.postOnAnimation {
                                                        isMainFrameVisualReady = true
                                                        mainFrameVisualReadyAt = System.currentTimeMillis()
                                                        isFirstLoadComplete = true
                                                    }
                                                }
                                            }
                                        }
                                    )
                                } else {
                                    view.post {
                                        isMainFrameVisualReady = true
                                        mainFrameVisualReadyAt = System.currentTimeMillis()
                                        isFirstLoadComplete = true
                                    }
                                }
                            }
                        }

                        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                            super.onReceivedError(view, request, error)
                            if (request?.isForMainFrame == true) {
                                errorMessage = "加载失败: ${error?.description}"
                                isFirstLoadComplete = true
                            }
                        }
                    }

                    webChromeClient = object : WebChromeClient() {
                        override fun onProgressChanged(view: WebView?, newProgress: Int) {
                            loadProgress = newProgress
                            if (newProgress >= 100 && isMainFrameVisualReady) {
                                isFirstLoadComplete = true
                            }
                        }

                        override fun onPermissionRequest(request: PermissionRequest) {
                            request.grant(request.resources)
                        }

                        override fun onShowFileChooser(webView: WebView?, filePathCallback: ValueCallback<Array<Uri>>?, fileChooserParams: FileChooserParams?): Boolean {
                            filePathCallback?.let { onShowFileChooser(it) }
                            return true
                        }
                    }

                    overScrollMode = View.OVER_SCROLL_NEVER
                    setBackgroundColor(AndroidColor.TRANSPARENT)

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        loadWithOverviewMode = true
                        useWideViewPort = true
                        setSupportZoom(true)
                        builtInZoomControls = false
                        displayZoomControls = false
                        mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                        mediaPlaybackRequiresUserGesture = false
                        cacheMode = WebSettings.LOAD_NO_CACHE
                    }

                    setInitialScale(0)
                    loadUrl(url)
                    webView = this
                }

                NativeCameraPunchController(
                    context = ctx,
                    lifecycleOwner = context as LifecycleOwner,
                    previewView = preview,
                    webView = innerWebView,
                    hasCameraPermission = {
                        ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                    },
                    requestCameraPermission = onRequestCameraPermission,
                ).also { cameraController ->
                    root.tag = WebShellHolder(
                        webView = innerWebView,
                        cameraController = cameraController,
                    )
                }

                root.addView(preview)
                root.addView(innerWebView)
                root
            },
            update = {
                val holder = (it as? FrameLayout)?.tag as? WebShellHolder
                if (holder != null) {
                    webView = holder.webView
                }
            }
        )

        // 顶端进度条
        if (loadProgress < 100 && errorMessage == null) {
            LinearProgressIndicator(
                progress = { loadProgress / 100f },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(2.dp)
                    .align(Alignment.TopCenter),
                color = MaterialTheme.colorScheme.primary,
                trackColor = ComposeColor.Transparent
            )
        }

        // 全屏加载界面
        if (showLoadingScreen && errorMessage == null) {
            Surface(
                modifier = Modifier
                    .fillMaxSize()
                    .drawWithCache {
                        val maskPath = androidx.compose.ui.graphics.Path()
                        onDrawWithContent {
                            val drawScope = this
                            if (splashRevealProgress <= 0f) {
                                drawScope.drawContent()
                                return@onDrawWithContent
                            }
                            val width = size.width
                            val height = size.height
                            val progress = splashRevealProgress
                            val centerX = width / 2f
                            val edgeY = height * progress
                            val arcDepth = splashMaxArcDepthPx * (1f - 0.4f * progress)

                            maskPath.reset()
                            maskPath.moveTo(0f, edgeY)
                            maskPath.quadraticTo(centerX, edgeY + arcDepth, width, edgeY)
                            maskPath.lineTo(width, height)
                            maskPath.lineTo(0f, height)
                            maskPath.close()

                            clipPath(maskPath) {
                                drawScope.drawContent()
                            }
                        }
                    }
                    .graphicsLayer {
                        alpha = splashOverlayAlpha * splashExitFadeAlpha
                    },
                color = ComposeColor(0xFFFFFAFB)
            ) {
                Box(modifier = Modifier.fillMaxSize()) {
                    Column(
                        modifier = Modifier
                            .align(Alignment.Center)
                            .padding(horizontal = 24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Image(
                            painter = painterResource(id = R.mipmap.ic_launcher),
                            contentDescription = "学不通 2.0",
                            modifier = Modifier.size(168.dp)
                        )
                    }
                    Text(
                        text = "学不通 2.0",
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .padding(bottom = 36.dp),
                        style = MaterialTheme.typography.titleMedium,
                        color = ComposeColor(0xFF6B7280)
                    )
                }
            }
        }

        // 错误界面
        if (errorMessage != null) {
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = MaterialTheme.colorScheme.background
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.Warning,
                        contentDescription = "Error",
                        modifier = Modifier.size(64.dp),
                        tint = MaterialTheme.colorScheme.error
                    )
                    Spacer(modifier = Modifier.height(16.dp))
                    Text(
                        text = "页面迷路了",
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.onBackground
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage ?: "未知错误",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center
                    )
                    Spacer(modifier = Modifier.height(24.dp))
                    Button(onClick = {
                        errorMessage = null
                        loadProgress = 0
                        isFirstLoadComplete = false
                        isMainFrameVisualReady = false
                        mainFrameVisualReadyAt = 0L
                        isManualRefresh = true // 手动刷新，触发直接显示动画
                        webView?.reload()
                    }) {
                        Text("重新加载")
                    }
                }
            }
        }
    }
}
