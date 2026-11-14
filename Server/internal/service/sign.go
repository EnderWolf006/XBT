package service

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"xbt2/server/internal/geo"
	"xbt2/server/internal/model"
	"xbt2/server/internal/xxt"
)

type SignService struct {
	db                    *gorm.DB
	xxt                   *xxt.Client
	cc                    *CredentialCrypto
	personalLocationsOnly bool
}

func NewSignService(db *gorm.DB, xxtClient *xxt.Client, cc *CredentialCrypto) *SignService {
	return &SignService{db: db, xxt: xxtClient, cc: cc}
}

func (s *SignService) UsePersonalLocationsOnly() {
	s.personalLocationsOnly = true
}

type ExecuteSignRequest struct {
	ActivityID     int64
	TargetUID      int64
	SignType       int
	CourseID       int64
	ClassID        int64
	IfRefreshEWM   bool
	RequireRange   bool
	LocationID     uint
	LocationMode   string
	DeviceLocation *DeviceLocation
	MapLocation    *MapLocation
	Special        map[string]interface{}
}

const LocationModeDeviceGPS = "device_gps"
const LocationModeMapPick = "map_pick"

type DeviceLocation struct {
	Latitude         float64
	Longitude        float64
	Accuracy         float64
	CapturedAt       time.Time
	CoordinateSystem string
}

type MapLocation struct {
	Latitude         float64
	Longitude        float64
	CoordinateSystem string
}

type ExecutePhotoSignRequest struct {
	ActivityID   int64
	TargetUID    int64
	CourseID     int64
	ClassID      int64
	IfRefreshEWM bool
	LocationID   uint
	ObjectID     string
	Filename     string
	ContentType  string
	Photo        []byte
}

type SignCheckItem struct {
	UserID           int64  `json:"user_id"`
	Signed           bool   `json:"signed"`
	RecordSource     int64  `json:"record_source"`
	RecordSourceName string `json:"record_source_name"`
	Message          string `json:"message"`
}

type SignExecuteResult struct {
	UserID           int64  `json:"user_id"`
	Success          bool   `json:"success"`
	AlreadySigned    bool   `json:"already_signed"`
	RecordSource     int64  `json:"record_source"`
	RecordSourceName string `json:"record_source_name"`
	Message          string `json:"message"`
}

var ErrSignLocationUnavailable = errors.New("sign location unavailable")

func validateExecuteSignLocation(signType int, requireRange bool, locationID uint, locationMode string, deviceLocation *DeviceLocation, mapLocation *MapLocation) error {
	needsLocation := signType == xxt.SignLocation || requireRange
	if !needsLocation {
		if locationMode != "" || deviceLocation != nil || mapLocation != nil {
			return fmt.Errorf("%w: device location is only valid for location signs", ErrInvalidSignLocationInput)
		}
		return nil
	}
	if locationMode == LocationModeDeviceGPS {
		if locationID != 0 || deviceLocation == nil || mapLocation != nil || deviceLocation.CoordinateSystem != "GCJ-02" ||
			deviceLocation.CapturedAt.IsZero() || math.IsNaN(deviceLocation.Accuracy) ||
			math.IsInf(deviceLocation.Accuracy, 0) || deviceLocation.Accuracy < 0 ||
			(geo.Point{Latitude: deviceLocation.Latitude, Longitude: deviceLocation.Longitude}).Validate() != nil {
			return fmt.Errorf("%w: invalid device location", ErrInvalidSignLocationInput)
		}
		return nil
	}
	if locationMode == LocationModeMapPick {
		if locationID != 0 || deviceLocation != nil || mapLocation == nil || mapLocation.CoordinateSystem != "GCJ-02" ||
			(geo.Point{Latitude: mapLocation.Latitude, Longitude: mapLocation.Longitude}).Validate() != nil {
			return fmt.Errorf("%w: invalid map location", ErrInvalidSignLocationInput)
		}
		return nil
	}
	if locationMode != "" || deviceLocation != nil || mapLocation != nil || locationID == 0 {
		return fmt.Errorf("%w: location_id is required", ErrInvalidSignLocationInput)
	}
	return nil
}

