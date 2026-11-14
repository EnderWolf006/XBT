package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"xbt2/server/internal/amap"
	"xbt2/server/internal/common"
	"xbt2/server/internal/model"
	"xbt2/server/internal/service"
)

func signLocationErrorHTTPStatus(err error, notFound bool) int {
	if notFound || errors.Is(err, gorm.ErrRecordNotFound) {
		return http.StatusNotFound
	}
	if errors.Is(err, service.ErrInvalidSignLocationInput) {
		return http.StatusBadRequest
	}
	if errors.Is(err, service.ErrSignLocationConflict) || errors.Is(err, service.ErrSignLocationDeleted) {
		return http.StatusConflict
	}
	return http.StatusInternalServerError
}

type SignLocationHandler struct {
	svc                   *service.SignLocationService
	personalLocationsOnly bool
}

func NewSignLocationHandler(svc *service.SignLocationService) *SignLocationHandler {
	return &SignLocationHandler{svc: svc}
}
func (h *SignLocationHandler) UsePersonalLocationsOnly() {
	h.personalLocationsOnly = true
}
func (h *SignLocationHandler) Settings(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	common.Success(c, gin.H{"personal_only": h.personalLocationsOnly})
}
func (h *SignLocationHandler) ListPersonal(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	rows, err := h.svc.ListPersonal(c.Request.Context(), common.GetUserUID(c))
	if err != nil {
		common.Fail(c, signLocationErrorHTTPStatus(err, false), "query personal sign locations failed")
		return
	}
	common.Success(c, rows)
}
func parseSignLocationID(v string) (uint, error) {
	n, err := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
	if err != nil || n == 0 {
		return 0, errors.New("invalid id")
	}
	return uint(n), nil
}
func (h *SignLocationHandler) List(c *gin.Context) {
	rows, err := h.svc.List(c.Request.Context(), c.Query("status"))
	if err != nil {
		status := signLocationErrorHTTPStatus(err, false)
		common.Fail(c, status, "query sign locations failed")
		return
	}
	common.Success(c, rows)
}
func (h *SignLocationHandler) ListEnabled(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	if h.personalLocationsOnly {
		h.ListPersonal(c)
		return
	}
	rows, err := h.svc.ListEnabledForUser(c.Request.Context(), common.GetUserUID(c))
	if err != nil {
		common.Fail(c, 500, "query sign locations failed")
		return
	}
	common.Success(c, rows)
}

type personalLocationRequest struct {
	Name      string   `json:"name"`
	Address   string   `json:"address"`
	Latitude  *float64 `json:"latitude" binding:"required"`
	Longitude *float64 `json:"longitude" binding:"required"`
}

