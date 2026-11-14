package handler

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/amap"
	"xbt2/server/internal/geo"
)

type captureMapStub struct{ center geo.Point }

func (s *captureMapStub) Preview(_ context.Context, p *geo.Point, z int) (amap.MapPreview, error) {
	if p != nil {
		s.center = *p
	}
	return amap.MapPreview{Center: s.center, Zoom: z, CoordinateSystem: "GCJ-02", ImageData: "data:image/png;base64,synthetic"}, nil
}

func TestCoordinatePreviewNoDatabaseDependency(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := NewLocationCaptureHandler(nil)
	r := gin.New()
	r.POST("/preview", h.CoordinatePreview)
	for _, accuracy := range []string{"50", "50.01"} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/preview", strings.NewReader(`{"latitude":39.915,"longitude":116.404,"accuracy":`+accuracy+`,"captured_at":"2026-09-25T06:00:00Z"}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var body struct {
			Data struct {
				Point geo.Point `json:"point"`
				Poor  bool      `json:"poor_accuracy"`
			} `json:"data"`
		}
		if json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Data.Point.Longitude != 116.410244 || body.Data.Poor != (accuracy != "50") {
			t.Fatal("坐标或精度阈值错误")
		}
	}
	for _, input := range []string{`{}`, `{"latitude":91,"longitude":116,"accuracy":1,"captured_at":"2026-09-25T06:00:00Z"}`, `{"latitude":39,"longitude":116,"accuracy":-1,"captured_at":"2026-09-25T06:00:00Z"}`} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/preview", strings.NewReader(input))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Fatal("非法预览请求未拒绝")
		}
	}
}

func TestMapPreviewReturnsServerMovedCenter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	stub := &captureMapStub{}
	h := NewLocationCaptureHandler(stub)
	r := gin.New()
	r.POST("/map", h.MapPreview)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/map", strings.NewReader(`{"center":{"latitude":0,"longitude":0},"zoom":17,"direction":"east","meters":100}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != 200 || stub.center.Longitude != 0.000898 || stub.center.Latitude != 0 {
		t.Fatal("平移应发生在服务器且回显实际请求中心")
	}
}
