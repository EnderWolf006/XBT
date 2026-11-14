package handler

import (
	"context"
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/amap"
	"xbt2/server/internal/common"
	"xbt2/server/internal/geo"
)

type MapPreviewer interface {
	Preview(context.Context, *geo.Point, int) (amap.MapPreview, error)
}
type LocationCaptureHandler struct{ maps MapPreviewer }

func NewLocationCaptureHandler(maps MapPreviewer) *LocationCaptureHandler {
	return &LocationCaptureHandler{maps: maps}
}

func (h *LocationCaptureHandler) CoordinatePreview(c *gin.Context) {
	var req struct {
		Latitude   *float64  `json:"latitude"`
		Longitude  *float64  `json:"longitude"`
		Accuracy   *float64  `json:"accuracy"`
		CapturedAt time.Time `json:"captured_at"`
	}
	if c.ShouldBindJSON(&req) != nil || req.Latitude == nil || req.Longitude == nil || req.Accuracy == nil ||
		math.IsNaN(*req.Accuracy) || math.IsInf(*req.Accuracy, 0) || *req.Accuracy < 0 || req.CapturedAt.IsZero() {
		common.Fail(c, http.StatusBadRequest, "定位预览需要WGS-84坐标、精度及采集时间")
		return
	}
	point, converted, err := geo.WGS84ToGCJ02(geo.Point{Latitude: *req.Latitude, Longitude: *req.Longitude})
	if err != nil {
		common.Fail(c, http.StatusBadRequest, err.Error())
		return
	}
	c.Header("Cache-Control", "no-store")
	common.Success(c, gin.H{"point": point.Rounded(), "coordinate_system": "GCJ-02", "converted": converted,
		"accuracy": *req.Accuracy, "captured_at": req.CapturedAt, "poor_accuracy": *req.Accuracy > 50,
		"warning": "转换为近似算法；采集点不能证明位于老师设定的签到范围内"})
}

func (h *LocationCaptureHandler) MapPreview(c *gin.Context) {
	var req struct {
		Center *struct {
			Latitude  *float64 `json:"latitude"`
			Longitude *float64 `json:"longitude"`
		} `json:"center"`
		Zoom      int     `json:"zoom"`
		Direction string  `json:"direction"`
		Meters    float64 `json:"meters"`
	}
	if c.ShouldBindJSON(&req) != nil || req.Zoom < 1 || req.Zoom > 17 ||
		(req.Center != nil && (req.Center.Latitude == nil || req.Center.Longitude == nil)) {
		common.Fail(c, http.StatusBadRequest, "地图中心或缩放级别无效（1–17）")
		return
	}
	var center *geo.Point
	if req.Center != nil {
		center = &geo.Point{Latitude: *req.Center.Latitude, Longitude: *req.Center.Longitude}
		if center.Validate() != nil || center.Latitude <= -85 || center.Latitude >= 85 {
			common.Fail(c, http.StatusBadRequest, "地图中心坐标无效")
			return
		}
	}
	if req.Direction != "" {
		if center == nil {
			common.Fail(c, http.StatusBadRequest, "平移必须提供当前中心")
			return
		}
		point, err := geo.MoveCenter(*center, req.Direction, req.Meters)
		if err != nil {
			common.Fail(c, http.StatusBadRequest, err.Error())
			return
		}
		center = &point
	}
	result, err := h.maps.Preview(c.Request.Context(), center, req.Zoom)
	if err != nil {
		common.Fail(c, http.StatusBadGateway, err.Error())
		return
	}
	c.Header("Cache-Control", "no-store")
	common.Success(c, result)
}
