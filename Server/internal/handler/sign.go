package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/errgroup"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"xbt2/server/internal/common"
	"xbt2/server/internal/dto"
	"xbt2/server/internal/model"
	"xbt2/server/internal/service"
	"xbt2/server/internal/xxt"
)

const manualEndTimeSentinel int64 = 64060559999000
const maxPhotoUploadBytes int64 = 20 << 20
const activityRulesVersion = 1

type activityClient interface {
	GetActivesContext(context.Context, string, string, int64, int64) ([]xxt.Active, error)
	GetSignDetailContext(context.Context, string, string, int64) (xxt.SignDetail, error)
}

type selectedCourseInfo struct {
	CourseID int64
	ClassID  int64
	Name     string
	Teacher  string
	Icon     string
}

type SignHandler struct {
	db          *gorm.DB
	xxt         activityClient
	cc          *service.CredentialCrypto
	signService *service.SignService
	listLimit   int
	activities  *activityCache
	courseSlots chan struct{}
}

func NewSignHandler(db *gorm.DB, xxtClient activityClient, cc *service.CredentialCrypto, signService *service.SignService, listLimit int) *SignHandler {
	if listLimit <= 0 {
		listLimit = 5
	}
	return &SignHandler{db: db, xxt: xxtClient, cc: cc, signService: signService, listLimit: listLimit,
		activities: newActivityCache(), courseSlots: make(chan struct{}, 4)}
}

func (h *SignHandler) Activities(c *gin.Context) {
	uid := common.GetUserUID(c)
	start := time.Now()
	body, state, err := h.activities.get(c.Request.Context(), uid, c.GetHeader("Cache-Control") == "no-cache",
		func(ctx context.Context) ([]byte, error) {
			return h.loadActivities(ctx, uid)
		})
	c.Header("Cache-Control", "private, no-store")
	c.Header("Server-Timing", fmt.Sprintf("activities;dur=%.2f", float64(time.Since(start).Microseconds())/1000))
	c.Header("X-Activity-Cache", state)
	if err != nil {
		log.Printf("activities failed: elapsed=%s err=%v", time.Since(start), err)
		var failure *activityFailure
		if errors.As(err, &failure) {
			common.Fail(c, failure.status, failure.message)
		} else if errors.Is(err, errActivityBusy) {
			common.Fail(c, 429, err.Error())
		} else {
			common.Fail(c, 504, "活动刷新超时，请稍后重试")
		}
		return
	}
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

func (h *SignHandler) InvalidateActivities(c *gin.Context) {
	c.Next()
	if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
		h.activities.clear()
	}
}

type activityFailure struct {
	status  int
	message string
}

func (e *activityFailure) Error() string { return e.message }

func (h *SignHandler) loadActivities(ctx context.Context, uid int64) ([]byte, error) {
	var user model.User
	database := h.db.WithContext(ctx)
	if err := database.Where("uid = ?", uid).First(&user).Error; err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &activityFailure{404, "user not found"}
	}
	password, err := h.cc.Decrypt(user.CredentialCipher)
	if err != nil {
		return nil, &activityFailure{400, "credential expired, please login again"}
	}

	var selected []selectedCourseInfo
	err = database.Table("user_courses uc").
		Select("uc.course_id, uc.class_id, c.name, c.teacher, c.icon").
		Joins("join courses c on uc.course_id = c.course_id and uc.class_id = c.class_id").
		Where("uc.user_uid = ? and uc.is_selected = true", uid).
		Scan(&selected).Error
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &activityFailure{500, "query selected courses failed"}
	}
	log.Printf("activities query: uid=%d selected_courses=%d", uid, len(selected))

	resp := make([]gin.H, 0, len(selected))
	var respMu sync.Mutex
	eg, courseCtx := errgroup.WithContext(ctx)
	eg.SetLimit(2)
	for _, sc := range selected {
		sc := sc
		eg.Go(func() error {
			select {
			case h.courseSlots <- struct{}{}:
				defer func() { <-h.courseSlots }()
			case <-courseCtx.Done():
				return courseCtx.Err()
			}
			group, err := h.buildCourseActivityGroup(courseCtx, uid, user, password, sc)
			if err != nil {
				return err
			}
			if group == nil {
				return nil
			}
			respMu.Lock()
			resp = append(resp, group)
			respMu.Unlock()
			return nil
		})
	}
	if err := eg.Wait(); err != nil {
		if isXXTAuthError(err) {
			return nil, &activityFailure{401, "学习通登录已失效，请使用新密码重新登录"}
		}
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			return nil, err
		}
		return nil, &activityFailure{502, "学习通活动暂时无法刷新，请稍后重试"}
	}

	// 课程分组按“组内最新活动时间”倒序
	sort.Slice(resp, func(i, j int) bool {
		getLatestStart := func(group gin.H) int64 {
			activitiesAny, ok := group["activities"]
			if !ok {
				return 0
			}
			activities, ok := activitiesAny.([]gin.H)
			if !ok || len(activities) == 0 {
				return 0
			}
			startAny, ok := activities[0]["start_time"]
			if !ok {
				return 0
			}
			start, ok := startAny.(int64)
			if !ok {
				return 0
			}
			return start
		}
		return getLatestStart(resp[i]) > getLatestStart(resp[j])
	})
	log.Printf("activities response: uid=%d course_groups=%d", uid, len(resp))
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return json.Marshal(gin.H{"code": 0, "message": "ok", "data": resp})
}

