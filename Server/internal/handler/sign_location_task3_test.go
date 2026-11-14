package handler

import (
	"errors"
	"testing"

	"gorm.io/gorm"
	"xbt2/server/internal/service"
)

func TestSignLocationErrorHTTPStatusSeparatesInputNotFoundConflictAndDatabase(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		notFound bool
		expected int
	}{
		{name: "input", err: service.ErrInvalidSignLocationInput, expected: 400},
		{name: "not found", err: gorm.ErrRecordNotFound, notFound: true, expected: 404},
		{name: "conflict", err: service.ErrSignLocationConflict, expected: 409},
		{name: "database", err: errors.New("database unavailable"), expected: 500},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := signLocationErrorHTTPStatus(tc.err, tc.notFound); got != tc.expected {
				t.Fatalf("status = %d, want %d", got, tc.expected)
			}
		})
	}
}
