package handler

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/config"
)

const (
	mapGrantTTL      = 30 * time.Minute
	mapGrantMaxCalls = 3000
	mapGrantMaxBytes = 96 * 1024 * 1024
	mapGrantMaxCount = 4096
	mapProxyMaxBody  = 8 * 1024 * 1024
)

var amapPathPattern = regexp.MustCompile(`^/v[0-9]+/[A-Za-z0-9_./-]+$`)

type amapMapGrant struct {
	expiresAt time.Time
	calls     int
	bytes     int64
}

type AMapInteractiveHandler struct {
	cfg    config.AMapConfig
	client *http.Client
	mu     sync.Mutex
	grants map[string]amapMapGrant
}

func NewAMapInteractiveHandler(cfg config.AMapConfig) *AMapInteractiveHandler {
	return &AMapInteractiveHandler{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		grants: make(map[string]amapMapGrant),
	}
}

func (h *AMapInteractiveHandler) Config(c *gin.Context) {
	if strings.TrimSpace(h.cfg.JSAPIKey) == "" || strings.TrimSpace(h.cfg.SecurityJSCode) == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": 1, "message": "交互地图尚未完成服务器端配置"})
		return
	}
	grantBytes := make([]byte, 24)
	if _, err := rand.Read(grantBytes); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 1, "message": "无法初始化交互地图"})
		return
	}
	grant := hex.EncodeToString(grantBytes)
	now := time.Now()
	h.mu.Lock()
	for key, value := range h.grants {
		if now.After(value.expiresAt) {
			delete(h.grants, key)
		}
	}
	if len(h.grants) >= mapGrantMaxCount {
		h.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, gin.H{"code": 1, "message": "交互地图服务繁忙，请稍后重试"})
		return
	}
	h.grants[grant] = amapMapGrant{expiresAt: now.Add(mapGrantTTL)}
	h.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "ok", "data": gin.H{
		"key": h.cfg.JSAPIKey, "service_path": "/api/amap-service/" + grant,
	}})
}

func (h *AMapInteractiveHandler) Proxy(c *gin.Context) {
	if c.Request.Method != http.MethodGet || strings.TrimSpace(h.cfg.SecurityJSCode) == "" {
		c.JSON(http.StatusForbidden, gin.H{"code": 1, "message": "地图服务请求无效"})
		return
	}
	path := c.Param("path")
	if !amapPathPattern.MatchString(path) || strings.Contains(path, "..") || strings.Contains(path, "//") {
		c.JSON(http.StatusForbidden, gin.H{"code": 1, "message": "地图服务路径不允许"})
		return
	}
	grant := strings.TrimPrefix(c.Param("grant"), "/")
	now := time.Now()
	h.mu.Lock()
	value, exists := h.grants[grant]
	if exists && now.Before(value.expiresAt) && value.calls < mapGrantMaxCalls {
		value.calls++
		h.grants[grant] = value
	} else {
		exists = false
		delete(h.grants, grant)
	}
	h.mu.Unlock()
	if !exists {
		c.JSON(http.StatusForbidden, gin.H{"code": 1, "message": "地图服务授权已失效，请重新打开地图"})
		return
	}

	host := "https://restapi.amap.com"
	if strings.HasPrefix(path, "/v4/map/styles") {
		host = "https://webapi.amap.com"
	}
	query := c.Request.URL.Query()
	query.Set("key", h.cfg.JSAPIKey)
	query.Set("jscode", h.cfg.SecurityJSCode)
	target := host + path + "?" + query.Encode()
	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, target, nil)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": 1, "message": "地图服务请求无法构造"})
		return
	}
	response, err := h.client.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"code": 1, "message": "地图服务暂时不可用，请重试"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"code": 1, "message": "地图服务未成功响应"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, mapProxyMaxBody+1))
	if err != nil || len(body) > mapProxyMaxBody {
		c.JSON(http.StatusBadGateway, gin.H{"code": 1, "message": "地图服务响应超过大小限制"})
		return
	}
	h.mu.Lock()
	value, exists = h.grants[grant]
	if !exists || time.Now().After(value.expiresAt) || value.bytes+int64(len(body)) > mapGrantMaxBytes {
		delete(h.grants, grant)
		h.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, gin.H{"code": 1, "message": "交互地图流量额度已用尽，请重新打开地图"})
		return
	}
	value.bytes += int64(len(body))
	h.grants[grant] = value
	h.mu.Unlock()
	if (h.cfg.JSAPIKey != "" && bytes.Contains(body, []byte(h.cfg.JSAPIKey))) ||
		bytes.Contains(body, []byte(h.cfg.SecurityJSCode)) {
		c.JSON(http.StatusBadGateway, gin.H{"code": 1, "message": "地图服务返回了不安全的响应，已拦截"})
		return
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Header("Cache-Control", "private, max-age=300")
	c.Data(http.StatusOK, contentType, body)
}