func resolveMapLocationSpecial(location MapLocation) map[string]interface{} {
	return map[string]interface{}{
		"latitude":          fmt.Sprintf("%.6f", location.Latitude),
		"longitude":         fmt.Sprintf("%.6f", location.Longitude),
		"coordinate_system": "GCJ-02",
		"description":       fmt.Sprintf("地图选择点（GCJ-02：%.6f, %.6f）", location.Latitude, location.Longitude),
	}
}

func resolveDeviceLocationSpecial(location DeviceLocation) map[string]interface{} {
	return map[string]interface{}{
		"latitude":          fmt.Sprintf("%.6f", location.Latitude),
		"longitude":         fmt.Sprintf("%.6f", location.Longitude),
		"coordinate_system": "GCJ-02",
		"description":       fmt.Sprintf("浏览器现场定位（GCJ-02：%.6f, %.6f；精度 %.1f 米）", location.Latitude, location.Longitude, location.Accuracy),
	}
}

func resolveLocationSpecialFromLocation(location model.SignLocation, existing map[string]interface{}) (map[string]interface{}, error) {
	if location.ID == 0 || location.Status != model.SignLocationEnabled || location.DeletedAt.Valid {
		return nil, ErrSignLocationUnavailable
	}
	resolved := make(map[string]interface{}, len(existing)+3)
	for key, value := range existing {
		resolved[key] = value
	}
	resolved["latitude"] = fmt.Sprintf("%v", location.Latitude)
	resolved["longitude"] = fmt.Sprintf("%v", location.Longitude)
	resolved["description"] = location.Address
	resolved["coordinate_system"] = "GCJ-02"
	// A resolved database point must not be shadowed by legacy QR location JSON.
	delete(resolved, "location")
	return resolved, nil
}

func (s *SignService) ResolveLocationSpecial(locationID uint, existing map[string]interface{}) (map[string]interface{}, error) {
	return s.ResolveLocationSpecialForUser(locationID, 0, existing)
}

func (s *SignService) ResolveLocationSpecialForUser(locationID uint, operatorUID int64, existing map[string]interface{}) (map[string]interface{}, error) {
	if locationID == 0 {
		return nil, fmt.Errorf("%w: location_id is required", ErrInvalidSignLocationInput)
	}
	var location model.SignLocation
	query := s.db.Where("id = ? AND status = ? AND deleted_at IS NULL", locationID, model.SignLocationEnabled)
	if s.personalLocationsOnly {
		if operatorUID <= 0 {
			return nil, ErrSignLocationUnavailable
		}
		query = query.Where("owner_uid = ?", operatorUID)
	} else if operatorUID > 0 {
		query = query.Where("(owner_uid IS NULL OR owner_uid = ?)", operatorUID)
	} else {
		query = query.Where("owner_uid IS NULL")
	}
	if err := query.First(&location).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrSignLocationUnavailable
		}
		return nil, err
	}
	return resolveLocationSpecialFromLocation(location, existing)
}

func (s *SignService) CheckSignStates(activityID int64, userIDs []int64) ([]SignCheckItem, error) {
	if activityID <= 0 {
		return nil, errors.New("invalid activity_id")
	}
	uniq := dedupeUIDs(userIDs)
	items := make([]SignCheckItem, 0, len(uniq))
	for _, uid := range uniq {
		items = append(items, s.resolveSignState(activityID, uid))
	}
	return items, nil
}