func (h *SignHandler) buildCourseActivityGroup(ctx context.Context, uid int64, user model.User, password string, sc selectedCourseInfo) (gin.H, error) {
	database := h.db.WithContext(ctx)
	actives, err := h.xxt.GetActivesContext(ctx, user.Mobile, password, sc.CourseID, sc.ClassID)
	if err != nil {
		log.Printf("get actives failed: uid=%d course=%d class=%d err=%v", uid, sc.CourseID, sc.ClassID, err)
		return nil, err
	}
	log.Printf("actives fetched: uid=%d course=%d class=%d count=%d", uid, sc.CourseID, sc.ClassID, len(actives))
	items := make([]gin.H, 0)
	for _, a := range actives {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var detail xxt.SignDetail
		var cache model.SignActivity
		cacheErr := database.Where("activity_id = ?", a.ActiveID).First(&cache).Error
		if cacheErr != nil && !errors.Is(cacheErr, gorm.ErrRecordNotFound) {
			return nil, cacheErr
		}
		cacheFound := cacheErr == nil
		rulesVerified := cacheFound && cache.RulesVersion == activityRulesVersion
		// 进行中的活动必须回源：教师可能在签到开始后才勾选人脸/限定范围，
		// 旧缓存会把 if_photo / if_get_range 固化成过期值，导致前端不出现人脸入口。
		cacheUsable := rulesVerified && cache.EndTime != manualEndTimeSentinel && cache.EndTime <= time.Now().UnixMilli()

		if cacheUsable {
			detail = cachedSignDetail(cache)
		} else {
			remoteDetail, err := h.xxt.GetSignDetailContext(ctx, user.Mobile, password, a.ActiveID)
			if err == nil {
				detail = remoteDetail
				detail.NeedFace = detail.NeedFace || (cacheFound && cache.NeedFace)
				rulesVerified = true
				cacheRow := model.SignActivity{
					ActivityID:   a.ActiveID,
					StartTime:    detail.StartTime,
					EndTime:      detail.EndTime,
					SignType:     detail.SignType,
					IfRefreshEWM: detail.IfRefreshEWM,
					IfPhoto:      detail.IfPhoto,
					IfGetRange:   detail.IfGetRange,
					NeedFace:     detail.NeedFace,
					FaceChecked:  time.Now().UnixMilli(),
					RulesVersion: activityRulesVersion,
				}
				if err := database.Clauses(clause.OnConflict{
					Columns: []clause.Column{{Name: "activity_id"}},
					DoUpdates: clause.AssignmentColumns([]string{
						"start_time", "end_time", "sign_type",
						"if_refresh_ewm", "if_photo", "if_get_range", "updated_at",
						"need_face", "face_checked", "rules_version",
					}),
				}).Create(&cacheRow).Error; err != nil {
					log.Printf("cache sign rules failed: uid=%d activity=%d err=%v", uid, a.ActiveID, err)
				}
			} else {
				log.Printf("get sign detail failed: uid=%d activity=%d err=%v", uid, a.ActiveID, err)
				if isXXTAuthError(err) {
					return nil, err
				}
				if cacheFound {
					detail = cachedSignDetail(cache)
				} else {
					return nil, err
				}
			}
		}

		if detail.StartTime == 0 && detail.EndTime == 0 {
			if cacheFound {
				detail = cachedSignDetail(cache)
				rulesVerified = cache.RulesVersion == activityRulesVersion
			} else {
				continue
			}
		}

		recordSourceName := ""
		recordSource := int64(0)
		recordSignTime := int64(0)
		var rec struct {
			SourceUID  int64
			SignTimeMS int64
			SourceName string
		}
		recErr := database.Table("sign_records sr").
			Select("sr.source_uid, sr.sign_time_ms, u.name as source_name").
			Joins("left join users u on sr.source_uid = u.uid").
			Where("sr.user_uid = ? and sr.activity_id = ?", uid, a.ActiveID).
			Take(&rec).Error

		if recErr == nil {
			recordSource = rec.SourceUID
			recordSignTime = rec.SignTimeMS
			if rec.SourceUID == -1 {
				recordSourceName = "学习通"
			} else if rec.SourceName != "" {
				recordSourceName = rec.SourceName
			} else if rec.SourceUID == uid {
				recordSourceName = user.Name
			} else {
				recordSourceName = "未知用户"
			}
		} else if recErr != nil && !errors.Is(recErr, gorm.ErrRecordNotFound) {
			log.Printf("query sign record failed: uid=%d activity=%d err=%v", uid, a.ActiveID, recErr)
		}
		items = append(items, gin.H{
			"active_id":          a.ActiveID,
			"activity_name":      a.Name,
			"start_time":         detail.StartTime,
			"end_time":           detail.EndTime,
			"sign_type":          detail.SignType,
			"if_refresh_ewm":     detail.IfRefreshEWM,
			"if_photo":           detail.IfPhoto,
			"if_get_range":       detail.IfGetRange,
			"need_face":          detail.NeedFace,
			"rules_verified":     rulesVerified,
			"record_source":      recordSource,
			"record_source_name": recordSourceName,
			"record_sign_time":   recordSignTime,
			"course_name":        sc.Name,
			"course_id":          sc.CourseID,
			"class_id":           sc.ClassID,
			"course_teacher":     sc.Teacher,
		})
	}
	hasMore := len(items) > h.listLimit
	if len(items) > 1 {
		sort.Slice(items, func(i, j int) bool {
			return items[i]["start_time"].(int64) > items[j]["start_time"].(int64)
		})
	}
	if hasMore {
		items = items[:h.listLimit]
	}
	return gin.H{
		"course_id":      sc.CourseID,
		"class_id":       sc.ClassID,
		"course_name":    sc.Name,
		"course_teacher": sc.Teacher,
		"icon":           sc.Icon,
		"activities":     items,
		"has_more":       hasMore,
	}, nil
}