func (h *SignLocationHandler) CreatePersonal(c *gin.Context) {
	var req personalLocationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, http.StatusBadRequest, "invalid request")
		return
	}
	row, err := h.svc.CreatePersonal(c.Request.Context(), common.GetUserUID(c), service.CreateSignLocationInput{
		Name: req.Name, Address: req.Address, Latitude: *req.Latitude, Longitude: *req.Longitude,
	})
	if err != nil {
		common.Fail(c, signLocationErrorHTTPStatus(err, false), "save personal sign location failed")
		return
	}
	common.Success(c, row)
}
func (h *SignLocationHandler) UpdatePersonal(c *gin.Context) {
	id, err := parseSignLocationID(c.Param("id"))
	if err != nil {
		common.Fail(c, http.StatusBadRequest, err.Error())
		return
	}
	var req personalLocationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, http.StatusBadRequest, "invalid request")
		return
	}
	err = h.svc.UpdatePersonal(c.Request.Context(), common.GetUserUID(c), id, service.UpdateSignLocationInput{
		Name: req.Name, Address: req.Address, Latitude: *req.Latitude, Longitude: *req.Longitude,
	})
	if err != nil {
		common.Fail(c, signLocationErrorHTTPStatus(err, false), "update personal sign location failed")
		return
	}
	common.Success(c, gin.H{"id": id})
}
func (h *SignLocationHandler) DeletePersonal(c *gin.Context) {
	id, err := parseSignLocationID(c.Param("id"))
	if err != nil {
		common.Fail(c, http.StatusBadRequest, err.Error())
		return
	}
	err = h.svc.DeletePersonal(c.Request.Context(), common.GetUserUID(c), id)
	if err != nil {
		status := signLocationErrorHTTPStatus(err, errors.Is(err, gorm.ErrRecordNotFound))
		common.Fail(c, status, "delete personal sign location failed")
		return
	}
	common.Success(c, gin.H{"id": id})
}
func (h *SignLocationHandler) Search(c *gin.Context) {
	h.search(c, "search sign location candidates failed")
}
func (h *SignLocationHandler) SearchMapCenter(c *gin.Context) {
	h.searchMapCenter(c)
}
func (h *SignLocationHandler) searchMapCenter(c *gin.Context) {
	var req amap.SearchQuery
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, http.StatusBadRequest, "invalid request")
		return
	}
	req.Scope = "full"
	rows, err := h.svc.SearchMapCandidates(c.Request.Context(), req)
	queryKeywords, queryErr := h.svc.QueryKeywords(req)
	if queryErr != nil {
		common.Fail(c, http.StatusBadRequest, "无法构造检索词，请检查完整地点名称")
		return
	}
	if err != nil {
		c.JSON(signLocationErrorHTTPStatus(err, false), gin.H{"code": 1, "message": "搜索地图地点失败", "data": nil, "query_keywords": queryKeywords})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "ok", "data": rows, "query_keywords": queryKeywords})
}
func (h *SignLocationHandler) search(c *gin.Context, failureMessage string) {
	var req amap.SearchQuery
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}
	rows, err := h.svc.SearchCandidates(c.Request.Context(), req)
	queryKeywords, queryErr := h.svc.QueryKeywords(req)
	if queryErr != nil {
		common.Fail(c, http.StatusBadRequest, "无法构造检索词，请检查校区配置或完整名称模式")
		return
	}
	if err != nil {
		c.JSON(signLocationErrorHTTPStatus(err, false), gin.H{"code": 1, "message": failureMessage, "data": nil, "query_keywords": queryKeywords})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "ok", "data": rows, "query_keywords": queryKeywords})
}
func (h *SignLocationHandler) SaveCandidate(c *gin.Context) {
	var req struct {
		Name      string   `json:"name"`
		Address   string   `json:"address"`
		Latitude  *float64 `json:"latitude"`
		Longitude *float64 `json:"longitude"`
		AMAPPoiID string   `json:"amap_poi_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Latitude == nil || req.Longitude == nil {
		common.Fail(c, 400, "候选地点格式无效")
		return
	}
	result, err := h.svc.SaveCandidate(c.Request.Context(), service.SignLocationCandidate{
		Name: req.Name, Address: req.Address, Latitude: *req.Latitude, Longitude: *req.Longitude, AMAPPoiID: req.AMAPPoiID,
	})
	if err != nil {
		var deleted *service.DeletedSignLocationError
		if errors.As(err, &deleted) {
			c.JSON(http.StatusConflict, common.APIResponse{Code: 1, Message: "该候选对应的地点已被删除，可明确确认恢复为待确认", Data: gin.H{
				"error_code": "SIGN_LOCATION_DELETED", "location": deleted.Location,
			}})
			return
		}
		message := "保存候选地点失败，请核对名称、地址和坐标"
		common.Fail(c, signLocationErrorHTTPStatus(err, false), message)
		return
	}
	common.Success(c, result)
}
func (h *SignLocationHandler) RestoreCandidate(c *gin.Context) {
	id, err := parseSignLocationID(c.Param("id"))
	var req struct {
		Confirmed bool `json:"confirmed"`
	}
	if err != nil || c.ShouldBindJSON(&req) != nil || !req.Confirmed {
		common.Fail(c, http.StatusBadRequest, "恢复需要有效地点ID及明确确认")
		return
	}
	result, err := h.svc.RestoreCandidate(c.Request.Context(), id)
	if err != nil {
		code, message := "SIGN_LOCATION_RESTORE_FAILED", "恢复地点失败，请稍后重试"
		if errors.Is(err, service.ErrSignLocationConflict) {
			code, message = "SIGN_LOCATION_CONFLICT", "已有地点使用相同POI或名称地址坐标，未恢复旧记录，请先核对已保存地点"
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			code, message = "SIGN_LOCATION_NOT_FOUND", "待恢复的地点不存在"
		}
		c.JSON(signLocationErrorHTTPStatus(err, false), common.APIResponse{Code: 1, Message: message, Data: gin.H{"error_code": code}})
		return
	}
	common.Success(c, result)
}
func (h *SignLocationHandler) Create(c *gin.Context) {
	var req service.CreateSignLocationInput
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}
	row, err := h.svc.Create(req)
	if err != nil {
		status := signLocationErrorHTTPStatus(err, false)
		common.Fail(c, status, "create sign location failed")
		return
	}
	common.Success(c, row)
}
func (h *SignLocationHandler) Update(c *gin.Context) {
	id, err := parseSignLocationID(c.Param("id"))
	if err != nil {
		common.Fail(c, 400, err.Error())
		return
	}
	var req service.UpdateSignLocationInput
	if c.ShouldBindJSON(&req) != nil {
		common.Fail(c, 400, "invalid request")
		return
	}
	if err = h.svc.Update(id, req); err != nil {
		common.Fail(c, signLocationErrorHTTPStatus(err, false), "update sign location failed")
		return
	}
	common.Success(c, gin.H{"id": id})
}
func (h *SignLocationHandler) setStatus(c *gin.Context, status string) {
	id, err := parseSignLocationID(c.Param("id"))
	if err != nil {
		common.Fail(c, 400, err.Error())
		return
	}
	if err = h.svc.SetStatus(id, status); err != nil {
		common.Fail(c, signLocationErrorHTTPStatus(err, false), "update sign location status failed")
		return
	}
	common.Success(c, gin.H{"id": id, "status": status})
}
func (h *SignLocationHandler) Enable(c *gin.Context)  { h.setStatus(c, model.SignLocationEnabled) }
func (h *SignLocationHandler) Disable(c *gin.Context) { h.setStatus(c, model.SignLocationDisabled) }
func (h *SignLocationHandler) Delete(c *gin.Context) {
	id, err := parseSignLocationID(c.Param("id"))
	if err != nil {
		common.Fail(c, 400, err.Error())
		return
	}
	if err = h.svc.SoftDelete(id); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			common.Fail(c, http.StatusNotFound, "not found")
		} else {
			common.Fail(c, http.StatusInternalServerError, "delete sign location failed")
		}
		return
	}
	common.Success(c, gin.H{"id": id})
}
