package handler

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/common"
	"xbt2/server/internal/media"
)

func MediaImage(cache *media.Cache) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Header("Cache-Control", "private, no-store")
		image, hit, err := cache.Open(c.Request.Context(), common.GetUserUID(c), c.Query("source"))
		if err != nil {
			status := http.StatusBadGateway
			if errors.Is(err, media.ErrSource) {
				status = http.StatusBadRequest
			} else if errors.Is(err, media.ErrBusy) {
				status = http.StatusTooManyRequests
				c.Header("Retry-After", "2")
			}
			log.Printf("image delivery failed: status=%d elapsed=%s", status, time.Since(start))
			common.Fail(c, status, "图片加载失败，请稍后重试")
			return
		}
		defer image.Close()
		state := "MISS"
		if hit {
			state = "HIT"
		}
		c.Header("X-Image-Cache", state)
		c.Header("Server-Timing", fmt.Sprintf("image;dur=%.2f", float64(time.Since(start).Microseconds())/1000))
		c.Header("Content-Type", image.ContentType)
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Cache-Control", "private, max-age=3600")
		c.Header("Vary", "Authorization")
		http.ServeContent(c.Writer, c.Request, "", image.Modified, image)
	}
}
