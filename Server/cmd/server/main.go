package main

import (
	"log"
	"strings"

	"github.com/gin-gonic/gin"
	"xbt2/server/internal/config"
	"xbt2/server/internal/db"
	"xbt2/server/internal/handler"
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

	jwtSvc := service.NewJWTService(cfg.JWTSecret)
	credentialCrypto := service.NewCredentialCrypto(cfg.CredentialSecret)
	xxtClient := xxt.New(cfg.ChaoxingAESKey, cfg.ChaoxingUserAgent, cfg.AllowInsecureTLS, cfg.ActivityListLimit+1)

	authHandler := handler.NewAuthHandler(database, jwtSvc, credentialCrypto, xxtClient)
	courseHandler := handler.NewCourseHandler(database, xxtClient, credentialCrypto)
	signSvc := service.NewSignService(database, xxtClient, credentialCrypto)
	signHandler := handler.NewSignHandler(database, xxtClient, credentialCrypto, signSvc, cfg.ActivityListLimit)
	whitelistHandler := handler.NewWhitelistHandler(database)

	r := gin.Default()

	api := r.Group("/api")
	{
		api.GET("/health", func(c *gin.Context) {
			c.JSON(200, gin.H{"code": 0, "message": "ok", "data": gin.H{"service": "xbt2-server"}})
		})
		api.POST("/auth/login", authHandler.Login)

		authed := api.Group("")
		authed.Use(middleware.Auth(jwtSvc))
		{
			authed.GET("/courses", courseHandler.List)
			authed.POST("/courses/sync", courseHandler.Sync)
			authed.PUT("/courses/selection", courseHandler.UpdateSelection)

			authed.GET("/sign/activities", signHandler.Activities)
			authed.GET("/sign/classmates", signHandler.Classmates)
			authed.POST("/sign/check", signHandler.Check)
			authed.POST("/sign/execute", signHandler.Execute)

			admin := authed.Group("/admin")
			admin.Use(middleware.AdminOnly())
			{
				admin.GET("/whitelist/users", whitelistHandler.ListUsers)
				admin.POST("/whitelist/users", whitelistHandler.CreateUser)
				admin.POST("/whitelist/users/import", whitelistHandler.BatchImportUsers)
				admin.DELETE("/whitelist/users/:id", whitelistHandler.DeleteUser)
			}
		}
	}

	log.Printf("xbt2 server listening on %s (app_env=%s, gin_mode=%s)", cfg.HTTPAddr, cfg.AppEnv, gin.Mode())
	if err := r.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("server start failed: %v", err)
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
