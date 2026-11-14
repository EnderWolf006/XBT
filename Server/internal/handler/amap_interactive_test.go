package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/config"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestAMapInteractiveProxyKeepsSecurityCodeServerSide(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewAMapInteractiveHandler(config.AMapConfig{JSAPIKey: "public-key", SecurityJSCode: "server-only"})
	var upstream *http.Request
	handler.client = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		upstream = req
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}, nil
	})}

	router := gin.New()
	router.GET("/config", handler.Config)
	router.GET("/api/amap-service/:grant/*path", handler.Proxy)
	configResponse := httptest.NewRecorder()
	router.ServeHTTP(configResponse, httptest.NewRequest(http.MethodGet, "/config", nil))
	if configResponse.Code != http.StatusOK || strings.Contains(configResponse.Body.String(), "server-only") {
		t.Fatalf("map config exposed server security code or failed: %s", configResponse.Body.String())
	}
	var response struct {
		Data struct {
			APIKey      string `json:"key"`
			ServicePath string `json:"service_path"`
		} `json:"data"`
	}
	if err := json.Unmarshal(configResponse.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.APIKey != "public-key" || !strings.HasPrefix(response.Data.ServicePath, "/api/amap-service/") {
		t.Fatalf("unexpected browser map config: %+v", response.Data)
	}
	request := httptest.NewRequest(http.MethodGet, response.Data.ServicePath+"/v3/geocode/geo?key=attacker&jscode=attacker", nil)
	proxyResponse := httptest.NewRecorder()
	router.ServeHTTP(proxyResponse, request)
	if proxyResponse.Code != http.StatusOK || strings.Contains(proxyResponse.Body.String(), "server-only") {
		t.Fatalf("proxy response failed or exposed secret: %s", proxyResponse.Body.String())
	}
	if upstream == nil || upstream.URL.Host != "restapi.amap.com" ||
		upstream.URL.Query().Get("key") != "public-key" || upstream.URL.Query().Get("jscode") != "server-only" {
		t.Fatalf("proxy did not constrain upstream credentials: %#v", upstream)
	}
}

func TestAMapInteractiveProxyRejectsInvalidGrantAndPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewAMapInteractiveHandler(config.AMapConfig{JSAPIKey: "public-key", SecurityJSCode: "server-only"})
	router := gin.New()
	router.GET("/api/amap-service/:grant/*path", handler.Proxy)
	for _, path := range []string{
		"/api/amap-service/not-issued/v3/geocode/geo",
		"/api/amap-service/not-issued/v3/../../config",
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusForbidden {
			t.Fatalf("invalid map proxy request was accepted: path=%q status=%d", path, response.Code)
		}
	}
}

func TestAMapInteractiveProxyBlocksCredentialEcho(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewAMapInteractiveHandler(config.AMapConfig{JSAPIKey: "public-key", SecurityJSCode: "server-only"})
	handler.client = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"error":"server-only"}`))}, nil
	})}
	router := gin.New()
	router.GET("/config", handler.Config)
	router.GET("/api/amap-service/:grant/*path", handler.Proxy)
	configResponse := httptest.NewRecorder()
	router.ServeHTTP(configResponse, httptest.NewRequest(http.MethodGet, "/config", nil))
	var response struct {
		Data struct {
			ServicePath string `json:"service_path"`
		} `json:"data"`
	}
	if err := json.Unmarshal(configResponse.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	proxyResponse := httptest.NewRecorder()
	router.ServeHTTP(proxyResponse, httptest.NewRequest(http.MethodGet, response.Data.ServicePath+"/v3/geocode/geo", nil))
	if proxyResponse.Code != http.StatusBadGateway || strings.Contains(proxyResponse.Body.String(), "server-only") {
		t.Fatalf("proxy returned an upstream credential echo: %s", proxyResponse.Body.String())
	}
}