func cachedSignDetail(cache model.SignActivity) xxt.SignDetail {
	return xxt.SignDetail{
		StartTime: cache.StartTime, EndTime: cache.EndTime, SignType: cache.SignType,
		IfRefreshEWM: cache.IfRefreshEWM, IfPhoto: cache.IfPhoto,
		IfGetRange: cache.IfGetRange, NeedFace: cache.NeedFace,
	}
}

func (h *SignHandler) Classmates(c *gin.Context) {
	uid := common.GetUserUID(c)
	courseID := c.Query("course_id")
	classID := c.Query("class_id")
	if courseID == "" || classID == "" {
		common.Fail(c, 400, "course_id and class_id are required")
		return
	}

	var mates []struct {
		UID    int64
		Name   string
		Mobile string
		Avatar string
	}
	err := h.db.Table("users u").
		Select("u.uid, u.name, u.mobile, u.avatar").
		Joins("join user_courses uc on u.uid = uc.user_uid").
		Where("uc.course_id = ? and uc.class_id = ? and uc.is_selected = true and u.uid <> ?", courseID, classID, uid).
		Order("u.name asc").
		Scan(&mates).Error
	if err != nil {
		common.Fail(c, 500, "query classmates failed")
		return
	}
	resp := make([]gin.H, 0, len(mates))
	for _, m := range mates {
		resp = append(resp, gin.H{
			"uid":           m.UID,
			"name":          m.Name,
			"mobile_masked": common.MaskMobile(m.Mobile),
			"avatar":        m.Avatar,
		})
	}
	common.Success(c, resp)
}

