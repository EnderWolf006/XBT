package xxt

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"

	"xbt2/server/internal/geo"
)

type coordinateTransport func(*http.Request) (*http.Response, error)

func (f coordinateTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestResolvedAddressUsesShiftedPointAndStopsOnFailure(t *testing.T) {
	input := map[string]interface{}{
		"latitude": "39.915000", "longitude": "116.404000", "coordinate_system": "GCJ-02",
		"description": "地图选择点（GCJ-02：39.915000, 116.404000）",
	}
	offset := geo.Point{Latitude: -0.000093, Longitude: 0.000027}
	const address = "中国北京市东城区示例路"
	prepared, err := prepareSignCoordinatesWithAddress(input, offset, func(point geo.Point) (string, error) {
		if point != (geo.Point{Latitude: 39.914907, Longitude: 116.404027}) {
			t.Fatalf("reverse must use shifted GCJ, not original or BD09: %+v", point)
		}
		return address, nil
	})
	if err != nil || prepared["description"] != address || prepared["latitude"] != "39.921244" || prepared["longitude"] != "116.410397" {
		t.Fatalf("wrong submission: %#v %v", prepared, err)
	}
	wire, ok := buildQRCodeLocationParam(prepared)
	if !ok || strings.Contains(wire, "地图选择点") || strings.Contains(wire, "全局偏移") || !strings.Contains(wire, address) {
		t.Fatalf("QR address not normalized: %s", wire)
	}
	for _, resolver := range []func(geo.Point) (string, error){
		func(geo.Point) (string, error) { return "", errors.New("failure") },
		func(geo.Point) (string, error) { return " ", nil },
	} {
		client := New("", "test", false, 1)
		client.SetSignAddressResolver(resolver)
		client.http.Transport = coordinateTransport(func(*http.Request) (*http.Response, error) {
			t.Fatal("must not log in or submit after reverse failure")
			return nil, errors.New("unexpected request")
		})
		if _, err := client.Sign("test", "test", FixedParams{}, SignLocation, input); err == nil {
			t.Fatal("reverse failure accepted")
		}
	}
}

func TestLocationSignSendsBD09WithoutMutatingSelectedPoint(t *testing.T) {
	special := map[string]interface{}{
		"latitude": "34.781820", "longitude": "113.791935",
		"coordinate_system": "GCJ-02", "description": "building 3",
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := New("", "test", false, 1)
	client.sessions["test"] = &Session{Password: "test", Jar: jar, LastLoginAt: time.Now()}
	client.http.Transport = coordinateTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		q := r.URL.Query()
		if r.URL.Host != "mobilelearn.chaoxing.com" || r.URL.Path != "/pptSign/stuSignajax" ||
			q.Get("latitude") != "34.787781" || q.Get("longitude") != "113.798430" ||
			q.Get("address") != "building 3" || q.Get("ifTiJiao") != "1" {
			t.Fatalf("unexpected wire request: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("success")), Header: make(http.Header)}, nil
	})
	result, err := client.Sign("test", "test", FixedParams{ActiveID: 1, UID: 2}, SignLocation, special)
	if err != nil || result != "success" || calls != 1 {
		t.Fatalf("result=%q err=%v calls=%d", result, err, calls)
	}
	if special["latitude"] != "34.781820" || special["coordinate_system"] != "GCJ-02" {
		t.Fatalf("selection was mutated: %#v", special)
	}
}

func TestQRCodeLocationUsesSameBoundaryConversion(t *testing.T) {
	input := map[string]interface{}{
		"latitude": 34.781820, "longitude": 113.791935, "coordinate_system": "GCJ-02",
		"description": "building 3", "enc": "keep", "location": `{"latitude":0,"longitude":0}`,
	}
	prepared, err := prepareSignCoordinates(input, geo.Point{})
	if err != nil {
		t.Fatal(err)
	}
	wire, ok := buildQRCodeLocationParam(prepared)
	if !ok {
		t.Fatal("missing QR location")
	}
	var location struct {
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
		Address   string  `json:"address"`
	}
	if err := json.Unmarshal([]byte(wire), &location); err != nil {
		t.Fatal(err)
	}
	if location.Latitude != 34.787781 || location.Longitude != 113.798430 || location.Address != "building 3" || prepared["enc"] != "keep" {
		t.Fatalf("wrong QR location: %s", wire)
	}
	again, err := prepareSignCoordinates(prepared, geo.Point{})
	if err != nil || again["latitude"] != prepared["latitude"] || again["longitude"] != prepared["longitude"] {
		t.Fatal("BD-09 was converted a second time")
	}
	if input["location"] == nil {
		t.Fatal("original payload was mutated")
	}
}

func TestCoordinateBoundaryRejectsInvalidAndPreservesLegacy(t *testing.T) {
	for _, input := range []map[string]interface{}{
		{"coordinate_system": "WGS-84"},
		{"coordinate_system": "GCJ-02", "latitude": "NaN", "longitude": "113"},
		{"coordinate_system": "GCJ-02", "latitude": "34"},
		{"coordinate_system": "GCJ-02", "latitude": "91", "longitude": "113"},
		{"coordinate_system": "BD-09", "latitude": "34", "longitude": "+Inf"},
	} {
		if _, err := prepareSignCoordinates(input, geo.Point{}); err == nil {
			t.Fatalf("invalid input accepted: %#v", input)
		}
	}
	for _, input := range []map[string]interface{}{
		nil, {"enc": "keep"}, {"location": `{"latitude":34,"longitude":113}`},
	} {
		got, err := prepareSignCoordinates(input, geo.Point{})
		if err != nil || len(got) != len(input) || got["location"] != input["location"] || got["enc"] != input["enc"] {
			t.Fatalf("legacy payload changed: %#v, %v", got, err)
		}
	}
}

func TestGlobalOffsetAppliesOnceBeforeConversion(t *testing.T) {
	offset := geo.Point{Latitude: -0.000093, Longitude: 0.000027}
	input := map[string]interface{}{
		"latitude": "39.915000", "longitude": "116.404000", "coordinate_system": "GCJ-02",
		"description": "selected point", "enc": "keep",
	}
	prepared, err := prepareSignCoordinates(input, offset)
	if err != nil {
		t.Fatal(err)
	}
	if prepared["latitude"] != "39.921244" || prepared["longitude"] != "116.410397" ||
		prepared["description"] != "selected point" {
		t.Fatalf("wrong offset or conversion order: %#v", prepared)
	}
	again, err := prepareSignCoordinates(prepared, offset)
	if err != nil || again["latitude"] != prepared["latitude"] || again["longitude"] != prepared["longitude"] ||
		again["description"] != prepared["description"] {
		t.Fatal("offset was applied twice")
	}
	if input["latitude"] != "39.915000" || input["longitude"] != "116.404000" || input["description"] != "selected point" {
		t.Fatal("selected point was mutated")
	}
	wire, ok := buildQRCodeLocationParam(prepared)
	if !ok || !strings.Contains(wire, `"latitude":39.921244`) || !strings.Contains(wire, `"longitude":116.410397`) || prepared["enc"] != "keep" {
		t.Fatalf("QR does not use offset coordinates: %s", wire)
	}
	for _, point := range []map[string]interface{}{
		nil, {"enc": "keep"}, {"location": `{"latitude":34,"longitude":113}`},
	} {
		out, err := prepareSignCoordinates(point, offset)
		if err != nil || len(out) != len(point) {
			t.Fatalf("non-location or legacy sign changed: %#v, %v", out, err)
		}
	}
	if _, err := prepareSignCoordinates(map[string]interface{}{
		"coordinate_system": "GCJ-02", "latitude": "-90", "longitude": "113",
	}, offset); err == nil {
		t.Fatal("shifted out-of-range point accepted")
	}
}

func TestClientSignUsesConfiguredGlobalOffset(t *testing.T) {
	client := New("", "test", false, 1)
	const address = "中国北京市东城区示例路"
	client.SetSignAddressResolver(func(point geo.Point) (string, error) {
		if point != (geo.Point{Latitude: 39.914907, Longitude: 116.404027}) {
			t.Fatalf("unexpected address lookup point: %+v", point)
		}
		return address, nil
	})
	if err := client.SetSignLocationOffset(geo.Point{Latitude: math.NaN()}); err == nil {
		t.Fatal("invalid global offset accepted")
	}
	if err := client.SetSignLocationOffset(geo.Point{Latitude: -0.000093, Longitude: 0.000027}); err != nil {
		t.Fatal(err)
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client.sessions["test"] = &Session{Password: "test", Jar: jar, LastLoginAt: time.Now()}
	calls := 0
	client.http.Transport = coordinateTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		query := r.URL.Query()
		if query.Get("latitude") != "39.921244" || query.Get("longitude") != "116.410397" ||
			query.Get("address") != address {
			t.Fatalf("wrong outgoing shifted location: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("success")), Header: make(http.Header)}, nil
	})
	result, err := client.Sign("test", "test", FixedParams{ActiveID: 1, UID: 2}, SignLocation, map[string]interface{}{
		"latitude": "39.915000", "longitude": "116.404000", "coordinate_system": "GCJ-02", "description": "selected point",
	})
	if err != nil || result != "success" || calls != 1 {
		t.Fatalf("result=%q err=%v calls=%d", result, err, calls)
	}
}