func mergeSignSpecial(base map[string]interface{}, extra map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(base)+len(extra))
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func (s *SignService) ExecuteOne(operatorUID int64, req ExecuteSignRequest) SignExecuteResult {
	if err := validateExecuteSignLocation(req.SignType, req.RequireRange, req.LocationID, req.LocationMode, req.DeviceLocation, req.MapLocation); err != nil {
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "请选择有效的签到地点"}
	}
	needsLocation := req.SignType == xxt.SignLocation || req.RequireRange
	if needsLocation || (req.SignType == xxt.SignQRCode && req.LocationID != 0) {
		if req.LocationMode == LocationModeDeviceGPS {
			req.Special = mergeSignSpecial(req.Special, resolveDeviceLocationSpecial(*req.DeviceLocation))
		} else if req.LocationMode == LocationModeMapPick {
			req.Special = mergeSignSpecial(req.Special, resolveMapLocationSpecial(*req.MapLocation))
		} else {
			resolved, err := s.ResolveLocationSpecialForUser(req.LocationID, operatorUID, req.Special)
			if err != nil {
				return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "签到地点不可用"}
			}
			req.Special = resolved
		}
	}
	state := s.resolveSignState(req.ActivityID, req.TargetUID)
	if state.Signed {
		return SignExecuteResult{
			UserID:           req.TargetUID,
			Success:          true,
			AlreadySigned:    true,
			RecordSource:     state.RecordSource,
			RecordSourceName: state.RecordSourceName,
			Message:          state.Message,
		}
	}

	var target model.User
	if err := s.db.Where("uid = ?", req.TargetUID).First(&target).Error; err != nil {
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "该同学未登录或账号不可用"}
	}
	password, err := s.cc.Decrypt(target.CredentialCipher)
	if err != nil {
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "该同学登录信息已过期，请先重新登录"}
	}

	fixed := xxt.FixedParams{
		ActiveID:     req.ActivityID,
		UID:          req.TargetUID,
		CourseID:     req.CourseID,
		ClassID:      req.ClassID,
		IfRefreshEWM: req.IfRefreshEWM,
	}
	if req.SignType == xxt.SignQRCode {
		enc, _ := req.Special["enc"].(string)
		code, _ := req.Special["c"].(string)
		if err := s.xxt.PreSign(target.Mobile, password, fixed, code, enc); err != nil {
			return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "预签到失败，请重试"}
		}
	}

	result, err := s.xxt.Sign(target.Mobile, password, fixed, req.SignType, req.Special)
	if err != nil {
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: s.toUserSignMessage(err.Error())}
	}
	result = strings.TrimSpace(result)
	if result != "success" {
		if strings.Contains(result, "您已签到过了") {
			rec := model.SignRecord{UserUID: req.TargetUID, ActivityID: req.ActivityID, SourceUID: -1, SignTimeMS: time.Now().UnixMilli()}
			_ = s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_uid"}, {Name: "activity_id"}}, DoNothing: true}).Create(&rec).Error
			return SignExecuteResult{
				UserID:           req.TargetUID,
				Success:          true,
				AlreadySigned:    true,
				RecordSource:     -1,
				RecordSourceName: "学习通",
				Message:          "该同学已在学习通签到",
			}
		}
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: s.toUserSignMessage(result)}
	}

	rec := model.SignRecord{
		UserUID:    req.TargetUID,
		ActivityID: req.ActivityID,
		SourceUID:  operatorUID,
		SignTimeMS: time.Now().UnixMilli(),
	}
	if err := s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_uid"}, {Name: "activity_id"}}, DoNothing: true}).Create(&rec).Error; err != nil {
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "保存签到结果失败，请重试"}
	}

	sourceName := s.getSourceName(operatorUID)
	if strings.TrimSpace(sourceName) == "" {
		sourceName = "未知用户"
	}
	return SignExecuteResult{
		UserID:           req.TargetUID,
		Success:          true,
		AlreadySigned:    false,
		RecordSource:     operatorUID,
		RecordSourceName: sourceName,
		Message:          "签到成功",
	}
}

func (s *SignService) UploadPhoto(operatorUID int64, filename, contentType string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("照片为空")
	}
	var target model.User
	if err := s.db.Where("uid = ?", operatorUID).First(&target).Error; err != nil {
		return "", errors.New("账号不可用")
	}
	password, err := s.cc.Decrypt(target.CredentialCipher)
	if err != nil {
		return "", errors.New("登录信息已过期，请重新登录")
	}
	return s.xxt.UploadPanFile(target.Mobile, password, filename, contentType, data)
}

