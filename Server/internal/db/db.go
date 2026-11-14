package db

import (
	"fmt"
	"log"
	"os"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
	"xbt2/server/internal/config"
	"xbt2/server/internal/model"
)

func New(cfg config.Config) (*gorm.DB, error) {
	newLogger := gormlogger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		gormlogger.Config{
			LogLevel:                  gormlogger.Warn,
			IgnoreRecordNotFoundError: true,
			Colorful:                  false,
		},
	)

	db, err := gorm.Open(postgres.Open(cfg.PostgresDSN), &gorm.Config{
		Logger: newLogger,
	})
	if err != nil {
		return nil, fmt.Errorf("connect postgres failed: %w", err)
	}

	if err := db.AutoMigrate(
		&model.User{},
		&model.Whitelist{},
		&model.Course{},
		&model.UserCourse{},
		&model.SignActivity{},
		&model.SignRecord{},
		&model.SignLocation{},
	); err != nil {
		return nil, fmt.Errorf("auto migrate failed: %w", err)
	}

	if err := ensureSignLocationSchema(db); err != nil {
		return nil, fmt.Errorf("sign location schema setup failed: %w", err)
	}

	return db, nil
}

func ensureSignLocationSchema(db *gorm.DB) error {
	statements := []string{
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_sign_locations_name_address_coords' AND indexdef NOT LIKE '%owner_uid IS NULL%') THEN
				DROP INDEX uq_sign_locations_name_address_coords;
			END IF;
		END $$`,
		"CREATE UNIQUE INDEX IF NOT EXISTS uq_sign_locations_name_address_coords ON sign_locations (name, address, latitude, longitude) WHERE owner_uid IS NULL AND deleted_at IS NULL",
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_sign_locations_amap_poi_id' AND indexdef NOT LIKE '%owner_uid IS NULL%') THEN
				DROP INDEX uq_sign_locations_amap_poi_id;
			END IF;
		END $$`,
		"CREATE UNIQUE INDEX IF NOT EXISTS uq_sign_locations_amap_poi_id ON sign_locations (amap_poi_id) WHERE owner_uid IS NULL AND amap_poi_id IS NOT NULL AND amap_poi_id <> '' AND deleted_at IS NULL",
		"CREATE UNIQUE INDEX IF NOT EXISTS uq_sign_locations_user_name_address_coords ON sign_locations (owner_uid, name, address, latitude, longitude) WHERE owner_uid IS NOT NULL AND deleted_at IS NULL",
		"ALTER TABLE sign_locations DROP CONSTRAINT IF EXISTS sign_locations_status_check",
		"ALTER TABLE sign_locations ADD CONSTRAINT sign_locations_status_check CHECK (status IN ('pending', 'enabled', 'disabled'))",
	}
	for _, statement := range statements {
		if err := db.Exec(statement).Error; err != nil {
			return err
		}
	}
	return nil
}
