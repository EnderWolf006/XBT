package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/common"
	"xbt2/server/internal/service"
)

func Auth(jwtSvc *service.JWTService) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		if auth == "" || !strings.HasPrefix(auth, "Bearer ") {
			common.Fail(c, 401, "unauthorized")
			c.Abort()
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer"))
		claims, err := jwtSvc.Parse(token)
		if err != nil {
			common.Fail(c, 401, "invalid token")
			c.Abort()
			return
		}
		c.Set(common.CtxUserUID, claims.UID)
		c.Set(common.CtxMobile, claims.Mobile)
		c.Set(common.CtxPermission, claims.Permission)
		c.Next()
	}
}

func AdminOnly() gin.HandlerFunc {
	return func(c *gin.Context) {
		if common.GetPermission(c) < 2 {
			common.Fail(c, 403, "admin permission required")
			c.Abort()
			return
		}
		c.Next()
	}
}
