package main

import (
	"context"
	"fmt"
	"log"
	"strings"
	_ "time/tzdata"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/amap"
	"xbt2/server/internal/config"
	"xbt2/server/internal/db"
	"xbt2/server/internal/geo"
	"xbt2/server/internal/handler"
	"xbt2/server/internal/media"
	"xbt2/server/internal/middleware"
	"xbt2/server/internal/service"
	"xbt2/server/internal/xxt"
)

func main() {
	cfg := config.Load()
	gin.SetMode(resolveGinMode(cfg.AppEnv))

	database, err := db.New(cfg)
	if err != nil {
		log.Fatalf("db init failed: %v", err)
	}
	if _, err := service.NewSignLocationService(database, nil).ImportConfigured(context.Background(), cfg.SignLocations); err != nil {
		log.Fatalf("sign location config import failed: %v", err)
	}

	jwtSvc := service.NewJWTService(cfg.JWTSecret)
	credentialCrypto := service.NewCredentialCrypto(cfg.CredentialSecret)
	xxtClient := xxt.New(cfg.ChaoxingAESKey, cfg.ChaoxingUserAgent, cfg.AllowInsecureTLS, cfg.ActivityListLimit+1)
	addressClient := amap.NewClient(cfg.AMap, nil)
	xxtClient.SetSignAddressResolver(func(point geo.Point) (string, error) {
		return addressClient.ReverseAddress(context.Background(), point)
	})
	if err := xxtClient.SetSignLocationOffset(cfg.SignLocationOffset); err != nil {
		log.Fatalf("sign location offset init failed: %v", err)
	}

	authHandler := handler.NewAuthHandler(database, jwtSvc, credentialCrypto, xxtClient, cfg.PublicAccess, cfg.PublicAdmin)
	courseHandler := handler.NewCourseHandler(database, xxtClient, credentialCrypto)
	signSvc := service.NewSignService(database, xxtClient, credentialCrypto)
	signHandler := handler.NewSignHandler(database, xxtClient, credentialCrypto, signSvc, cfg.ActivityListLimit)
	whitelistHandler := handler.NewWhitelistHandler(database)
	locationService := service.NewSignLocationService(database, amap.NewClient(cfg.AMap, nil))
	locationHandler := handler.NewSignLocationHandler(locationService)
	if cfg.PersonalLocationsOnly {
		locationHandler.UsePersonalLocationsOnly()
		signSvc.UsePersonalLocationsOnly()
	}
	captureHandler := handler.NewLocationCaptureHandler(amap.NewStaticMapClient(cfg.AMap, nil))
	interactiveMapHandler := handler.NewAMapInteractiveHandler(cfg.AMap)
	imageCache, err := media.New(cfg.MediaCacheDir)
	if err != nil {
		log.Fatalf("image disk cache init failed: %v", err)
	}

	r := gin.New()
	r.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		path := param.Path
		if strings.HasPrefix(path, "/api/amap-service/") {
			path = "/api/amap-service/:grant/*path"
		} else if strings.HasPrefix(path, "/api/media/image") {
			path = "/api/media/image"
		}
		return fmt.Sprintf("%s - [%s] \"%s %s %s\" %d %d \"%s\" %s %v\n",
			param.ClientIP, param.TimeStamp.Format("2006/01/02 - 15:04:05"), param.Method, path,
			param.Request.Proto, param.StatusCode, param.BodySize, param.Request.UserAgent(), param.ErrorMessage, param.Latency)
	}), gin.Recovery())

	api := r.Group("/api")
	{
		api.GET("/health", func(c *gin.Context) {
			c.JSON(200, gin.H{"code": 0, "message": "ok", "data": gin.H{"service": "xbt2-server"}})
		})
		api.POST("/auth/login", authHandler.Login)
		api.GET("/amap-service/:grant/*path", interactiveMapHandler.Proxy)

		authed := api.Group("")
		authed.Use(middleware.Auth(jwtSvc), signHandler.InvalidateActivities)
		{
			authed.GET("/media/image", handler.MediaImage(imageCache))
			authed.GET("/courses", courseHandler.List)
			authed.POST("/courses/sync", courseHandler.Sync)
			authed.PUT("/courses/selection", courseHandler.UpdateSelection)

			authed.GET("/sign/activities", signHandler.Activities)
			authed.GET("/sign/classmates", signHandler.Classmates)
			authed.POST("/sign/check", signHandler.Check)
			authed.POST("/sign/execute", signHandler.Execute)
			authed.POST("/sign/photo", signHandler.Photo)
			authed.POST("/sign/photo/upload", signHandler.UploadPhoto)
			authed.GET("/sign/locations", locationHandler.ListEnabled)
			authed.GET("/sign/locations/settings", locationHandler.Settings)
			authed.GET("/sign/locations/personal", locationHandler.ListPersonal)
			authed.POST("/sign/locations/personal", locationHandler.CreatePersonal)
			authed.PUT("/sign/locations/personal/:id", locationHandler.UpdatePersonal)
			authed.DELETE("/sign/locations/personal/:id", locationHandler.DeletePersonal)
			authed.POST("/sign/locations/search-map", locationHandler.SearchMapCenter)
			authed.POST("/sign/locations/coordinate-preview", captureHandler.CoordinatePreview)
			authed.POST("/sign/locations/map-preview", captureHandler.MapPreview)
			authed.GET("/sign/locations/map-config", interactiveMapHandler.Config)

			if !cfg.DisableAdmin {
				admin := authed.Group("/admin")
				admin.Use(middleware.AdminOnly())
				{
					admin.GET("/whitelist/users", whitelistHandler.ListUsers)
					admin.POST("/whitelist/users", whitelistHandler.CreateUser)
					admin.POST("/whitelist/users/import", whitelistHandler.BatchImportUsers)
					admin.DELETE("/whitelist/users/:id", whitelistHandler.DeleteUser)
					locations := admin.Group("/sign-locations")
					if cfg.PersonalLocationsOnly {
						locations.Use(personalLocationGuard)
					}
					locations.GET("", locationHandler.List)
					locations.POST("/search", locationHandler.Search)
					locations.POST("/search-map", locationHandler.SearchMapCenter)
					locations.POST("/candidates", locationHandler.SaveCandidate)
					locations.POST("/coordinate-preview", captureHandler.CoordinatePreview)
					locations.POST("/map-preview", captureHandler.MapPreview)
					locations.POST("/:id/restore", locationHandler.RestoreCandidate)
					locations.POST("", locationHandler.Create)
					locations.PUT("/:id", locationHandler.Update)
					locations.POST("/:id/enable", locationHandler.Enable)
					locations.POST("/:id/disable", locationHandler.Disable)
					locations.DELETE("/:id", locationHandler.Delete)
				}
			}
		}
	}

	log.Printf("xbt2 server listening on %s (app_env=%s, gin_mode=%s)", cfg.HTTPAddr, cfg.AppEnv, gin.Mode())
	if err := r.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("server start failed: %v", err)
	}
}

func personalLocationGuard(c *gin.Context) {
	switch c.FullPath() {
	case "/api/admin/sign-locations/search", "/api/admin/sign-locations/search-map",
		"/api/admin/sign-locations/coordinate-preview", "/api/admin/sign-locations/map-preview":
		c.Next()
	default:
		c.AbortWithStatusJSON(403, gin.H{"code": 1, "message": "已启用个人地点模式，请使用我的常用地点接口"})
	}
}

func resolveGinMode(appEnv string) string {
	switch strings.ToLower(strings.TrimSpace(appEnv)) {
	case "prod", "production":
		return gin.ReleaseMode
	case "test", "testing":
		return gin.TestMode
	case "dev", "development":
		fallthrough
	default:
		return gin.DebugMode
	}
}
