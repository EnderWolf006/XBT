package geo

import (
	"math"
	"testing"
)

func TestWGS84PublicExample(t *testing.T) {
	// Public sample: https://github.com/wandergis/coordtransform (README).
	got, converted, err := WGS84ToGCJ02(Point{Longitude: 116.404, Latitude: 39.915})
	if err != nil || !converted || math.Abs(got.Longitude-116.41024449916938) > 1e-9 || math.Abs(got.Latitude-39.91640428150164) > 1e-9 {
		t.Fatalf("公开样例转换不符: %+v converted=%v err=%v", got, converted, err)
	}
	if got.Rounded() != (Point{Longitude: 116.410244, Latitude: 39.916404}) {
		t.Fatal("六位坐标错误")
	}
}

func TestCoordinateValidationAndOutsideRegion(t *testing.T) {
	for _, p := range []Point{{Latitude: 91}, {Longitude: 181}, {Latitude: math.NaN()}, {Longitude: math.Inf(1)}} {
		if _, _, err := WGS84ToGCJ02(p); err == nil {
			t.Fatal("拒绝非法坐标")
		}
	}
	london := Point{Latitude: 51.5074, Longitude: -0.1278}
	got, converted, err := WGS84ToGCJ02(london)
	if err != nil || converted || got != london {
		t.Fatal("范围外保持原坐标并明确未转换")
	}
}

func TestMapGroundDistanceAndDirection(t *testing.T) {
	start := Point{Latitude: 0, Longitude: 0}
	east, err := MoveCenter(start, "east", 100)
	if err != nil || math.Abs(east.Longitude-0.000898) > 1e-6 || math.Abs(east.Latitude) > 1e-6 {
		t.Fatal("赤道100米向东应约0.000898度")
	}

	west, err := MoveCenter(east, "west", 100)
	if err != nil || math.Abs(west.Longitude) > 1e-6 {
		t.Fatal("往返移动应回到原点")
	}
	north, err := MoveCenter(start, "north", 100)
	if err != nil || math.Abs(north.Latitude-0.000898) > 1e-6 {
		t.Fatal("向北移动纬度应增加")
	}
	for _, distance := range []float64{0, 1001, math.NaN(), math.Inf(1)} {
		if _, err := MoveCenter(start, "north", distance); err == nil {
			t.Fatal("非法距离未拒绝")
		}
	}
	if _, err := MoveCenter(start, "invalid", 25); err == nil {
		t.Fatal("非法方向未拒绝")
	}
}

func TestOffsetByMatchesRequestedTarget(t *testing.T) {
	start := Point{Latitude: 39.915000, Longitude: 116.404000}
	offset := Point{Latitude: -0.000093, Longitude: 0.000027}
	got, err := start.OffsetBy(offset)
	if err != nil || got != (Point{Latitude: 39.914907, Longitude: 116.404027}) {
		t.Fatalf("wrong offset target: %+v, %v", got, err)
	}
	for _, tt := range []struct{ point, offset Point }{
		{Point{Latitude: 90}, Point{Latitude: 0.000001}},
		{Point{Longitude: 180}, Point{Longitude: 0.000001}},
		{start, Point{Latitude: math.NaN()}},
		{Point{Longitude: math.Inf(1)}, offset},
	} {
		if _, err := tt.point.OffsetBy(tt.offset); err == nil {
			t.Fatalf("invalid offset accepted: %+v", tt)
		}
	}
}
