package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
)

func TestPersonalCoordinatesPresence(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, coordinates := range []string{"", `,"latitude":0`, `,"longitude":0`, `,"latitude":null,"longitude":0`, `,"latitude":0,"longitude":null`, `,"latitude":"","longitude":0`} {
		for _, method := range []string{http.MethodPost, http.MethodPut} {
			h := NewSignLocationHandler(nil)
			router := gin.New()
			router.POST("/locations", h.CreatePersonal)
			router.PUT("/locations/:id", h.UpdatePersonal)
			path := "/locations"
			if method == http.MethodPut {
				path += "/1"
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest(method, path, strings.NewReader(`{"name":"test","address":"test"`+coordinates+`}`))
			request.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("%s %s: got %d", method, coordinates, response.Code)
			}
		}
	}
	for _, coordinates := range []string{`{"latitude":0,"longitude":0}`, `{"latitude":-90,"longitude":-180}`, `{"latitude":90,"longitude":180}`} {
		var input personalLocationRequest
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(coordinates))
		request.Header.Set("Content-Type", "application/json")
		if err := binding.JSON.Bind(request, &input); err != nil {
			t.Fatalf("explicit numeric coordinates should bind: %s: %v", coordinates, err)
		}
	}
}
