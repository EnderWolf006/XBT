package amap

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"xbt2/server/internal/config"
	"xbt2/server/internal/geo"
)

type StaticMapClient struct {
	Config  config.AMapConfig
	HTTP    *http.Client
	BaseURL string
}

type MapPreview struct {
	Center           geo.Point `json:"center"`
	Zoom             int       `json:"zoom"`
	CoordinateSystem string    `json:"coordinate_system"`
	ImageData        string    `json:"image_data"`
	CampusReference  bool      `json:"campus_reference"`
}

func NewStaticMapClient(cfg config.AMapConfig, client *http.Client) *StaticMapClient {
	if client == nil {
		client = http.DefaultClient
	}
	return &StaticMapClient{Config: cfg, HTTP: client, BaseURL: "https://restapi.amap.com"}
}

func (c *StaticMapClient) read(ctx context.Context, endpoint string, params url.Values) ([]byte, string, error) {
	if strings.TrimSpace(c.Config.APIKey) == "" {
		return nil, "", errors.New("后端未配置高德服务，仍可手动填写坐标")
	}
	params.Set("key", c.Config.APIKey)
	u := c.BaseURL + endpoint + "?" + params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", errors.New("无法构造地图请求")
	}
	client := *c.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("地图服务不允许重定向") }
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", errors.New("地图服务连接失败或超时，请重试")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", errors.New("地图服务未成功响应，请检查后端配额或权限")
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
	if err != nil || len(body) > 4*1024*1024 {
		return nil, "", errors.New("地图响应读取失败或超过大小限制")
	}
	if bytes.Contains(body, []byte(c.Config.APIKey)) {
		return nil, "", errors.New("地图服务返回了不安全的响应，已拦截")
	}
	return body, resp.Header.Get("Content-Type"), nil
}

func (c *StaticMapClient) Preview(ctx context.Context, center *geo.Point, zoom int) (MapPreview, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	reference := center == nil
	if reference {
		if strings.TrimSpace(c.Config.CampusAddress) == "" {
			return MapPreview{}, errors.New("没有校区视图参考，请先现场定位或输入坐标")
		}
		body, _, err := c.read(ctx, "/v3/geocode/geo", url.Values{"address": {c.Config.CampusAddress}, "output": {"JSON"}})
		if err != nil {
			return MapPreview{}, err
		}
		var result struct {
			Status   string `json:"status"`
			Geocodes []struct {
				Location string `json:"location"`
			} `json:"geocodes"`
		}
		if json.Unmarshal(body, &result) != nil || result.Status != "1" || len(result.Geocodes) != 1 {
			return MapPreview{}, errors.New("校区参考无法唯一定位，请先现场定位或手动输入GCJ-02中心")
		}
		parts := strings.Split(result.Geocodes[0].Location, ",")
		if len(parts) != 2 {
			return MapPreview{}, errors.New("校区参考坐标无效")
		}
		lon, e1 := strconv.ParseFloat(parts[0], 64)
		lat, e2 := strconv.ParseFloat(parts[1], 64)
		p := geo.Point{Latitude: lat, Longitude: lon}
		if e1 != nil || e2 != nil || p.Validate() != nil {
			return MapPreview{}, errors.New("校区参考坐标无效")
		}
		center = &p
	}
	if center.Validate() != nil || center.Latitude <= -85 || center.Latitude >= 85 || zoom < 1 || zoom > 17 {
		return MapPreview{}, errors.New("静态地图中心或缩放级别无效")
	}
	point := center.Rounded()
	params := url.Values{"location": {fmt.Sprintf("%.6f,%.6f", point.Longitude, point.Latitude)}, "zoom": {strconv.Itoa(zoom)}, "size": {"600*400"}, "scale": {"1"}}
	body, contentType, err := c.read(ctx, "/v3/staticmap", params)
	if err != nil {
		return MapPreview{}, err
	}
	if !strings.HasPrefix(contentType, "image/png") && !strings.HasPrefix(contentType, "image/jpeg") {
		return MapPreview{}, errors.New("地图服务未返回图片，请检查后端静态地图权限或配额")
	}
	dimensions, _, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil || dimensions.Width != 600 || dimensions.Height != 400 {
		return MapPreview{}, errors.New("静态地图图片格式或尺寸不符合预期")
	}
	img, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		return MapPreview{}, errors.New("静态地图图片无法解码")
	}
	var clean bytes.Buffer
	if err := png.Encode(&clean, img); err != nil {
		return MapPreview{}, errors.New("地图图片处理失败")
	}
	return MapPreview{Center: point, Zoom: zoom, CoordinateSystem: "GCJ-02", ImageData: "data:image/png;base64," + base64.StdEncoding.EncodeToString(clean.Bytes()), CampusReference: reference}, nil
}
