package handler

import (
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"xbt2/server/internal/common"
	"xbt2/server/internal/dto"
	"xbt2/server/internal/model"
	"xbt2/server/internal/service"
	"xbt2/server/internal/xxt"
)

type AuthHandler struct {
	db     *gorm.DB
	jwt    *service.JWTService
	cc     *service.CredentialCrypto
	xxtCli *xxt.Client
}

func NewAuthHandler(db *gorm.DB, jwt *service.JWTService, cc *service.CredentialCrypto, xxtCli *xxt.Client) *AuthHandler {
	return &AuthHandler{db: db, jwt: jwt, cc: cc, xxtCli: xxtCli}
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req dto.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}

	wl, allowed, err := h.resolveWhitelist(req.Mobile)
	if err != nil {
		common.Fail(c, 500, err.Error())
		return
	}
	if !allowed {
		common.Fail(c, 403, "账号未授权")
		return
	}

	loginResult, err := h.xxtCli.PreLogin(req.Mobile, req.Password)
	if err != nil {
		common.Fail(c, 401, err.Error())
		return
	}

	cipher, err := h.cc.Encrypt(req.Password)
	if err != nil {
		common.Fail(c, 500, "credential encrypt failed")
		return
	}

	user := model.User{
		UID:              loginResult.UID,
		Mobile:           req.Mobile,
		Name:             loginResult.Name,
		Avatar:           loginResult.Avatar,
		CredentialCipher: cipher,
		Permission:       wl.Permission,
		LastLoginAt:      time.Now(),
	}
	if err := h.db.Where("uid = ?", user.UID).Assign(user).FirstOrCreate(&user).Error; err != nil {
		common.Fail(c, 500, "save user failed")
		return
	}

	token, err := h.jwt.Sign(user.UID, user.Mobile, user.Permission)
	if err != nil {
		common.Fail(c, 500, "token generate failed")
		return
	}

	common.Success(c, dto.LoginResponse{
		Token: token,
		User: gin.H{
			"uid":        user.UID,
			"name":       user.Name,
			"mobile":     common.MaskMobile(user.Mobile),
			"avatar":     user.Avatar,
			"permission": user.Permission,
		},
	})
}

func (h *AuthHandler) resolveWhitelist(mobile string) (model.Whitelist, bool, error) {
	var cnt int64
	if err := h.db.Model(&model.Whitelist{}).Count(&cnt).Error; err != nil {
		return model.Whitelist{}, false, err
	}
	if cnt == 0 {
		bootstrap := model.Whitelist{Mobile: mobile, Permission: 2}
		if err := h.db.Create(&bootstrap).Error; err != nil {
			return model.Whitelist{}, false, err
		}
		return bootstrap, true, nil
	}
	var wl model.Whitelist
	if err := h.db.Where("mobile = ?", mobile).First(&wl).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return model.Whitelist{}, false, nil
		}
		return model.Whitelist{}, false, err
	}
	if wl.Permission <= 0 {
		return wl, false, nil
	}
	return wl, true, nil
}
