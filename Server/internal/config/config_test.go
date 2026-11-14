package config

import "testing"

func TestMaskedDSNRedactsKeyValuePassword(t *testing.T) {
	got := (Config{PostgresDSN: "host=127.0.0.1 user=xbt password=secret-value dbname=xbt"}).MaskedDSN()
	if got == "" || containsSecret(got, "secret-value") || !containsSecret(got, "password=***") {
		t.Fatalf("password was not safely masked: %q", got)
	}
}

func TestMaskedDSNRedactsURLPassword(t *testing.T) {
	got := (Config{PostgresDSN: "postgres://xbt:secret%21@127.0.0.1:5432/xbt"}).MaskedDSN()
	if containsSecret(got, "secret") || containsSecret(got, "secret%21") || !containsSecret(got, "postgres://xbt:***@") {
		t.Fatalf("URL password was not safely masked: %q", got)
	}
}

func TestMaskedDSNRedactsPostgreSQLURLPassword(t *testing.T) {
	got := (Config{PostgresDSN: "postgresql://xbt:secret%21@127.0.0.1:5432/xbt"}).MaskedDSN()
	if containsSecret(got, "secret") || containsSecret(got, "secret%21") || !containsSecret(got, "postgresql://xbt:***@") {
		t.Fatalf("PostgreSQL URL password was not safely masked: %q", got)
	}
}

func TestMaskedDSNRedactsEscapedQuotedPassword(t *testing.T) {
	got := (Config{PostgresDSN: `host=localhost password="sec\"ret" user=xbt`}).MaskedDSN()
	if containsSecret(got, "sec") || containsSecret(got, "ret") || !containsSecret(got, "password=***") {
		t.Fatalf("escaped quoted password was not safely masked: %q", got)
	}
}

func containsSecret(value, secret string) bool {
	for i := 0; i+len(secret) <= len(value); i++ {
		if value[i:i+len(secret)] == secret {
			return true
		}
	}
	return false
}
