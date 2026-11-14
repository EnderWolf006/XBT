package service

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"xbt2/server/internal/model"
)

func TestNormalizeSignLocationCoordinateUsesFixedPrecision(t *testing.T) {
	lat, lng := normalizeSignLocationCoordinates(31.2304167, 121.4737012)
	if lat != 31.230417 || lng != 121.473701 {
		t.Fatalf("unexpected normalized coordinates: %v, %v", lat, lng)
	}
}

func TestCreateSignLocationInputCannotOverrideManualMetadata(t *testing.T) {
	in := CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 32, Longitude: 114, Status: model.SignLocationEnabled, Source: "amap"}
	got := forceManualSignLocationInput(in)
	if got.Status != model.SignLocationPending || got.Source != "manual" {
		t.Fatalf("manual input was not forced to pending/manual: %+v", got)
	}
}

func TestCaptureSourceWhitelist(t *testing.T) {
	for _, source := range []string{"manual", "device_gps", "map_pick", "amap", "unknown", ""} {
		got := forceManualSignLocationInput(CreateSignLocationInput{Source: source, Status: model.SignLocationEnabled, AMAPPoiID: "test-poi"})
		want := "manual"
		if source == "device_gps" || source == "map_pick" {
			want = source
			if got.AMAPPoiID != "" {
				t.Fatal("采集或地图取点必须清空POI")
			}
		}
		if got.Source != want || got.Status != model.SignLocationPending {
			t.Fatal("来源白名单或pending保护错误")
		}
	}
}

func TestSignLocationErrorClassification(t *testing.T) {
	inputErr := validateSignLocation(CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 32, Longitude: 114, Status: "bad"})
	if !errors.Is(classifySignLocationError(inputErr), ErrInvalidSignLocationInput) {
		t.Fatal("invalid status should be classified as input error")
	}
	if !errors.Is(classifySignLocationError(gorm.ErrRecordNotFound), gorm.ErrRecordNotFound) {
		t.Fatal("record not found classification changed")
	}
}

func TestSignLocationUniqueViolationClassifiesAsConflict(t *testing.T) {
	err := &pgconn.PgError{Code: "23505"}
	if !errors.Is(classifySignLocationError(err), ErrSignLocationConflict) {
		t.Fatal("unique violation should be classified as sign location conflict")
	}
}

func TestCreateAndUpdateCoordinatesAreNormalized(t *testing.T) {
	in := CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 31.2304167, Longitude: 121.4737012}
	lat, lng := normalizeSignLocationCoordinates(in.Latitude, in.Longitude)
	if lat != 31.230417 || lng != 121.473701 {
		t.Fatalf("unexpected normalized create coordinates: %v, %v", lat, lng)
	}
	update := UpdateSignLocationInput{Latitude: 31.2304167, Longitude: 121.4737012}
	lat, lng = normalizeSignLocationCoordinates(update.Latitude, update.Longitude)
	if lat != 31.230417 || lng != 121.473701 {
		t.Fatalf("unexpected normalized update coordinates: %v, %v", lat, lng)
	}
}