func (h *SignHandler) Execute(c *gin.Context) {
	uid := common.GetUserUID(c)
	var req dto.SignExecuteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}
	if req.ActivityID <= 0 || req.CourseID <= 0 || req.ClassID <= 0 {
		common.Fail(c, 400, "invalid request params")
		return
	}
	switch req.SignType {
	case xxt.SignNormal, xxt.SignQRCode, xxt.SignGesture, xxt.SignLocation, xxt.SignCode:
	default:
		common.Fail(c, 400, "unsupported sign_type")
		return
	}
	targetUID := req.TargetUID
	if targetUID <= 0 && len(req.UserIDs) > 0 {
		targetUID = req.UserIDs[0]
	}
	if targetUID <= 0 {
		targetUID = uid
	}
	if req.Special == nil {
		req.Special = map[string]interface{}{}
	}
	var deviceLocation *service.DeviceLocation
	if req.DeviceLocation != nil {
		if req.DeviceLocation.Latitude == nil || req.DeviceLocation.Longitude == nil || req.DeviceLocation.Accuracy == nil {
			common.Fail(c, 400, "设备定位需要坐标、精度及采集时间")
			return
		}
		deviceLocation = &service.DeviceLocation{
			Latitude:         *req.DeviceLocation.Latitude,
			Longitude:        *req.DeviceLocation.Longitude,
			Accuracy:         *req.DeviceLocation.Accuracy,
			CapturedAt:       req.DeviceLocation.CapturedAt,
			CoordinateSystem: req.DeviceLocation.CoordinateSystem,
		}
	}
	var mapLocation *service.MapLocation
	if req.MapLocation != nil {
		if req.MapLocation.Latitude == nil || req.MapLocation.Longitude == nil {
			common.Fail(c, 400, "地图签到需要有效坐标")
			return
		}
		mapLocation = &service.MapLocation{
			Latitude:         *req.MapLocation.Latitude,
			Longitude:        *req.MapLocation.Longitude,
			CoordinateSystem: req.MapLocation.CoordinateSystem,
		}
	}
	res := h.signService.ExecuteOne(uid, service.ExecuteSignRequest{
		ActivityID:     req.ActivityID,
		TargetUID:      targetUID,
		SignType:       req.SignType,
		CourseID:       req.CourseID,
		ClassID:        req.ClassID,
		IfRefreshEWM:   req.IfRefreshEWM,
		RequireRange:   req.RequireRange,
		LocationID:     req.LocationID,
		LocationMode:   req.LocationMode,
		DeviceLocation: deviceLocation,
		MapLocation:    mapLocation,
		Special:        req.Special,
	})
	log.Printf("sign execute: operator=%d target=%d activity=%d sign_type=%d location_id=%d range=%v success=%v msg=%s",
		uid, res.UserID, req.ActivityID, req.SignType, req.LocationID, req.RequireRange, res.Success, res.Message)
	common.Success(c, res)
}

func (h *SignHandler) UploadPhoto(c *gin.Context) {
	uid := common.GetUserUID(c)
	fileHeader, fileErr := c.FormFile("file")
	if fileErr != nil {
		common.Fail(c, 400, "file is required")
		return
	}
	if fileHeader.Size > maxPhotoUploadBytes {
		common.Fail(c, 400, "photo file is too large")
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		common.Fail(c, 400, "open photo file failed")
		return
	}
	defer file.Close()
	photo, err := io.ReadAll(io.LimitReader(file, maxPhotoUploadBytes+1))
	if err != nil {
		common.Fail(c, 400, "read photo file failed")
		return
	}
	if int64(len(photo)) > maxPhotoUploadBytes {
		common.Fail(c, 400, "photo file is too large")
		return
	}
	objectID, err := h.signService.UploadPhoto(uid, fileHeader.Filename, fileHeader.Header.Get("Content-Type"), photo)
	if err != nil {
		common.Fail(c, 500, "照片上传失败："+err.Error())
		return
	}
	common.Success(c, gin.H{"object_id": objectID})
}

