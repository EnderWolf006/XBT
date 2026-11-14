package service

import (
	"testing"

	"xbt2/server/internal/config"
	"xbt2/server/internal/model"
)

func TestPrepareConfiguredSignLocationsDefaultsPendingAndConfigSource(t *testing.T) {
	rows, err := prepareConfiguredSignLocations([]config.SignLocationConfig{{
		Name: "校区示例点", Address: "需管理员确认", Latitude: 32.1, Longitude: 114.1,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one row, got %d", len(rows))
	}
	if rows[0].Status != model.SignLocationPending || rows[0].Source != "config" {
		t.Fatalf("unexpected defaults: %#v", rows[0])
	}
}

func TestPrepareConfiguredSignLocationsRejectsInvalidCoordinatesBeforeWriting(t *testing.T) {
	_, err := prepareConfiguredSignLocations([]config.SignLocationConfig{{
		Name: "错误点", Address: "地址", Latitude: 91, Longitude: 114,
	}})
	if err == nil {
		t.Fatal("expected invalid coordinate error")
	}
}

func TestConfiguredSignLocationIdentityPrefersPOIAndFallsBackToSixDecimals(t *testing.T) {
	withPOI := config.SignLocationConfig{Name: "A", Address: "甲", Latitude: 32.1000004, Longitude: 114.2000004, AMAPPoiID: "poi-1"}
	if got := configuredSignLocationIdentity(withPOI); got != "poi:poi-1" {
		t.Fatalf("unexpected POI identity: %q", got)
	}
	withoutPOI := config.SignLocationConfig{Name: " A ", Address: " 甲 ", Latitude: 32.1000004, Longitude: 114.2000004}
	if got := configuredSignLocationIdentity(withoutPOI); got != "coord:32.100000|114.200000" {
		t.Fatalf("unexpected fallback identity: %q", got)
	}
}
