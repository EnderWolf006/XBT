package com.github.enderwolf006.xbt

import java.util.concurrent.CancellationException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Future

internal const val CAMERA_UNAVAILABLE_MESSAGE =
    "相机不可用，请检查相机或权限后重新打开应用。扫码和拍照暂不可用，其他功能仍可使用。"

internal class CameraInitialization<T>(
    private val onReady: (T) -> Unit,
    private val onUnavailable: (String, Throwable) -> Unit,
) {
    @Volatile
    var isClosed = false
        private set

    var error: String? = null
        private set

    fun complete(future: Future<T>) {
        if (isClosed) return
        val provider = try {
            future.get()
        } catch (exception: ExecutionException) {
            fail(exception.cause ?: exception)
            return
        } catch (exception: CancellationException) {
            fail(exception)
            return
        } catch (exception: InterruptedException) {
            Thread.currentThread().interrupt()
            fail(exception)
            return
        }
        if (!isClosed) onReady(provider)
    }

    fun fail(cause: Throwable) {
        if (isClosed) return
        error = CAMERA_UNAVAILABLE_MESSAGE
        onUnavailable(CAMERA_UNAVAILABLE_MESSAGE, cause)
    }

    fun close() {
        // ProcessCameraProvider 的 Future 是共享的，释放本控制器不能取消其他使用者的初始化。
        isClosed = true
    }
}
