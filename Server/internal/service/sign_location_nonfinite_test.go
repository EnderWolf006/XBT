package service

import (
	"math"
	"testing"
)

func TestValidateSignLocationRejectsNonFiniteCoordinates(t *testing.T) {
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := validateSignLocation(CreateSignLocationInput{Name: "楼", Address: "址", Latitude: value, Longitude: 114}); err == nil {
			t.Fatalf("expected non-finite latitude %v to be rejected", value)
		}
	}
}
