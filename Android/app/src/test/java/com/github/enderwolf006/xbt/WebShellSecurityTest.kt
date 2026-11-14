package com.github.enderwolf006.xbt

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebShellSecurityTest {
    @Test
    fun geolocationAllowsHttpsAndLocalhostOnly() {
        assertTrue(isTrustedGeolocationOrigin("https://example.com"))
        assertTrue(isTrustedGeolocationOrigin("http://127.0.0.1:38081"))
        assertTrue(isTrustedGeolocationOrigin("http://localhost:38081"))

        assertFalse(isTrustedGeolocationOrigin("http://192.168.1.8:38081"))
        assertFalse(isTrustedGeolocationOrigin("http://10.0.2.2:33081"))
        assertFalse(isTrustedGeolocationOrigin("about:blank"))
        assertFalse(isTrustedGeolocationOrigin(null))
    }
}
