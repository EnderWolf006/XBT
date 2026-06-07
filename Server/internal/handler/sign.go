package handler

import (
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"

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

type selectedCourseInfo struct {
	CourseID int64
	ClassID  int64
	Name     string
	Teacher  string
	Icon     string
}

type SignHandler struct {
	db          *gorm.DB
	xxt         *xxt.Client
	cc          *service.CredentialCrypto
	signService *service.SignService
	listLimit   int
}

func NewSignHandler(db *gorm.DB, xxtClient *xxt.Client, cc *service.CredentialCrypto, signService *service.SignService, listLimit int) *SignHandler {
	if listLimit <= 0 {
		listLimit = 5
	}
	return &SignHandler{db: db, xxt: xxtClient, cc: cc, signService: signService, listLimit: listLimit}
}

func (h *SignHandler) Activities(c *gin.Context) {
	uid := common.GetUserUID(c)
	var user model.User
	if err := h.db.Where("uid = ?", uid).First(&user).Error; err != nil {
		common.Fail(c, 404, "user not found")
		return
	}
	password, err := h.cc.Decrypt(user.CredentialCipher)
	if err != nil {
		common.Fail(c, 400, "credential expired, please login again")
		return
	}

	var selected []selectedCourseInfo
	err = h.db.Table("user_courses uc").
		Select("uc.course_id, uc.class_id, c.name, c.teacher, c.icon").
		Joins("join courses c on uc.course_id = c.course_id and uc.class_id = c.class_id").
		Where("uc.user_uid = ? and uc.is_selected = true", uid).
		Scan(&selected).Error
	if err != nil {
		common.Fail(c, 500, "query selected courses failed")
		return
	}
	log.Printf("activities query: uid=%d selected_courses=%d", uid, len(selected))

	resp := make([]gin.H, 0, len(selected))
	var respMu sync.Mutex
	var eg errgroup.Group
	for _, sc := range selected {
		sc := sc
		eg.Go(func() error {
			group, err := h.buildCourseActivityGroup(uid, user, password, sc)
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
			common.Fail(c, 401, "学习通登录已失效，请使用新密码重新登录")
			return
		}
		common.Fail(c, 500, err.Error())
		return
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
	common.Success(c, resp)
}

func (h *SignHandler) buildCourseActivityGroup(uid int64, user model.User, password string, sc selectedCourseInfo) (gin.H, error) {
	actives, err := h.xxt.GetActives(user.Mobile, password, sc.CourseID, sc.ClassID)
	if err != nil {
		log.Printf("get actives failed: uid=%d course=%d class=%d err=%v", uid, sc.CourseID, sc.ClassID, err)
		return nil, err
	}
	log.Printf("actives fetched: uid=%d course=%d class=%d count=%d", uid, sc.CourseID, sc.ClassID, len(actives))
	items := make([]gin.H, 0)
	for _, a := range actives {
		var detail xxt.SignDetail
		var cache model.SignActivity
		cacheErr := h.db.Where("activity_id = ?", a.ActiveID).First(&cache).Error
		cacheFound := cacheErr == nil

		if cacheFound && cache.EndTime != manualEndTimeSentinel {
			detail = xxt.SignDetail{
				StartTime:    cache.StartTime,
				EndTime:      cache.EndTime,
				SignType:     cache.SignType,
				IfRefreshEWM: cache.IfRefreshEWM,
				IfPhoto:      cache.IfPhoto,
			}
		} else {
			remoteDetail, err := h.xxt.GetSignDetail(user.Mobile, password, a.ActiveID)
			if err == nil {
				detail = remoteDetail
				cacheRow := model.SignActivity{
					ActivityID:   a.ActiveID,
					StartTime:    detail.StartTime,
					EndTime:      detail.EndTime,
					SignType:     detail.SignType,
					IfRefreshEWM: detail.IfRefreshEWM,
					IfPhoto:      detail.IfPhoto,
				}
				_ = h.db.Clauses(clause.OnConflict{
					Columns:   []clause.Column{{Name: "activity_id"}},
					DoNothing: true,
				}).Create(&cacheRow).Error
			} else {
				log.Printf("get sign detail failed: uid=%d activity=%d err=%v", uid, a.ActiveID, err)
				if cacheFound {
					detail = xxt.SignDetail{
						StartTime:    cache.StartTime,
						EndTime:      cache.EndTime,
						SignType:     cache.SignType,
						IfRefreshEWM: cache.IfRefreshEWM,
						IfPhoto:      cache.IfPhoto,
					}
				} else {
					continue
				}
			}
		}

		if detail.StartTime == 0 && detail.EndTime == 0 {
			if cacheFound {
				detail = xxt.SignDetail{
					StartTime:    cache.StartTime,
					EndTime:      cache.EndTime,
					SignType:     cache.SignType,
					IfRefreshEWM: cache.IfRefreshEWM,
					IfPhoto:      cache.IfPhoto,
				}
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
		recErr := h.db.Table("sign_records sr").
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
	res := h.signService.ExecuteOne(uid, service.ExecuteSignRequest{
		ActivityID:   req.ActivityID,
		TargetUID:    targetUID,
		SignType:     req.SignType,
		CourseID:     req.CourseID,
		ClassID:      req.ClassID,
		IfRefreshEWM: req.IfRefreshEWM,
		Special:      req.Special,
	})
	common.Success(c, res)
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
