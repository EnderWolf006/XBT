package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
	"xbt2/server/internal/geo"
)

type Config struct {
	AppEnv                string               `yaml:"app_env"`
	HTTPAddr              string               `yaml:"http_addr"`
	JWTSecret             string               `yaml:"jwt_secret"`
	CredentialSecret      string               `yaml:"credential_secret"`
	AllowInsecureTLS      bool                 `yaml:"allow_insecure_tls"`
	ChaoxingAESKey        string               `yaml:"chaoxing_aes_key"`
	ChaoxingUserAgent     string               `yaml:"chaoxing_user_agent"`
	ActivityListLimit     int                  `yaml:"activity_list_limit"`
	PublicAccess          bool                 `yaml:"public_access"`
	PublicAdmin           bool                 `yaml:"public_admin"`
	DisableAdmin          bool                 `yaml:"disable_admin"`
	PersonalLocationsOnly bool                 `yaml:"personal_locations_only"`
	SignLocationOffset    geo.Point            `yaml:"sign_location_offset"`
	MediaCacheDir         string               `yaml:"media_cache_dir"`
	PostgresDSN           string               `yaml:"postgres_dsn"`
	AMap                  AMapConfig           `yaml:"amap"`
	SignLocations         []SignLocationConfig `yaml:"sign_locations"`
}

type AMapConfig struct {
	APIKey         string `yaml:"api_key"`
	CampusAddress  string `yaml:"campus_address"`
	JSAPIKey       string `yaml:"js_api_key"`
	SecurityJSCode string `yaml:"security_js_code"`
}

// SignLocationConfig is a declarative location seed. Coordinates are WGS-84
// values supplied by an operator and are never obtained from the client.
type SignLocationConfig struct {
	Name      string  `yaml:"name"`
	Address   string  `yaml:"address"`
	Latitude  float64 `yaml:"latitude"`
	Longitude float64 `yaml:"longitude"`
	AMAPPoiID string  `yaml:"amap_poi_id,omitempty"`
	Status    string  `yaml:"status,omitempty"`
	Source    string  `yaml:"source,omitempty"`
}

func Load() Config {
	cfg := Config{}

	raw, err := os.ReadFile("config.yaml")
	if err != nil {
		panic(fmt.Errorf("read config.yaml failed: %w", err))
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		panic(fmt.Errorf("parse config.yaml failed: %w", err))
	}

	if cfg.ActivityListLimit <= 0 {
		cfg.ActivityListLimit = 5
	}
	if strings.TrimSpace(cfg.MediaCacheDir) == "" {
		cfg.MediaCacheDir = "cache/images"
	}
	if err := cfg.SignLocationOffset.Validate(); err != nil {
		panic(fmt.Errorf("invalid sign_location_offset: %w", err))
	}
	return cfg
}

func (c Config) MaskedDSN() string {
	dsn := strings.TrimSpace(c.PostgresDSN)
	if dsn == "" {
		return ""
	}
	if !strings.Contains(dsn, " ") && (strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://")) {
		if parsed, err := url.Parse(dsn); err == nil && parsed.User != nil {
			username := parsed.User.Username()
			parsed.User = url.UserPassword(username, "***")
			masked := parsed.String()
			return strings.Replace(masked, "%2A%2A%2A", "***", 1)
		}
	}

	quotedPassword := regexp.MustCompile(`(?i)(password=)"(?:\\.|[^"\\])*"`)
	dsn = quotedPassword.ReplaceAllString(dsn, `${1}***`)
	password := regexp.MustCompile(`(?i)(^|\s)(password=)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+)`).ReplaceAllString(dsn, `${1}${2}***`)
	return password
}
