package model

import (
	"time"

	"gorm.io/gorm"
)

const (
	SignLocationPending  = "pending"
	SignLocationEnabled  = "enabled"
	SignLocationDisabled = "disabled"
)

type User struct {
	ID               uint      `gorm:"primaryKey" json:"-"`
	UID              int64     `gorm:"unique;not null" json:"uid"`
	Mobile           string    `gorm:"size:32;unique;not null" json:"mobile"`
	Name             string    `gorm:"size:128;not null" json:"name"`
	Avatar           string    `gorm:"size:1024" json:"avatar"`
	CredentialCipher string    `gorm:"type:text;not null" json:"-"`
	Permission       int       `gorm:"not null;default:1" json:"permission"`
	LastLoginAt      time.Time `json:"-"`
	CreatedAt        time.Time `json:"-"`
	UpdatedAt        time.Time `json:"-"`
}

type Whitelist struct {
	ID         uint      `gorm:"primaryKey" json:"-"`
	Mobile     string    `gorm:"size:32;unique;not null" json:"Mobile"`
	Permission int       `gorm:"not null;default:1" json:"Permission"`
	CreatedAt  time.Time `json:"-"`
	UpdatedAt  time.Time `json:"-"`
}

type Course struct {
	ID        uint      `gorm:"primaryKey" json:"-"`
	CourseID  int64     `gorm:"not null;uniqueIndex:idx_course_class" json:"course_id"`
	ClassID   int64     `gorm:"not null;uniqueIndex:idx_course_class" json:"class_id"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Teacher   string    `gorm:"size:255" json:"teacher"`
	Icon      string    `gorm:"size:1024" json:"icon"`
	CreatedAt time.Time `json:"-"`
	UpdatedAt time.Time `json:"-"`
}

type UserCourse struct {
	ID         uint      `gorm:"primaryKey" json:"-"`
	UserUID    int64     `gorm:"not null;uniqueIndex:idx_user_course_class" json:"-"`
	CourseID   int64     `gorm:"not null;uniqueIndex:idx_user_course_class" json:"course_id"`
	ClassID    int64     `gorm:"not null;uniqueIndex:idx_user_course_class" json:"class_id"`
	IsSelected bool      `gorm:"not null;default:false" json:"is_selected"`
	CreatedAt  time.Time `json:"-"`
	UpdatedAt  time.Time `json:"-"`
}

type SignActivity struct {
	ID           uint      `gorm:"primaryKey" json:"-"`
	ActivityID   int64     `gorm:"unique;not null" json:"activity_id"`
	StartTime    int64     `gorm:"not null" json:"start_time"`
	EndTime      int64     `gorm:"not null" json:"end_time"`
	SignType     int       `gorm:"not null" json:"sign_type"`
	IfRefreshEWM bool      `gorm:"not null;default:false" json:"if_refresh_ewm"`
	IfPhoto      bool      `gorm:"not null;default:false" json:"if_photo"`
	IfGetRange   bool      `gorm:"not null;default:false" json:"if_get_range"`
	RulesVersion int       `gorm:"not null;default:0" json:"-"`
	NeedFace     bool      `gorm:"not null;default:false" json:"need_face"`
	FaceChecked  int64     `gorm:"not null;default:0" json:"-"`
	CreatedAt    time.Time `json:"-"`
	UpdatedAt    time.Time `json:"-"`
}

type SignRecord struct {
	ID         uint      `gorm:"primaryKey" json:"-"`
	UserUID    int64     `gorm:"not null;uniqueIndex:idx_user_activity" json:"user_uid"`
	ActivityID int64     `gorm:"not null;uniqueIndex:idx_user_activity" json:"activity_id"`
	SourceUID  int64     `gorm:"not null" json:"source_uid"`
	SignTimeMS int64     `gorm:"not null" json:"sign_time_ms"`
	CreatedAt  time.Time `json:"-"`
	UpdatedAt  time.Time `json:"-"`
}

type SignLocation struct {
	ID         uint           `gorm:"primaryKey" json:"id"`
	OwnerUID   *int64         `gorm:"index:idx_sign_locations_owner_uid" json:"-"`
	IsPersonal bool           `gorm:"-" json:"is_personal,omitempty"`
	Name       string         `gorm:"size:255;not null" json:"name"`
	Address    string         `gorm:"size:1024;not null" json:"address"`
	Latitude   float64        `gorm:"not null" json:"latitude"`
	Longitude  float64        `gorm:"not null" json:"longitude"`
	AMAPPoiID  string         `gorm:"size:128" json:"amap_poi_id"`
	Status     string         `gorm:"size:16;not null;default:pending;index:idx_sign_locations_status" json:"status"`
	Source     string         `gorm:"size:16;not null;default:manual" json:"source"`
	CreatedAt  time.Time      `json:"created_at"`
	UpdatedAt  time.Time      `json:"updated_at"`
	DeletedAt  gorm.DeletedAt `gorm:"index" json:"-"`
}
