package config

import (
	"os"
	"path/filepath"
	"testing"

	"xbt2/server/internal/geo"
)

func TestLoadGlobalLocationOffset(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, tt := range []struct {
		name string
		yaml string
		want geo.Point
	}{
		{"default-off", "app_env: test\n", geo.Point{}},
		{"requested-offset", "sign_location_offset:\n  latitude: -0.000093\n  longitude: 0.000027\n", geo.Point{Latitude: -0.000093, Longitude: 0.000027}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(".", "config.yaml"), []byte(tt.yaml), 0600); err != nil {
				t.Fatal(err)
			}
			if got := Load().SignLocationOffset; got != tt.want {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestLoadRejectsInvalidGlobalLocationOffset(t *testing.T) {
	t.Chdir(t.TempDir())
	for _, value := range []string{".nan", ".inf", "91"} {
		t.Run(value, func(t *testing.T) {
			if err := os.WriteFile("config.yaml", []byte("sign_location_offset:\n  latitude: "+value+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if recover() == nil {
					t.Fatal("invalid configured offset did not stop startup")
				}
			}()
			Load()
		})
	}
}
