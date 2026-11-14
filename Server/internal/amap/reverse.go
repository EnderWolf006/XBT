package amap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"xbt2/server/internal/geo"
)

func (c *Client) ReverseAddress(ctx context.Context, point geo.Point) (string, error) {
	if err := point.Validate(); err != nil {
		return "", err
	}
	if strings.TrimSpace(c.Config.APIKey) == "" {
		return "", errors.New("amap api key is required")
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	query := url.Values{
		"key": {c.Config.APIKey}, "location": {fmt.Sprintf("%.6f,%.6f", point.Longitude, point.Latitude)},
		"extensions": {"base"}, "radius": {"100"}, "output": {"JSON"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://restapi.amap.com/v3/geocode/regeo?"+query.Encode(), nil)
	if err != nil {
		return "", errors.New("create amap reverse request failed")
	}
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", errors.New("amap reverse request failed or timed out")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("amap reverse http status %d", resp.StatusCode)
	}
	var body struct {
		Status    string `json:"status"`
		Regeocode struct {
			FormattedAddress string `json:"formatted_address"`
		} `json:"regeocode"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", errors.New("invalid amap reverse response")
	}
	address := strings.TrimSpace(body.Regeocode.FormattedAddress)
	if body.Status != "1" || address == "" {
		return "", errors.New("amap reverse returned no address")
	}
	if !strings.HasPrefix(address, "中国") {
		address = "中国" + address
	}
	return address, nil
}
