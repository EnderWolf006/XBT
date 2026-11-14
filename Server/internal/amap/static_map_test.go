package amap

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"xbt2/server/internal/config"
	"xbt2/server/internal/geo"
)

func TestStaticMapProxyCenterAndCampusReference(t *testing.T) {
	const key = "synthetic-map-secret-only-upstream"
	var requests []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("key") != key {
			t.Error("Key应仅服务端发送上游")
		}
		requests = append(requests, r.URL.Path)
		switch r.URL.Path {
		case "/v3/geocode/geo":
			if r.URL.Query().Get("address") != "合成校园参考" {
				t.Error("校区参考参数错误")
			}
			_, _ = w.Write([]byte(`{"status":"1","geocodes":[{"location":"116.4041234,39.9151234"}]}`))
		case "/v3/staticmap":
			q := r.URL.Query()
			if q.Get("location") != "116.404123,39.915123" || q.Get("zoom") != "16" || q.Get("size") != "600*400" || q.Get("scale") != "1" {
				t.Error("请求必须与服务端回显中心一致")
			}
			w.Header().Set("Content-Type", "image/png")
			_ = png.Encode(w, image.NewRGBA(image.Rect(0, 0, 600, 400)))
		default:
			t.Error("非预期上游路径")
		}
	}))
	defer srv.Close()
	c := NewStaticMapClient(config.AMapConfig{APIKey: key, CampusAddress: "合成校园参考"}, srv.Client())
	c.BaseURL = srv.URL
	result, err := c.Preview(context.Background(), nil, 16)
	if err != nil || !result.CampusReference || result.Center.Latitude != 39.915123 || result.Center.Longitude != 116.404123 {
		t.Fatalf("参考预览错误: %v", err)
	}
	if len(requests) != 2 {
		t.Fatal("初始参考仅地理编码+静态图2次请求")
	}
	raw, _ := json.Marshal(result)
	if bytes.Contains(raw, []byte(key)) || !strings.HasPrefix(result.ImageData, "data:image/png;base64,") {
		t.Fatal("仅返回净化图片，不返回上游含Key URL")
	}
	point := result.Center
	result, err = c.Preview(context.Background(), &point, 16)
	if err != nil || result.CampusReference || len(requests) != 3 {
		t.Fatal("已有中心不可重复地理编码")
	}
}

func TestStaticMapFailuresDoNotLeakKeyOrURL(t *testing.T) {
	const key = "synthetic-sensitive-map-key"
	for _, kind := range []string{"json", "secret-echo", "redirect", "bad-image", "transport"} {
		t.Run(kind, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				switch kind {
				case "secret-echo":
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write([]byte(key))
				case "redirect":
					w.Header().Set("Location", "/redirected")
					w.WriteHeader(302)
				case "bad-image":
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write([]byte("not-an-image"))
				default:
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"status":"0","info":"INVALID_USER_KEY"}`))
				}
			}))
			defer srv.Close()
			c := NewStaticMapClient(config.AMapConfig{APIKey: key}, srv.Client())
			c.BaseURL = srv.URL
			if kind == "transport" {
				c.HTTP = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
					return nil, &url.Error{Op: "Get", URL: "https://restapi.amap.com/?key=" + key, Err: context.DeadlineExceeded}
				})}
			}
			result, err := c.Preview(context.Background(), &geo.Point{Latitude: 39, Longitude: 116}, 16)
			if err == nil || result.ImageData != "" || strings.Contains(err.Error(), key) || strings.Contains(err.Error(), "https://") {
				t.Fatal("上游失败不应泄露Key/URL或伪装地图成功")
			}
			if kind == "redirect" && calls != 1 {
				t.Fatal("不能跟随上游重定向")
			}
		})
	}
}
