package handler

import (
	"regexp"
	"sort"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"xbt2/server/internal/common"
	"xbt2/server/internal/dto"
	"xbt2/server/internal/model"
)

type WhitelistHandler struct {
	db *gorm.DB
}

type whitelistUserView struct {
	ID           uint   `json:"id"`
	UID          int64  `json:"uid"`
	MobileMasked string `json:"mobile_masked"`
	Permission   int    `json:"permission"`
}

func NewWhitelistHandler(db *gorm.DB) *WhitelistHandler {
	return &WhitelistHandler{db: db}
}

// ListUsers returns only ordinary whitelist users (permission=1).
func (h *WhitelistHandler) ListUsers(c *gin.Context) {
	var rows []struct {
		ID         uint
		Mobile     string
		Permission int
		UID        int64
	}
	err := h.db.Table("whitelists w").
		Select("w.id, w.mobile, w.permission, COALESCE(u.uid, 0) as uid").
		Joins("left join users u on u.mobile = w.mobile").
		Where("w.permission = ?", 1).
		Order("w.mobile asc").
		Scan(&rows).Error
	if err != nil {
		common.Fail(c, 500, "query whitelist users failed")
		return
	}

	resp := make([]whitelistUserView, 0, len(rows))
	for _, r := range rows {
		resp = append(resp, whitelistUserView{
			ID:           r.ID,
			UID:          r.UID,
			MobileMasked: common.MaskMobile(r.Mobile),
			Permission:   r.Permission,
		})
	}
	common.Success(c, resp)
}

// CreateUser only supports ordinary user whitelist entries (permission=1).
func (h *WhitelistHandler) CreateUser(c *gin.Context) {
	var req dto.AddWhitelistRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}

	var existing model.Whitelist
	if err := h.db.Where("mobile = ?", req.Mobile).First(&existing).Error; err == nil && existing.Permission >= 2 {
		common.Fail(c, 400, "管理员账号不允许通过该接口修改")
		return
	}

	row := model.Whitelist{Mobile: req.Mobile, Permission: 1}
	if err := h.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "mobile"}},
		DoUpdates: clause.AssignmentColumns([]string{"permission", "updated_at"}),
	}).Create(&row).Error; err != nil {
		common.Fail(c, 500, "upsert whitelist user failed")
		return
	}
	_ = h.db.Model(&model.User{}).Where("mobile = ?", req.Mobile).Update("permission", 1).Error

	uid := int64(0)
	var user model.User
	if err := h.db.Where("mobile = ?", req.Mobile).Take(&user).Error; err == nil {
		uid = user.UID
	}
	common.Success(c, gin.H{
		"id":            row.ID,
		"uid":           uid,
		"mobile_masked": common.MaskMobile(req.Mobile),
		"permission":    1,
	})
}

// BatchImportUsers imports ordinary users by text blob.
func (h *WhitelistHandler) BatchImportUsers(c *gin.Context) {
	var req dto.BatchWhitelistRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}

	re := regexp.MustCompile(`1\d{10}`)
	mobiles := re.FindAllString(req.Mobiles, -1)
	if len(mobiles) == 0 {
		common.Fail(c, 400, "no valid mobile number found")
		return
	}

	set := map[string]struct{}{}
	for _, m := range mobiles {
		set[m] = struct{}{}
	}
	uniq := make([]string, 0, len(set))
	for m := range set {
		uniq = append(uniq, m)
	}
	sort.Strings(uniq)

	added := 0
	skippedAdmin := 0
	for _, m := range uniq {
		var existing model.Whitelist
		if err := h.db.Where("mobile = ?", m).First(&existing).Error; err == nil && existing.Permission >= 2 {
			skippedAdmin++
			continue
		}

		row := model.Whitelist{Mobile: m, Permission: 1}
		_ = h.db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "mobile"}},
			DoUpdates: clause.AssignmentColumns([]string{"permission", "updated_at"}),
		}).Create(&row).Error
		_ = h.db.Model(&model.User{}).Where("mobile = ?", m).Update("permission", 1).Error
		added++
	}

	common.Success(c, gin.H{
		"count":         added,
		"skipped_admin": skippedAdmin,
	})
}

// DeleteUser removes ordinary whitelist user by whitelist id.
func (h *WhitelistHandler) DeleteUser(c *gin.Context) {
	idText := c.Param("id")
	id64, err := strconv.ParseUint(idText, 10, 64)
	if err != nil || id64 == 0 {
		common.Fail(c, 400, "invalid id")
		return
	}
	id := uint(id64)

	var wl model.Whitelist
	if err := h.db.Where("id = ?", id).First(&wl).Error; err != nil {
		common.Fail(c, 404, "not found")
		return
	}
	if wl.Permission >= 2 {
		common.Fail(c, 400, "cannot delete admin account")
		return
	}

	if err := h.db.Where("id = ?", id).Delete(&model.Whitelist{}).Error; err != nil {
		common.Fail(c, 500, "delete failed")
		return
	}
	_ = h.db.Model(&model.User{}).Where("mobile = ?", wl.Mobile).Update("permission", 0).Error

	common.Success(c, gin.H{
		"id":            id,
		"uid":           int64(0),
		"mobile_masked": common.MaskMobile(wl.Mobile),
	})
}
