package common

import "github.com/gin-gonic/gin"

const CtxUserUID = "ctx_user_uid"
const CtxMobile = "ctx_mobile"
const CtxPermission = "ctx_permission"

func GetUserUID(c *gin.Context) int64 {
	v, ok := c.Get(CtxUserUID)
	if !ok {
		return 0
	}
	uid, _ := v.(int64)
	return uid
}

func GetPermission(c *gin.Context) int {
	v, ok := c.Get(CtxPermission)
	if !ok {
		return 0
	}
	p, _ := v.(int)
	return p
}
