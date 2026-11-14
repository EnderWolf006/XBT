package service

import (
	"context"
	"fmt"
	"strings"

	"gorm.io/gorm"
	"xbt2/server/internal/config"
	"xbt2/server/internal/model"
)

// prepareConfiguredSignLocations validates and normalizes the complete seed
// before any database write occurs.
func prepareConfiguredSignLocations(inputs []config.SignLocationConfig) ([]model.SignLocation, error) {
	rows := make([]model.SignLocation, 0, len(inputs))
	seen := make(map[string]struct{}, len(inputs))
	for i, in := range inputs {
		status := strings.TrimSpace(in.Status)
		if status == "" {
			status = model.SignLocationPending
		}
		rowInput := CreateSignLocationInput{
			Name: strings.TrimSpace(in.Name), Address: strings.TrimSpace(in.Address),
			Latitude: in.Latitude, Longitude: in.Longitude,
			AMAPPoiID: strings.TrimSpace(in.AMAPPoiID), Status: status, Source: "config",
		}
		if err := validateSignLocation(rowInput); err != nil {
			return nil, fmt.Errorf("sign_locations[%d]: %w", i, err)
		}
		row := model.SignLocation{Name: rowInput.Name, Address: rowInput.Address, Latitude: rowInput.Latitude, Longitude: rowInput.Longitude, AMAPPoiID: rowInput.AMAPPoiID, Status: status, Source: "config"}
		row.Latitude, row.Longitude = normalizeSignLocationCoordinates(row.Latitude, row.Longitude)
		identity := configuredSignLocationIdentity(config.SignLocationConfig{Name: row.Name, Address: row.Address, Latitude: row.Latitude, Longitude: row.Longitude, AMAPPoiID: row.AMAPPoiID})
		if _, exists := seen[identity]; exists {
			return nil, fmt.Errorf("sign_locations[%d]: duplicate identity %q", i, identity)
		}
		seen[identity] = struct{}{}
		rows = append(rows, row)
	}
	return rows, nil
}

func configuredSignLocationIdentity(in config.SignLocationConfig) string {
	if poiID := strings.TrimSpace(in.AMAPPoiID); poiID != "" {
		return "poi:" + poiID
	}
	return fmt.Sprintf("coord:%.6f|%.6f", in.Latitude, in.Longitude)
}

// ImportConfigured validates all configured locations and inserts only missing
// records. Existing records are intentionally never updated: this preserves
// manual/AMap records and any administrator edits to config-owned records.
func (s *SignLocationService) ImportConfigured(ctx context.Context, inputs []config.SignLocationConfig) ([]model.SignLocation, error) {
	rows, err := prepareConfiguredSignLocations(inputs)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []model.SignLocation{}, nil
	}
	created := make([]model.SignLocation, 0, len(rows))
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, row := range rows {
			var existing model.SignLocation
			q := tx.Unscoped().Where("deleted_at IS NULL")
			if row.AMAPPoiID != "" {
				q = q.Where("amap_poi_id = ?", row.AMAPPoiID)
			} else {
				q = q.Where("latitude = ? AND longitude = ?", row.Latitude, row.Longitude)
			}
			findErr := q.First(&existing).Error
			switch {
			case findErr == nil:
				created = append(created, existing)
			case findErr == gorm.ErrRecordNotFound:
				if createErr := tx.Create(&row).Error; createErr != nil {
					return classifySignLocationError(createErr)
				}
				created = append(created, row)
			default:
				return findErr
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}
