package config

import (
	"testing"

	"gopkg.in/yaml.v3"
)

func TestConfigLoadsSignLocations(t *testing.T) {
	raw := []byte("sign_locations:\n  - name: 示例点\n    address: 待确认\n    latitude: 32.1\n    longitude: 114.1\n    amap_poi_id: poi-1\n    status: pending\n    source: config\n")
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.SignLocations) != 1 || cfg.SignLocations[0].AMAPPoiID != "poi-1" || cfg.SignLocations[0].Latitude != 32.1 {
		t.Fatalf("unexpected sign locations: %#v", cfg.SignLocations)
	}
}

func TestConfigLoadsPublicAdminAccess(t *testing.T) {
	raw := []byte("public_access: true\npublic_admin: true\ndisable_admin: false\n")
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if !cfg.PublicAccess || !cfg.PublicAdmin || cfg.DisableAdmin {
		t.Fatalf("expected public administrator login with admin routes enabled, got public=%v public_admin=%v disable_admin=%v", cfg.PublicAccess, cfg.PublicAdmin, cfg.DisableAdmin)
	}
}
