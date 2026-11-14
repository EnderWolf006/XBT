package com.github.enderwolf006.xbt

import java.util.concurrent.CompletableFuture
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class CameraInitializationTest {
    @Test
    fun successfulInitializationDeliversProviderWithoutError() {
        var ready: String? = null
        var message: String? = null
        val initialization = CameraInitialization<String>(
            { ready = it },
            { error, _ -> message = error },
        )
        initialization.complete(CompletableFuture.completedFuture("provider"))
        assertEquals("provider", ready)
        assertNull(message)
        assertNull(initialization.error)
    }

    @Test
    fun failedFutureDoesNotEscapeAndPublishesVisibleActionableError() {
        val failure = IllegalStateException("no available camera")
        val future = CompletableFuture<String>().apply { completeExceptionally(failure) }
        var message = ""
        var reported: Throwable? = null
        val initialization = CameraInitialization<String>(
            { fail("Failed initialization must not bind a camera") },
            { error, cause -> message = error; reported = cause },
        )
        initialization.complete(future)
        assertTrue(message.contains("相机不可用"))
        assertTrue(message.contains("其他功能仍可使用"))
        assertEquals(message, initialization.error)
        assertSame(failure, reported)
    }

    @Test
    fun cancelledFutureReportsUnavailableInsteadOfPretendingReady() {
        var message: String? = null
        val future = CompletableFuture<String>().apply { cancel(false) }
        val initialization = CameraInitialization<String>(
            { fail("Cancelled initialization must not bind a camera") },
            { error, _ -> message = error },
        )
        initialization.complete(future)
        assertEquals(CAMERA_UNAVAILABLE_MESSAGE, message)
    }

    @Test
    fun interruptionIsPreservedAndReported() {
        var reported: Throwable? = null
        val initialization = CameraInitialization<String>(
            { fail("Interrupted initialization must not bind a camera") },
            { _, cause -> reported = cause },
        )
        try {
            initialization.complete(FakeFuture { throw InterruptedException("interrupted") })
            assertTrue(Thread.currentThread().isInterrupted)
            assertTrue(reported is InterruptedException)
        } finally {
            Thread.interrupted()
        }
    }

    @Test
    fun closingIgnoresLateCompletionWithoutCancellingSharedFuture() {
        val future = CompletableFuture<String>()
        val initialization = CameraInitialization<String>(
            { fail("Disposed controller must not receive provider") },
            { _, _ -> fail("Disposed controller must not publish errors") },
        )
        initialization.close()
        assertFalse(future.isCancelled)
        initialization.complete(FakeFuture { fail("Must not read future after close"); "" })
        future.complete("provider")
        initialization.complete(future)
        assertTrue(initialization.isClosed)
    }

    @Test
    fun closingDuringCompletionPreventsLateReadyCallback() {
        val initialization = CameraInitialization<String>(
            { fail("Late completion must not bind a camera") },
            { _, _ -> fail("Unexpected error") },
        )
        initialization.complete(FakeFuture { initialization.close(); "provider" })
    }

    @Test
    fun failureAfterCloseDoesNotUpdateVisibleState() {
        val initialization = CameraInitialization<String>(
            { fail("Unexpected success") },
            { _, _ -> fail("Disposed controller must not update UI") },
        )
        initialization.close()
        initialization.fail(IllegalStateException("late failure"))
        assertNull(initialization.error)
    }

    @Test(expected = IllegalArgumentException::class)
    fun unexpectedProgrammingErrorsAreNotSwallowed() {
        val initialization = CameraInitialization<String>({}, { _, _ -> fail("Unexpected catch") })
        initialization.complete(FakeFuture { throw IllegalArgumentException("unexpected") })
    }

    private class FakeFuture<T>(private val read: () -> T) : Future<T> {
        override fun get(): T = read()
        override fun get(timeout: Long, unit: TimeUnit): T = read()
        override fun cancel(mayInterruptIfRunning: Boolean) = false
        override fun isCancelled() = false
        override fun isDone() = true
    }
}