func (h *SignHandler) Photo(c *gin.Context) {
	uid := common.GetUserUID(c)
	activityID, err := requiredInt64Form(c, "activity_id")
	if err != nil {
		common.Fail(c, 400, "activity_id is required")
		return
	}
	courseID, err := requiredInt64Form(c, "course_id")
	if err != nil {
		common.Fail(c, 400, "course_id is required")
		return
	}
	classID, err := requiredInt64Form(c, "class_id")
	if err != nil {
		common.Fail(c, 400, "class_id is required")
		return
	}
	targetUID := optionalInt64Form(c, "target_uid")
	if targetUID <= 0 {
		targetUID = uid
	}

	objectID := strings.TrimSpace(c.PostForm("object_id"))
	if objectID == "" {
		objectID = strings.TrimSpace(c.PostForm("objectId"))
	}

	var photo []byte
	filename := ""
	contentType := ""
	fileHeader, fileErr := c.FormFile("file")
	if fileErr == nil {
		if fileHeader.Size > maxPhotoUploadBytes {
			common.Fail(c, 400, "photo file is too large")
			return
		}
		file, err := fileHeader.Open()
		if err != nil {
			common.Fail(c, 400, "open photo file failed")
			return
		}
		defer file.Close()
		photo, err = io.ReadAll(io.LimitReader(file, maxPhotoUploadBytes+1))
		if err != nil {
			common.Fail(c, 400, "read photo file failed")
			return
		}
		if int64(len(photo)) > maxPhotoUploadBytes {
			common.Fail(c, 400, "photo file is too large")
			return
		}
		filename = fileHeader.Filename
		contentType = fileHeader.Header.Get("Content-Type")
	} else if objectID == "" {
		if errors.Is(fileErr, http.ErrMissingFile) {
			common.Fail(c, 400, "file or object_id is required")
			return
		}
		common.Fail(c, 400, "invalid photo upload")
		return
	}

	res := h.signService.ExecutePhoto(uid, service.ExecutePhotoSignRequest{
		ActivityID:   activityID,
		TargetUID:    targetUID,
		CourseID:     courseID,
		ClassID:      classID,
		IfRefreshEWM: optionalBoolForm(c, "if_refresh_ewm"),
		ObjectID:     objectID,
		Filename:     filename,
		ContentType:  contentType,
		Photo:        photo,
	})
	common.Success(c, res)
}

func (h *SignHandler) Check(c *gin.Context) {
	uid := common.GetUserUID(c)
	var req dto.SignCheckRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}
	if req.ActivityID <= 0 {
		common.Fail(c, 400, "invalid activity_id")
		return
	}
	targets := make([]int64, 0, len(req.UserIDs)+1)
	targets = append(targets, uid)
	targets = append(targets, req.UserIDs...)
	items, err := h.signService.CheckSignStates(req.ActivityID, targets)
	if err != nil {
		common.Fail(c, 500, err.Error())
		return
	}
	common.Success(c, gin.H{"items": items})
}

func requiredInt64Form(c *gin.Context, key string) (int64, error) {
	raw := strings.TrimSpace(c.PostForm(key))
	if raw == "" {
		return 0, errors.New("missing form field")
	}
	return strconv.ParseInt(raw, 10, 64)
}

func optionalInt64Form(c *gin.Context, key string) int64 {
	raw := strings.TrimSpace(c.PostForm(key))
	if raw == "" {
		return 0
	}
	value, _ := strconv.ParseInt(raw, 10, 64)
	return value
}

func optionalBoolForm(c *gin.Context, key string) bool {
	raw := strings.TrimSpace(c.PostForm(key))
	if raw == "" {
		return false
	}
	value, err := strconv.ParseBool(raw)
	if err == nil {
		return value
	}
	return raw == "1"
}
