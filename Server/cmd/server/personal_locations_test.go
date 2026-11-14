package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPersonalModeBlocksLegacyManagement(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, path := range []string{"", "/candidates", "/123", "/123/restore", "/123/enable", "/123/disable",
		"/search", "/search-map", "/coordinate-preview", "/map-preview"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
			router := gin.New()
			group := router.Group("/api/admin/sign-locations", personalLocationGuard)
			group.Handle(method, path, func(c *gin.Context) { c.Status(http.StatusNoContent) })
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(method, "/api/admin/sign-locations"+path, nil))
			expected := http.StatusForbidden
			switch path {
			case "/search", "/search-map", "/coordinate-preview", "/map-preview":
				expected = http.StatusNoContent
			}
			if response.Code != expected {
				t.Fatalf("%s %s: got %d, want %d", method, path, response.Code, expected)
			}
		}
	}
}