func (s *SignService) ExecutePhoto(operatorUID int64, req ExecutePhotoSignRequest) SignExecuteResult {
	if req.ActivityID <= 0 || req.CourseID <= 0 || req.ClassID <= 0 {
		return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "签到参数不完整"}
	}
	if req.TargetUID <= 0 {
		req.TargetUID = operatorUID
	}
	state := s.resolveSignState(req.ActivityID, req.TargetUID)
	if state.Signed {
		return SignExecuteResult{
			UserID:           req.TargetUID,
			Success:          true,
			AlreadySigned:    true,
			RecordSource:     state.RecordSource,
			RecordSourceName: state.RecordSourceName,
			Message:          state.Message,
		}
	}

	objectID := strings.TrimSpace(req.ObjectID)
	if objectID == "" {
		if len(req.Photo) == 0 {
			return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "请上传照片或传入 object_id"}
		}
		var target model.User
		if err := s.db.Where("uid = ?", req.TargetUID).First(&target).Error; err != nil {
			return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "该同学未登录或账号不可用"}
		}
		password, err := s.cc.Decrypt(target.CredentialCipher)
		if err != nil {
			return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "该同学登录信息已过期，请先重新登录"}
		}
		objectID, err = s.xxt.UploadPanFile(target.Mobile, password, req.Filename, req.ContentType, req.Photo)
		if err != nil {
			return SignExecuteResult{UserID: req.TargetUID, Success: false, Message: "照片上传失败：" + err.Error()}
		}
	}

	return s.ExecuteOne(operatorUID, ExecuteSignRequest{
		ActivityID:   req.ActivityID,
		TargetUID:    req.TargetUID,
		SignType:     xxt.SignNormal,
		CourseID:     req.CourseID,
		ClassID:      req.ClassID,
		IfRefreshEWM: req.IfRefreshEWM,
		LocationID:   req.LocationID,
		Special: map[string]interface{}{
			"object_id": objectID,
		},
	})
}

func (s *SignService) toUserSignMessage(raw string) string {
	msg := strings.TrimSpace(raw)
	if msg == "" {
		return "签到失败，请稍后重试"
	}

	lower := strings.ToLower(msg)
	switch {
	case msg == "validate" || strings.Contains(lower, "validate"):
		return "签到校验未通过，请重试"
	case strings.Contains(msg, "验证码识别失败") || strings.Contains(lower, "captcha"):
		return "验证码校验失败，请重试"
	case strings.Contains(msg, "缺少二维码 enc 参数"):
		return "二维码参数缺失，请刷新活动后重试"
	case strings.Contains(msg, "缺少 sign_code 参数"):
		return "签到码缺失，请输入后重试"
	case strings.Contains(msg, "errorLocation"):
		return "位置校验未通过：所选地点不在教师设定的签到范围内，请换用现场定位或更近的地点"
	case strings.Contains(msg, "签到失败，请重新扫描"):
		return "二维码已失效，请重新扫描老师当前展示的二维码"
	case strings.Contains(msg, "请求过于频繁"):
		return "操作太频繁，请稍后再试"
	case strings.Contains(msg, "活动已结束"):
		return "该签到已结束"
	case strings.Contains(msg, "签到成功"):
		return "签到成功"
	case strings.Contains(msg, "您已签到过了"):
		return "该同学已在学习通签到"
	default:
		return msg
	}
}

func (s *SignService) resolveSignState(activityID, uid int64) SignCheckItem {
	state := SignCheckItem{UserID: uid, Signed: false, RecordSource: 0, RecordSourceName: "", Message: "未签到"}
	if activityID <= 0 || uid <= 0 {
		return state
	}

	var rec model.SignRecord
	if err := s.db.Where("user_uid = ? AND activity_id = ?", uid, activityID).Take(&rec).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return state
		}
		state.Message = "查询失败"
		return state
	}

	state.Signed = true
	state.RecordSource = rec.SourceUID
	if rec.SourceUID == -1 {
		state.RecordSourceName = "学习通"
		state.Message = "该同学已在学习通签到"
		return state
	}
	if rec.SourceUID == uid {
		state.RecordSourceName = s.getSourceName(uid)
		if state.RecordSourceName == "" {
			state.RecordSourceName = "本人"
		}
		state.Message = "该同学已本人签到"
		return state
	}
	state.RecordSourceName = s.getSourceName(rec.SourceUID)
	if state.RecordSourceName == "" {
		state.RecordSourceName = "未知用户"
	}
	state.Message = fmt.Sprintf("该同学已被%s代签", state.RecordSourceName)
	return state
}

func (s *SignService) getSourceName(sourceUID int64) string {
	if sourceUID <= 0 {
		return ""
	}
	var user model.User
	if err := s.db.Where("uid = ?", sourceUID).Take(&user).Error; err != nil {
		return ""
	}
	return strings.TrimSpace(user.Name)
}

func dedupeUIDs(userIDs []int64) []int64 {
	set := make(map[int64]struct{}, len(userIDs))
	out := make([]int64, 0, len(userIDs))
	for _, uid := range userIDs {
		if uid <= 0 {
			continue
		}
		if _, ok := set[uid]; ok {
			continue
		}
		set[uid] = struct{}{}
		out = append(out, uid)
	}
	return out
}
