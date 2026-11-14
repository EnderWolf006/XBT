package geo

import (
	"math"
	"testing"
)

func TestGCJ02ToBD09(t *testing.T) {
	for _, tt := range []struct {
		name     string
		in, want Point
	}{
		{"huashui-building-3", Point{Latitude: 34.781820, Longitude: 113.791935}, Point{Latitude: 34.787781, Longitude: 113.798430}},
		{"beijing", Point{Latitude: 39.915, Longitude: 116.404}, Point{Latitude: 39.921337, Longitude: 116.410369}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := GCJ02ToBD09(tt.in)
			if err != nil || got != tt.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, tt.want)
			}
		})
	}
	for _, point := range []Point{
		{Latitude: math.NaN()}, {Longitude: math.Inf(1)}, {Latitude: 91}, {Longitude: 181},
	} {
		if _, err := GCJ02ToBD09(point); err == nil {
			t.Fatalf("invalid point accepted: %+v", point)
		}
	}
}
