package handler

import (
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"xbt2/server/internal/common"
	"xbt2/server/internal/dto"
	"xbt2/server/internal/model"
	"xbt2/server/internal/service"
	"xbt2/server/internal/xxt"
)

type CourseHandler struct {
	db  *gorm.DB
	xxt *xxt.Client
	cc  *service.CredentialCrypto
}

func NewCourseHandler(db *gorm.DB, xxtClient *xxt.Client, cc *service.CredentialCrypto) *CourseHandler {
	return &CourseHandler{db: db, xxt: xxtClient, cc: cc}
}

func (h *CourseHandler) List(c *gin.Context) {
	uid := common.GetUserUID(c)
	var rows []struct {
		ClassID    int64  `json:"class_id"`
		CourseID   int64  `json:"course_id"`
		Name       string `json:"name"`
		Teacher    string `json:"teacher"`
		Icon       string `json:"icon"`
		IsSelected bool   `json:"is_selected"`
	}
	err := h.db.Table("user_courses uc").
		Select("c.class_id, c.course_id, c.name, c.teacher, c.icon, uc.is_selected").
		Joins("join courses c on uc.course_id = c.course_id and uc.class_id = c.class_id").
		Where("uc.user_uid = ?", uid).
		Order("uc.is_selected desc, c.name asc").
		Scan(&rows).Error
	if err != nil {
		common.Fail(c, 500, "query courses failed")
		return
	}
	common.Success(c, rows)
}

func (h *CourseHandler) Sync(c *gin.Context) {
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
	courses, err := h.xxt.GetCourses(user.Mobile, password)
	if err != nil {
		if isXXTAuthError(err) {
			common.Fail(c, 401, "学习通登录已失效，请使用新密码重新登录")
			return
		}
		common.Fail(c, 500, "sync courses failed: "+err.Error())
		return
	}
	for _, course := range courses {
		co := model.Course{CourseID: course.CourseID, ClassID: course.ClassID, Name: course.Name, Teacher: course.Teacher, Icon: course.Icon}
		_ = h.db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "course_id"}, {Name: "class_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"name", "teacher", "icon", "updated_at"}),
		}).Create(&co).Error

		uc := model.UserCourse{UserUID: uid, CourseID: course.CourseID, ClassID: course.ClassID, IsSelected: false}
		_ = h.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_uid"}, {Name: "course_id"}, {Name: "class_id"}}, DoNothing: true}).Create(&uc).Error
	}
	common.Success(c, gin.H{"count": len(courses)})
}

func isXXTAuthError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.TrimSpace(err.Error())
	return strings.Contains(msg, "账号或密码错误")
}

func (h *CourseHandler) UpdateSelection(c *gin.Context) {
	uid := common.GetUserUID(c)
	var req dto.UpdateCourseSelectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.Fail(c, 400, "invalid request")
		return
	}
	if err := h.db.Model(&model.UserCourse{}).Where("user_uid = ?", uid).Update("is_selected", false).Error; err != nil {
		common.Fail(c, 500, "reset selection failed")
		return
	}
	if len(req.CourseIDs) > 0 {
		if err := h.db.Model(&model.UserCourse{}).
			Where("user_uid = ? AND course_id IN ?", uid, req.CourseIDs).
			Update("is_selected", true).Error; err != nil {
			common.Fail(c, 500, "update selection failed")
			return
		}
	}
	common.Success(c, gin.H{"selected_count": len(req.CourseIDs)})
}
