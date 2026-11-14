package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"xbt2/server/internal/amap"
	"xbt2/server/internal/model"
)

type POISearcher interface {
	SearchPOI(context.Context, amap.SearchQuery) ([]amap.POI, error)
	QueryKeywords(amap.SearchQuery) (string, error)
}

var ErrInvalidSignLocationInput = errors.New("invalid sign location input")
var ErrSignLocationConflict = errors.New("sign location already exists")
var ErrSignLocationDeleted = errors.New("sign location was deleted")

type DeletedSignLocationError struct {
	Location model.SignLocation
}

func (e *DeletedSignLocationError) Error() string { return ErrSignLocationDeleted.Error() }
func (e *DeletedSignLocationError) Unwrap() error { return ErrSignLocationDeleted }

type SignLocationService struct {
	db   *gorm.DB
	amap POISearcher
}

type CreateSignLocationInput struct {
	Name      string  `json:"name"`
	Address   string  `json:"address"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	AMAPPoiID string  `json:"amap_poi_id"`
	Status    string  `json:"status"`
	Source    string  `json:"source"`
}
type UpdateSignLocationInput struct {
	Name      string  `json:"name"`
	Address   string  `json:"address"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Source    string  `json:"source"`
}
type SignLocationCandidate struct {
	Name      string  `json:"name"`
	Address   string  `json:"address"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	AMAPPoiID string  `json:"amap_poi_id"`
	Source    string  `json:"source"`
}
type SaveCandidateResult struct {
	Location model.SignLocation `json:"location"`
	Created  bool               `json:"created"`
	Restored bool               `json:"restored"`
}

func NewSignLocationService(db *gorm.DB, client POISearcher) *SignLocationService {
	return &SignLocationService{db: db, amap: client}
}
func validateSignLocation(in CreateSignLocationInput) error {
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.Address) == "" {
		return fmt.Errorf("%w: name and address are required", ErrInvalidSignLocationInput)
	}
	if math.IsNaN(in.Latitude) || math.IsInf(in.Latitude, 0) || math.IsNaN(in.Longitude) || math.IsInf(in.Longitude, 0) {
		return fmt.Errorf("%w: invalid coordinates", ErrInvalidSignLocationInput)
	}
	if in.Latitude < -90 || in.Latitude > 90 {
		return fmt.Errorf("%w: invalid latitude", ErrInvalidSignLocationInput)
	}
	if in.Longitude < -180 || in.Longitude > 180 {
		return fmt.Errorf("%w: invalid longitude", ErrInvalidSignLocationInput)
	}
	if in.Status != "" && !validLocationStatus(in.Status) {
		return fmt.Errorf("%w: invalid status", ErrInvalidSignLocationInput)
	}
	return nil
}

func normalizeSignLocationCoordinates(latitude, longitude float64) (float64, float64) {
	const precision = 1e6
	return math.Round(latitude*precision) / precision, math.Round(longitude*precision) / precision
}

func forceManualSignLocationInput(in CreateSignLocationInput) CreateSignLocationInput {
	in.Status = model.SignLocationPending
	switch in.Source {
	case "device_gps", "map_pick":
		in.AMAPPoiID = ""
	default:
		in.Source = "manual"
	}
	return in
}

func classifySignLocationError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrInvalidSignLocationInput) || errors.Is(err, ErrSignLocationConflict) || errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	if isUniqueViolation(err) {
		return fmt.Errorf("%w: %v", ErrSignLocationConflict, err)
	}
	return err
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
func validLocationStatus(s string) bool {
	return s == model.SignLocationPending || s == model.SignLocationEnabled || s == model.SignLocationDisabled
}

func (s *SignLocationService) List(ctx context.Context, status string) ([]model.SignLocation, error) {
	q := s.db.WithContext(ctx).Where("owner_uid IS NULL AND deleted_at IS NULL")
	if strings.TrimSpace(status) != "" {
		if !validLocationStatus(status) {
			return nil, fmt.Errorf("%w: invalid status", ErrInvalidSignLocationInput)
		}
		q = q.Where("status = ?", status)
	}
	var rows []model.SignLocation
	return rows, q.Order("name asc, id asc").Find(&rows).Error
}
func (s *SignLocationService) ListEnabled(ctx context.Context) ([]model.SignLocation, error) {
	return s.List(ctx, model.SignLocationEnabled)
}

func (s *SignLocationService) ListEnabledForUser(ctx context.Context, uid int64) ([]model.SignLocation, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("%w: invalid user", ErrInvalidSignLocationInput)
	}
	var rows []model.SignLocation
	err := s.db.WithContext(ctx).
		Where("status = ? AND deleted_at IS NULL AND (owner_uid IS NULL OR owner_uid = ?)", model.SignLocationEnabled, uid).
		Order("owner_uid IS NOT NULL, name asc, id asc").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	for i := range rows {
		rows[i].IsPersonal = rows[i].OwnerUID != nil
	}
	return rows, nil
}

func (s *SignLocationService) ListPersonal(ctx context.Context, uid int64) ([]model.SignLocation, error) {
	if uid <= 0 {
		return nil, fmt.Errorf("%w: invalid user", ErrInvalidSignLocationInput)
	}
	rows := make([]model.SignLocation, 0)
	if err := s.db.WithContext(ctx).Where("owner_uid = ? AND status = ?", uid, model.SignLocationEnabled).
		Order("name asc, id asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	for i := range rows {
		rows[i].IsPersonal = true
	}
	return rows, nil
}

func (s *SignLocationService) CreatePersonal(ctx context.Context, uid int64, in CreateSignLocationInput) (model.SignLocation, error) {
	if uid <= 0 {
		return model.SignLocation{}, fmt.Errorf("%w: invalid user", ErrInvalidSignLocationInput)
	}
	in.Status, in.Source = model.SignLocationEnabled, "manual"
	if err := validateSignLocation(in); err != nil {
		return model.SignLocation{}, err
	}
	ownerUID := uid
	row := model.SignLocation{
		OwnerUID:   &ownerUID,
		IsPersonal: true,
		Name:       strings.TrimSpace(in.Name),
		Address:    strings.TrimSpace(in.Address),
		Latitude:   in.Latitude,
		Longitude:  in.Longitude,
		Status:     model.SignLocationEnabled,
		Source:     "manual",
	}
	row.Latitude, row.Longitude = normalizeSignLocationCoordinates(row.Latitude, row.Longitude)
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return model.SignLocation{}, classifySignLocationError(err)
	}
	return row, nil
}

func (s *SignLocationService) UpdatePersonal(ctx context.Context, uid int64, id uint, in UpdateSignLocationInput) error {
	if uid <= 0 || id == 0 {
		return fmt.Errorf("%w: invalid user or id", ErrInvalidSignLocationInput)
	}
	if err := validateSignLocation(CreateSignLocationInput{Name: in.Name, Address: in.Address, Latitude: in.Latitude, Longitude: in.Longitude}); err != nil {
		return err
	}
	latitude, longitude := normalizeSignLocationCoordinates(in.Latitude, in.Longitude)
	res := s.db.WithContext(ctx).Model(&model.SignLocation{}).
		Where("id = ? AND owner_uid = ? AND deleted_at IS NULL", id, uid).
		Updates(map[string]interface{}{
			"name": strings.TrimSpace(in.Name), "address": strings.TrimSpace(in.Address),
			"latitude": latitude, "longitude": longitude,
		})
	if res.Error != nil {
		return classifySignLocationError(res.Error)
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *SignLocationService) DeletePersonal(ctx context.Context, uid int64, id uint) error {
	if uid <= 0 || id == 0 {
		return fmt.Errorf("%w: invalid user or id", ErrInvalidSignLocationInput)
	}
	res := s.db.WithContext(ctx).Where("owner_uid = ?", uid).Delete(&model.SignLocation{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (s *SignLocationService) Create(in CreateSignLocationInput) (model.SignLocation, error) {
	in = forceManualSignLocationInput(in)
	if err := validateSignLocation(in); err != nil {
		return model.SignLocation{}, err
	}
	row := model.SignLocation{Name: strings.TrimSpace(in.Name), Address: strings.TrimSpace(in.Address), Latitude: in.Latitude, Longitude: in.Longitude, AMAPPoiID: strings.TrimSpace(in.AMAPPoiID), Status: in.Status, Source: in.Source}
	row.Latitude, row.Longitude = normalizeSignLocationCoordinates(row.Latitude, row.Longitude)
	if row.AMAPPoiID != "" {
		var existing model.SignLocation
		if err := s.db.Where("owner_uid IS NULL AND amap_poi_id = ?", row.AMAPPoiID).First(&existing).Error; err == nil {
			return existing, ErrSignLocationConflict
		}
	}
	if err := s.db.Create(&row).Error; err != nil {
		return model.SignLocation{}, classifySignLocationError(err)
	}
	return row, nil
}
func (s *SignLocationService) Update(id uint, in UpdateSignLocationInput) error {
	if id == 0 {
		return fmt.Errorf("%w: invalid id", ErrInvalidSignLocationInput)
	}
	if err := validateSignLocation(CreateSignLocationInput{Name: in.Name, Address: in.Address, Latitude: in.Latitude, Longitude: in.Longitude}); err != nil {
		return err
	}
	var row model.SignLocation
	if err := s.db.Where("owner_uid IS NULL").First(&row, id).Error; err != nil {
		return err
	}
	latitude, longitude := normalizeSignLocationCoordinates(in.Latitude, in.Longitude)
	updates := map[string]interface{}{"name": strings.TrimSpace(in.Name), "address": strings.TrimSpace(in.Address), "latitude": latitude, "longitude": longitude}
	if in.Source == "device_gps" || in.Source == "map_pick" {
		updates["source"], updates["status"], updates["amap_poi_id"] = in.Source, model.SignLocationPending, ""
	} else if in.Source == "manual" {
		updates["source"] = "manual"
	}
	if err := s.db.Model(&row).Updates(updates).Error; err != nil {
		return classifySignLocationError(err)
	}
	return nil
}
func (s *SignLocationService) SetStatus(id uint, status string) error {
	if id == 0 || (status != model.SignLocationEnabled && status != model.SignLocationDisabled) {
		return fmt.Errorf("%w: invalid status", ErrInvalidSignLocationInput)
	}
	res := s.db.Model(&model.SignLocation{}).Where("id = ? AND owner_uid IS NULL AND deleted_at IS NULL", id).Update("status", status)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
func (s *SignLocationService) SoftDelete(id uint) error {
	if id == 0 {
		return errors.New("invalid id")
	}
	res := s.db.Where("owner_uid IS NULL").Delete(&model.SignLocation{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
func (s *SignLocationService) SearchCandidates(ctx context.Context, query amap.SearchQuery) ([]SignLocationCandidate, error) {
	query.Keywords = strings.TrimSpace(query.Keywords)
	if query.Keywords == "" {
		query.Keywords = "教学楼"
	}
	if utf8.RuneCountInString(query.Keywords) > 64 || (query.Scope != "" && query.Scope != "campus" && query.Scope != "full") {
		return nil, fmt.Errorf("%w: invalid search keywords or scope", ErrInvalidSignLocationInput)
	}
	if s.amap == nil {
		return nil, errors.New("amap client unavailable")
	}
	pois, err := s.amap.SearchPOI(ctx, query)
	if err != nil {
		return nil, err
	}
	out := make([]SignLocationCandidate, 0, len(pois))
	for _, p := range pois {
		name, address := strings.TrimSpace(p.Name), strings.TrimSpace(p.Address)
		if validateSignLocation(CreateSignLocationInput{Name: name, Address: address, Latitude: p.Latitude, Longitude: p.Longitude}) != nil {
			continue
		}
		latitude, longitude := normalizeSignLocationCoordinates(p.Latitude, p.Longitude)
		out = append(out, SignLocationCandidate{Name: name, Address: address, Latitude: latitude, Longitude: longitude, AMAPPoiID: strings.TrimSpace(p.POIID), Source: "amap"})
	}
	return out, nil
}

func (s *SignLocationService) SearchMapCandidates(ctx context.Context, query amap.SearchQuery) ([]SignLocationCandidate, error) {
	query.Scope = "full"
	candidates, err := s.SearchCandidates(ctx, query)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return mapSearchRank(query.Keywords, candidates[i].Name) < mapSearchRank(query.Keywords, candidates[j].Name)
	})
	return candidates, nil
}

func mapSearchRank(keywords, name string) int {
	normalize := func(value string) string {
		return strings.ToLower(strings.Join(strings.Fields(value), ""))
	}
	query, candidate := normalize(keywords), normalize(name)
	switch {
	case candidate == query:
		return 0
	case strings.Contains(candidate, query):
		return 1
	case strings.Contains(query, candidate):
		return 2
	default:
		return 3
	}
}

func (s *SignLocationService) QueryKeywords(query amap.SearchQuery) (string, error) {
	if s.amap == nil {
		return "", errors.New("amap client unavailable")
	}
	if strings.TrimSpace(query.Keywords) == "" {
		query.Keywords = "教学楼"
	}
	return s.amap.QueryKeywords(query)
}

func (s *SignLocationService) SaveCandidate(ctx context.Context, in SignLocationCandidate) (SaveCandidateResult, error) {
	if err := validateSignLocation(CreateSignLocationInput{Name: in.Name, Address: in.Address, Latitude: in.Latitude, Longitude: in.Longitude}); err != nil {
		return SaveCandidateResult{}, err
	}
	in.Name, in.Address, in.AMAPPoiID = strings.TrimSpace(in.Name), strings.TrimSpace(in.Address), strings.TrimSpace(in.AMAPPoiID)
	in.Latitude, in.Longitude = normalizeSignLocationCoordinates(in.Latitude, in.Longitude)
	var row model.SignLocation
	findExisting := func(byCoordinates bool) error {
		row = model.SignLocation{}
		q := s.db.WithContext(ctx).Where("owner_uid IS NULL")
		if in.AMAPPoiID != "" && !byCoordinates {
			q = q.Where("amap_poi_id = ?", in.AMAPPoiID)
		} else {
			q = q.Where("name = ? AND address = ? AND latitude = ? AND longitude = ?", in.Name, in.Address, in.Latitude, in.Longitude)
		}
		return q.First(&row).Error
	}
	err := findExisting(false)
	if err == nil {
		return SaveCandidateResult{Location: row}, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return SaveCandidateResult{}, err
	}
	deleted := s.db.WithContext(ctx).Unscoped().Model(&model.SignLocation{}).Where("owner_uid IS NULL AND deleted_at IS NOT NULL")
	match := s.db.Where("owner_uid IS NULL AND name = ? AND address = ? AND latitude = ? AND longitude = ?", in.Name, in.Address, in.Latitude, in.Longitude)
	if in.AMAPPoiID != "" {
		match = match.Or("owner_uid IS NULL AND amap_poi_id = ?", in.AMAPPoiID)
	}
	var removed model.SignLocation
	deletedQuery := deleted.Where(match)
	if in.AMAPPoiID != "" {
		deletedQuery = deletedQuery.Order(clause.OrderBy{Expression: clause.Expr{SQL: "CASE WHEN amap_poi_id = ? THEN 0 ELSE 1 END", Vars: []interface{}{in.AMAPPoiID}}})
	}
	if err := deletedQuery.Order("id desc").First(&removed).Error; err == nil {
		return SaveCandidateResult{}, &DeletedSignLocationError{Location: removed}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return SaveCandidateResult{}, err
	}
	row = model.SignLocation{Name: in.Name, Address: in.Address, Latitude: in.Latitude, Longitude: in.Longitude, AMAPPoiID: in.AMAPPoiID, Status: model.SignLocationPending, Source: "amap"}
	if err = s.db.WithContext(ctx).Create(&row).Error; err != nil {
		if !isUniqueViolation(err) {
			return SaveCandidateResult{}, classifySignLocationError(err)
		}
		// A fresh query avoids reusing ErrRecordNotFound or a failed insert's ID.
		lookupErr := findExisting(false)
		if errors.Is(lookupErr, gorm.ErrRecordNotFound) && in.AMAPPoiID != "" {
			lookupErr = findExisting(true)
		}
		if lookupErr != nil {
			if errors.Is(lookupErr, gorm.ErrRecordNotFound) {
				return SaveCandidateResult{}, classifySignLocationError(err)
			}
			return SaveCandidateResult{}, lookupErr
		}
		return SaveCandidateResult{Location: row}, nil
	}
	return SaveCandidateResult{Location: row, Created: true}, nil
}

func (s *SignLocationService) RestoreCandidate(ctx context.Context, id uint) (SaveCandidateResult, error) {
	if id == 0 {
		return SaveCandidateResult{}, ErrInvalidSignLocationInput
	}
	var result SaveCandidateResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row model.SignLocation
		if err := tx.Unscoped().Where("owner_uid IS NULL").Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, id).Error; err != nil {
			return err
		}
		if !row.DeletedAt.Valid {
			result.Location = row
			return nil
		}
		if err := tx.Unscoped().Model(&row).Updates(map[string]interface{}{
			"deleted_at": nil, "status": model.SignLocationPending,
		}).Error; err != nil {
			return classifySignLocationError(err)
		}
		if err := tx.First(&row, id).Error; err != nil {
			return err
		}
		result = SaveCandidateResult{Location: row, Restored: true}
		return nil
	})
	return result, err
}
