package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	AppEnv            string `yaml:"app_env"`
	HTTPAddr          string `yaml:"http_addr"`
	JWTSecret         string `yaml:"jwt_secret"`
	CredentialSecret  string `yaml:"credential_secret"`
	AllowInsecureTLS  bool   `yaml:"allow_insecure_tls"`
	ChaoxingAESKey    string `yaml:"chaoxing_aes_key"`
	ChaoxingUserAgent string `yaml:"chaoxing_user_agent"`
	ActivityListLimit int    `yaml:"activity_list_limit"`
	PostgresDSN       string `yaml:"postgres_dsn"`
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
	return cfg
}

func (c Config) MaskedDSN() string {
	return fmt.Sprintf("%s ...", c.PostgresDSN[:min(len(c.PostgresDSN), 24)])
}
