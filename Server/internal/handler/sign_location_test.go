package handler

import "testing"

func TestParseSignLocationIDRejectsInvalidValues(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "abc"} {
		if _, err := parseSignLocationID(value); err == nil {
			t.Fatalf("expected invalid id for %q", value)
		}
	}
}
func TestParseSignLocationIDAcceptsPositiveValue(t *testing.T) {
	got, err := parseSignLocationID("12")
	if err != nil || got != 12 {
		t.Fatalf("unexpected result: %d, %v", got, err)
	}
}
