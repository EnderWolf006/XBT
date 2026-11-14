package geo

import (
	"errors"
	"math"
)

type Point struct {
	Latitude  float64 `json:"latitude" yaml:"latitude"`
	Longitude float64 `json:"longitude" yaml:"longitude"`
}

var ErrCoordinates = errors.New("坐标必须是合法范围内的有限数值")

func (p Point) Validate() error {
	if math.IsNaN(p.Latitude) || math.IsNaN(p.Longitude) || math.IsInf(p.Latitude, 0) || math.IsInf(p.Longitude, 0) ||
		p.Latitude < -90 || p.Latitude > 90 || p.Longitude < -180 || p.Longitude > 180 {
		return ErrCoordinates
	}
	return nil
}

func (p Point) Rounded() Point {
	return Point{Latitude: math.Round(p.Latitude*1e6) / 1e6, Longitude: math.Round(p.Longitude*1e6) / 1e6}
}

func (p Point) OffsetBy(delta Point) (Point, error) {
	if err := p.Validate(); err != nil {
		return Point{}, err
	}
	if err := delta.Validate(); err != nil {
		return Point{}, err
	}
	next := Point{Latitude: p.Latitude + delta.Latitude, Longitude: p.Longitude + delta.Longitude}
	if err := next.Validate(); err != nil {
		return Point{}, err
	}
	return next.Rounded(), nil
}

// GCJ02ToBD09 adapts an AMap point for Baidu-compatible location parameters.
func GCJ02ToBD09(p Point) (Point, error) {
	if err := p.Validate(); err != nil {
		return Point{}, err
	}
	const xPi = math.Pi * 3000 / 180
	z := math.Hypot(p.Longitude, p.Latitude) + 0.00002*math.Sin(p.Latitude*xPi)
	theta := math.Atan2(p.Latitude, p.Longitude) + 0.000003*math.Cos(p.Longitude*xPi)
	result := Point{Latitude: z*math.Sin(theta) + 0.006, Longitude: z*math.Cos(theta) + 0.0065}
	if err := result.Validate(); err != nil {
		return Point{}, err
	}
	return result.Rounded(), nil
}

// WGS84ToGCJ02 uses the commonly published GCJ offset approximation, not a
// surveyed positioning guarantee. Outside its applicable bounds it is identity.
func WGS84ToGCJ02(p Point) (Point, bool, error) {
	if err := p.Validate(); err != nil {
		return Point{}, false, err
	}
	if p.Longitude < 72.004 || p.Longitude > 137.8347 || p.Latitude < 0.8293 || p.Latitude > 55.8271 {
		return p, false, nil
	}
	x, y := p.Longitude-105, p.Latitude-35
	waves := func(v, a, b, firstPeriod, secondPeriod float64) float64 {
		return (a*math.Sin(v*math.Pi/firstPeriod) + b*math.Sin(v*math.Pi/secondPeriod)) * 2 / 3
	}
	shared := (20*math.Sin(6*x*math.Pi) + 20*math.Sin(2*x*math.Pi)) * 2 / 3
	latOffset := -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*math.Sqrt(math.Abs(x))
	latOffset += shared + waves(y, 20, 40, 1, 3) + waves(y, 160, 320, 12, 30)
	lonOffset := 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*math.Sqrt(math.Abs(x))
	lonOffset += shared + waves(x, 20, 40, 1, 3) + waves(x, 150, 300, 12, 30)
	const axis, eccentricity = 6378245.0, 0.00669342162296594323
	radians := p.Latitude * math.Pi / 180
	sin := math.Sin(radians)
	magic := 1 - eccentricity*sin*sin
	latOffset = latOffset * 180 / ((axis * (1 - eccentricity) / (magic * math.Sqrt(magic))) * math.Pi)
	lonOffset = lonOffset * 180 / (axis / math.Sqrt(magic) * math.Cos(radians) * math.Pi)
	return Point{Latitude: p.Latitude + latOffset, Longitude: p.Longitude + lonOffset}, true, nil
}

// MoveCenter uses a specified ground distance and bearing, never browser pixels.
func MoveCenter(p Point, direction string, meters float64) (Point, error) {
	if err := p.Validate(); err != nil {
		return Point{}, err
	}
	bearings := map[string]float64{"north": 0, "east": 90, "south": 180, "west": 270}
	bearing, ok := bearings[direction]
	if !ok || math.IsNaN(meters) || math.IsInf(meters, 0) || meters < 1 || meters > 1000 {
		return Point{}, errors.New("平移方向或距离无效（1–1000米）")
	}
	const earthRadius = 6378137.0
	angle, heading := meters/earthRadius, bearing*math.Pi/180
	lat, lon := p.Latitude*math.Pi/180, p.Longitude*math.Pi/180
	nextLat := math.Asin(math.Sin(lat)*math.Cos(angle) + math.Cos(lat)*math.Sin(angle)*math.Cos(heading))
	nextLon := lon + math.Atan2(math.Sin(heading)*math.Sin(angle)*math.Cos(lat), math.Cos(angle)-math.Sin(lat)*math.Sin(nextLat))
	return Point{Latitude: nextLat * 180 / math.Pi, Longitude: math.Mod(nextLon*180/math.Pi+540, 360) - 180}.Rounded(), nil
}
