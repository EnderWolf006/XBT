package dto

type LoginRequest struct {
	Mobile   string `json:"mobile" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type LoginResponse struct {
	Token string      `json:"token"`
	User  interface{} `json:"user"`
}

type UpdateCourseSelectionRequest struct {
	CourseIDs []int64 `json:"course_ids" binding:"required"`
}

type SignExecuteRequest struct {
	ActivityID   int64                  `json:"activity_id" binding:"required"`
	TargetUID    int64                  `json:"target_uid"`
	UserIDs      []int64                `json:"user_ids"` // backward compatibility, first element is used if target_uid is empty
	SignType     int                    `json:"sign_type"`
	CourseID     int64                  `json:"course_id" binding:"required"`
	ClassID      int64                  `json:"class_id" binding:"required"`
	IfRefreshEWM bool                   `json:"if_refresh_ewm"`
	Special      map[string]interface{} `json:"special_params"`
}

type SignCheckRequest struct {
	ActivityID int64   `json:"activity_id" binding:"required"`
	UserIDs    []int64 `json:"user_ids"`
}

type AddWhitelistRequest struct {
	Mobile string `json:"mobile" binding:"required"`
}

type BatchWhitelistRequest struct {
	Mobiles string `json:"mobiles" binding:"required"`
}
