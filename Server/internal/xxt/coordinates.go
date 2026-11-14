package xxt

import (
	"fmt"
	"strconv"
	"strings"

	"xbt2/server/internal/geo"
)

// Configure before the client starts serving requests.
func (c *Client) SetSignLocationOffset(offset geo.Point) error {
	if err := offset.Validate(); err != nil {
		return fmt.Errorf("invalid sign_location_offset: %w", err)
	}
	c.signLocationOffset = offset
	return nil
}

// Keep map/storage coordinates unchanged; offset and adapt once at the boundary.
// Unmarked legacy payloads retain their historical wire representation.
func prepareSignCoordinates(special map[string]interface{}, offset geo.Point) (map[string]interface{}, error) {
	return prepareSignCoordinatesWithAddress(special, offset, nil)
}

// Configure before the client starts serving requests.
func (c *Client) SetSignAddressResolver(resolve func(geo.Point) (string, error)) {
	c.signAddressResolver = resolve
}

func prepareSignCoordinatesWithAddress(special map[string]interface{}, offset geo.Point, resolve func(geo.Point) (string, error)) (map[string]interface{}, error) {
	system := strings.TrimSpace(strVal(special["coordinate_system"]))
	if system == "" {
		return special, nil
	}
	if system != "GCJ-02" && system != "BD-09" {
		return nil, fmt.Errorf("不支持的签到坐标系：%s", system)
	}
	latitude, latErr := strconv.ParseFloat(strings.TrimSpace(strVal(special["latitude"])), 64)
	longitude, lngErr := strconv.ParseFloat(strings.TrimSpace(strVal(special["longitude"])), 64)
	point := geo.Point{Latitude: latitude, Longitude: longitude}
	if latErr != nil || lngErr != nil || point.Validate() != nil {
		return nil, fmt.Errorf("签到坐标无效，请重新选择地点")
	}
	description := strVal(special["description"])
	if system == "GCJ-02" {
		var err error
		if offset.Latitude != 0 || offset.Longitude != 0 {
			point, err = point.OffsetBy(offset)
			if err != nil {
				return nil, fmt.Errorf("全局签到偏移后的坐标无效：%w", err)
			}
		}
		if resolve != nil {
			description, err = resolve(point)
			if err != nil || strings.TrimSpace(description) == "" {
				return nil, fmt.Errorf("签到地址解析失败，请稍后重试")
			}
			description = strings.TrimSpace(description)
		}
		point, err = geo.GCJ02ToBD09(point)
		if err != nil {
			return nil, fmt.Errorf("签到坐标转换失败：%w", err)
		}
	}
	resolved := make(map[string]interface{}, len(special))
	for key, value := range special {
		resolved[key] = value
	}
	resolved["latitude"] = fmt.Sprintf("%.6f", point.Latitude)
	resolved["longitude"] = fmt.Sprintf("%.6f", point.Longitude)
	resolved["coordinate_system"] = "BD-09"
	resolved["description"] = description
	delete(resolved, "location")
	return resolved, nil
}
