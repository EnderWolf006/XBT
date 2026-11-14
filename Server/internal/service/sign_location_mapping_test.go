package service

import (
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
	"xbt2/server/internal/model"
	"xbt2/server/internal/xxt"
)

func TestResolveLocationSpecialUsesStoredCoordinatesAndDescription(t *testing.T) {
	location := model.SignLocation{
		ID: 1, Status: model.SignLocationEnabled, Name: "第一教学楼", Address: "江淮校区",
		Latitude: 32.1, Longitude: 114.1,
	}
	got, err := resolveLocationSpecialFromLocation(location, map[string]interface{}{
		"latitude": "0", "longitude": "0", "description": "伪造地址", "other": "keep",
		"coordinate_system": "BD-09", "location": `{"latitude":0,"longitude":0}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got["latitude"] != "32.1" || got["longitude"] != "114.1" || got["description"] != "江淮校区" {
		t.Fatalf("stored location did not override client fields: %#v", got)
	}
	if got["other"] != "keep" {
		t.Fatalf("non-location special params were not preserved: %#v", got)
	}
	if got["coordinate_system"] != "GCJ-02" || got["location"] != nil {
		t.Fatalf("stored coordinates must override legacy QR payload: %#v", got)
	}
}

func TestResolveLocationSpecialRejectsUnavailableLocations(t *testing.T) {
	for _, status := range []string{model.SignLocationPending, model.SignLocationDisabled} {
		_, err := resolveLocationSpecialFromLocation(model.SignLocation{ID: 1, Status: status}, nil)
		if !errors.Is(err, ErrSignLocationUnavailable) {
			t.Fatalf("status %q should be unavailable, got %v", status, err)
		}
	}
	_, err := resolveLocationSpecialFromLocation(model.SignLocation{ID: 1, Status: model.SignLocationEnabled, DeletedAt: gorm.DeletedAt{Valid: true}}, nil)
	if !errors.Is(err, ErrSignLocationUnavailable) {
		t.Fatalf("deleted location should be unavailable, got %v", err)
	}
}

func TestExecuteSignRequestLocationIDIsRequiredOnlyForLocationSign(t *testing.T) {
	if err := validateExecuteSignLocation(xxt.SignLocation, false, 0, "", nil, nil); err == nil {
		t.Fatal("location sign should require a positive location_id")
	}
	if err := validateExecuteSignLocation(xxt.SignNormal, false, 0, "", nil, nil); err != nil {
		t.Fatalf("non-location sign should not require location_id: %v", err)
	}
}

func TestDeviceLocationUsesOnlyCurrentGCJ02Coordinates(t *testing.T) {
	device := &DeviceLocation{
		Latitude: 39.916404, Longitude: 116.410244, Accuracy: 20,
		CapturedAt: time.Date(2026, 9, 25, 6, 0, 0, 0, time.UTC), CoordinateSystem: "GCJ-02",
	}
	if err := validateExecuteSignLocation(xxt.SignLocation, false, 0, LocationModeDeviceGPS, device, nil); err != nil {
		t.Fatalf("valid device location rejected: %v", err)
	}
	special := resolveDeviceLocationSpecial(*device)
	if special["coordinate_system"] != "GCJ-02" {
		t.Fatal("device point must carry its coordinate system to the adapter")
	}
	if special["latitude"] != "39.916404" || special["longitude"] != "116.410244" {
		t.Fatalf("device coordinates were not preserved: %#v", special)
	}
	if special["description"] == "" || special["description"] == "伪造地址" {
		t.Fatalf("device description must state its source: %#v", special)
	}
	for _, invalid := range []*DeviceLocation{
		nil,
		{Latitude: 39.9, Longitude: 116.4, Accuracy: -1, CapturedAt: device.CapturedAt, CoordinateSystem: "GCJ-02"},
		{Latitude: 91, Longitude: 116.4, Accuracy: 1, CapturedAt: device.CapturedAt, CoordinateSystem: "GCJ-02"},
		{Latitude: 39.9, Longitude: 116.4, Accuracy: 1, CoordinateSystem: "GCJ-02"},
		{Latitude: 39.9, Longitude: 116.4, Accuracy: 1, CapturedAt: device.CapturedAt, CoordinateSystem: "WGS-84"},
	} {
		if err := validateExecuteSignLocation(xxt.SignLocation, false, 0, LocationModeDeviceGPS, invalid, nil); err == nil {
			t.Fatal("invalid device location was accepted")
		}
	}
	if err := validateExecuteSignLocation(xxt.SignLocation, false, 1, LocationModeDeviceGPS, device, nil); err == nil {
		t.Fatal("device location must not be combined with location_id")
	}
}

func TestMapPickUsesConfirmedGCJ02CoordinatesDirectly(t *testing.T) {
	point := &MapLocation{Latitude: 39.916404, Longitude: 116.410244, CoordinateSystem: "GCJ-02"}
	if err := validateExecuteSignLocation(xxt.SignLocation, false, 0, LocationModeMapPick, nil, point); err != nil {
		t.Fatalf("valid map point rejected: %v", err)
	}
	got := resolveMapLocationSpecial(*point)
	if got["coordinate_system"] != "GCJ-02" {
		t.Fatal("map point must carry its coordinate system to the adapter")
	}
	if got["latitude"] != "39.916404" || got["longitude"] != "116.410244" {
		t.Fatalf("map coordinates were not used directly: %#v", got)
	}
	if got["description"] != "地图选择点（GCJ-02：39.916404, 116.410244）" {
		t.Fatalf("map point source should be explicit: %#v", got)
	}
	for _, invalid := range []*MapLocation{
		nil,
		{Latitude: 91, Longitude: 116.4, CoordinateSystem: "GCJ-02"},
		{Latitude: 39.9, Longitude: 116.4, CoordinateSystem: "WGS-84"},
		{Latitude: 39.9, Longitude: 116.4, CoordinateSystem: ""},
	} {
		if err := validateExecuteSignLocation(xxt.SignLocation, false, 0, LocationModeMapPick, nil, invalid); err == nil {
			t.Fatal("invalid map point was accepted")
		}
	}
	if err := validateExecuteSignLocation(xxt.SignLocation, false, 1, LocationModeMapPick, nil, point); err == nil {
		t.Fatal("map point must not be combined with location_id")
	}
	if err := validateExecuteSignLocation(xxt.SignLocation, false, 0, LocationModeMapPick, &DeviceLocation{}, point); err == nil {
		t.Fatal("map point must not be combined with device location")
	}
	if err := validateExecuteSignLocation(xxt.SignNormal, false, 0, LocationModeMapPick, nil, point); err == nil {
		t.Fatal("map coordinates are only valid for location signs")
	}
}

func TestExecuteCannotSubstituteCoordinatesForLocationID(t *testing.T) {
	svc := &SignService{}
	for _, special := range []map[string]interface{}{nil, {"latitude": 39.9, "longitude": 116.4, "location_id": 123}} {
		result := svc.ExecuteOne(99002, ExecuteSignRequest{SignType: xxt.SignLocation, TargetUID: 99002, Special: special})
		if result.Success || result.Message != "请选择有效的签到地点" {
			t.Fatal("缺少顶层地点ID必须在访问数据库或外部业务之前拒绝")
		}
	}
}
