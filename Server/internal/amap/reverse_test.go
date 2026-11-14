package amap

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"xbt2/server/internal/config"
	"xbt2/server/internal/geo"
)

type reverseTransport func(*http.Request) (*http.Response, error)

func (f reverseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestReverseAddress(t *testing.T) {
	for _, tt := range []struct {
		name, body, want string
		status           int
		fail             bool
	}{
		{"address", `{"status":"1","regeocode":{"formatted_address":"北京市东城区示例路"}}`, "中国北京市东城区示例路", 200, false},
		{"prefix", `{"status":"1","regeocode":{"formatted_address":"中国北京市"}}`, "中国北京市", 200, false},
		{"empty", `{"status":"1","regeocode":{"formatted_address":""}}`, "", 200, false},
		{"provider", `{"status":"0","info":"INVALID_USER_KEY"}`, "", 200, false},
		{"json", `bad`, "", 200, false},
		{"http", `{}`, "", 503, false},
		{"network", ``, "", 200, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			client := NewClient(config.AMapConfig{APIKey: "test-secret"}, &http.Client{Transport: reverseTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path != "/v3/geocode/regeo" || r.URL.Query().Get("location") != "116.404027,39.914907" || r.URL.Query().Get("extensions") != "base" {
					t.Fatal("incorrect reverse point or endpoint")
				}
				if _, ok := r.Context().Deadline(); !ok {
					t.Fatal("missing timeout")
				}
				if tt.fail {
					return nil, errors.New("request containing test-secret failed")
				}
				return &http.Response{StatusCode: tt.status, Body: io.NopCloser(strings.NewReader(tt.body)), Header: make(http.Header)}, nil
			})})
			got, err := client.ReverseAddress(context.Background(), geo.Point{Latitude: 39.914907, Longitude: 116.404027})
			if got != tt.want || (err == nil) != (tt.want != "") {
				t.Fatalf("got %q err=%v want %q", got, err, tt.want)
			}
			if err != nil && strings.Contains(err.Error(), "test-secret") {
				t.Fatal("map key leaked")
			}
		})
	}
	if _, err := NewClient(config.AMapConfig{}, nil).ReverseAddress(context.Background(), geo.Point{}); err == nil {
		t.Fatal("missing key accepted")
	}
}
