package db_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"xbt2/server/internal/amap"
	"xbt2/server/internal/common"
	"xbt2/server/internal/config"
	appdb "xbt2/server/internal/db"
	"xbt2/server/internal/handler"
	"xbt2/server/internal/model"
	"xbt2/server/internal/service"
	"xbt2/server/internal/xxt"
)

type fixedPOIs []amap.POI

func (p fixedPOIs) SearchPOI(context.Context, amap.SearchQuery) ([]amap.POI, error) {
	return p, nil
}

func (p fixedPOIs) QueryKeywords(q amap.SearchQuery) (string, error) { return q.Keywords, nil }

type fixedSignActivities struct {
	active      xxt.Active
	detail      xxt.SignDetail
	detailError error
	detailCalls int
}

func (f *fixedSignActivities) GetActivesContext(ctx context.Context, _, _ string, courseID, classID int64) ([]xxt.Active, error) {
	if courseID != 99882 || classID != 99882 {
		return nil, errors.New("unselected course was fetched")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return []xxt.Active{f.active}, nil
}

func (f *fixedSignActivities) GetSignDetailContext(ctx context.Context, _, _ string, activityID int64) (xxt.SignDetail, error) {
	f.detailCalls++
	if err := ctx.Err(); err != nil {
		return xxt.SignDetail{}, err
	}
	if activityID != f.active.ActiveID {
		return xxt.SignDetail{}, errors.New("wrong activity")
	}
	return f.detail, f.detailError
}

func savePOIs(ctx context.Context, svc *service.SignLocationService, pois fixedPOIs) ([]model.SignLocation, error) {
	rows := make([]model.SignLocation, 0, len(pois))
	for _, p := range pois {
		result, err := svc.SaveCandidate(ctx, service.SignLocationCandidate{Name: p.Name, Address: p.Address, Latitude: p.Latitude, Longitude: p.Longitude, AMAPPoiID: p.POIID, Source: "untrusted"})
		if err != nil {
			return nil, err
		}
		rows = append(rows, result.Location)
	}
	return rows, nil
}

func TestPostgresSignLocations(t *testing.T) {
	dsn := os.Getenv("XBT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("需要显式设置隔离测试数据库 XBT_TEST_POSTGRES_DSN")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") ||
		!strings.HasPrefix(u.Path, "/xbt_sign_location_test") {
		t.Fatal("仅允许本机 xbt_sign_location_test 前缀的专用测试数据库 URL")
	}
	admin, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal("无法连接隔离 PostgreSQL 测试数据库")
	}
	adminSQL, err := admin.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { adminSQL.Close() })
	schema := fmt.Sprintf("sign_location_it_%d", time.Now().UnixNano())
	if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error; err != nil {
			t.Errorf("清理测试 schema 失败: %v", err)
		}
	})
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	cfg := config.Config{PostgresDSN: u.String()}
	database, err := appdb.New(cfg)
	if err != nil {
		t.Fatalf("首次 AutoMigrate/ensureSignLocationSchema 失败: %v", err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	sqlDB.SetMaxOpenConns(80)
	database.Logger = logger.Default.LogMode(logger.Silent)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	database = database.WithContext(ctx)

	t.Run("migration_repeat_and_schema", func(t *testing.T) {
		reopened, err := appdb.New(cfg)
		if err != nil {
			t.Fatalf("重复迁移失败: %v", err)
		}
		reopenedSQL, err := reopened.DB()
		if err != nil {
			t.Fatal(err)
		}
		reopenedSQL.Close()
		var tables int64
		if err := database.Raw("SELECT count(*) FROM pg_tables WHERE schemaname = ?", schema).Scan(&tables).Error; err != nil || tables != 7 {
			t.Fatalf("应迁移全部 7 张表: count=%d err=%v", tables, err)
		}
		var indexes int64
		if err := database.Raw("SELECT count(*) FROM pg_indexes WHERE schemaname = ? AND indexname IN ('uq_sign_locations_name_address_coords', 'uq_sign_locations_amap_poi_id', 'uq_sign_locations_user_name_address_coords')", schema).Scan(&indexes).Error; err != nil || indexes != 3 {
			t.Fatalf("缺少全局或个人地点唯一索引: count=%d err=%v", indexes, err)
		}
		row := model.SignLocation{Name: "invalid-status", Address: "test", Status: "invalid"}
		var pgErr *pgconn.PgError
		if err := database.Create(&row).Error; !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("状态 CHECK 未生效: %v", err)
		}
	})

	t.Run("activity_refresh_completed_context", func(t *testing.T) {
		cc := service.NewCredentialCrypto("isolated-activity-context-secret")
		cipher, err := cc.Encrypt("synthetic-not-submitted")
		if err != nil {
			t.Fatal(err)
		}
		user := model.User{UID: 99881, Mobile: "activity-context-test", Name: "Activity context test", CredentialCipher: cipher}
		if err := database.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
		h := handler.NewSignHandler(database, nil, cc, nil, 5)
		router := gin.New()
		router.Use(func(c *gin.Context) {
			c.Set(common.CtxUserUID, user.UID)
			c.Next()
		})
		router.GET("/activities", h.Activities)
		for _, step := range []struct {
			refresh bool
			state   string
		}{{false, "MISS"}, {false, "HIT"}, {true, "MISS"}} {
			request := httptest.NewRequest(http.MethodGet, "/activities", nil)
			if step.refresh {
				request.Header.Set("Cache-Control", "no-cache")
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("completed activity refresh returned %d: %s", response.Code, response.Body.String())
			}
			var body struct {
				Code    int               `json:"code"`
				Message string            `json:"message"`
				Data    []json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil ||
				body.Code != 0 || body.Message != "ok" || body.Data == nil || len(body.Data) != 0 {
				t.Fatalf("empty selection must return a successful empty list: %s", response.Body.String())
			}
			if response.Header().Get("X-Activity-Cache") != step.state {
				t.Fatalf("unexpected activity cache state: %s", response.Header().Get("X-Activity-Cache"))
			}
		}
	})

	t.Run("activity_location_rules_revalidate_legacy_cache", func(t *testing.T) {
		cc := service.NewCredentialCrypto("isolated-activity-rules-secret")
		cipher, err := cc.Encrypt("synthetic-not-submitted")
		if err != nil {
			t.Fatal(err)
		}
		user := model.User{UID: 99882, Mobile: "activity-rules-test", Name: "Activity rules test", CredentialCipher: cipher}
		if err := database.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
		for _, id := range []int64{99882, 99883} {
			if err := database.Create(&model.Course{CourseID: id, ClassID: id, Name: "Synthetic rules course", Teacher: "Test"}).Error; err != nil {
				t.Fatal(err)
			}
			if err := database.Create(&model.UserCourse{UserUID: user.UID, CourseID: id, ClassID: id, IsSelected: id == 99882}).Error; err != nil {
				t.Fatal(err)
			}
		}
		now := time.Now().UnixMilli()
		legacy := model.SignActivity{ActivityID: 99882, StartTime: now - 120000, EndTime: now - 60000, SignType: 2, NeedFace: true}
		if err := database.Create(&legacy).Error; err != nil {
			t.Fatal(err)
		}
		upstream := &fixedSignActivities{
			active: xxt.Active{ActiveID: legacy.ActivityID, Name: "Synthetic QR activity"},
			detail: xxt.SignDetail{StartTime: legacy.StartTime, EndTime: legacy.EndTime, SignType: 2, IfGetRange: true},
		}
		h := handler.NewSignHandler(database, upstream, cc, nil, 5)
		router := gin.New()
		router.Use(func(c *gin.Context) { c.Set(common.CtxUserUID, user.UID); c.Next() })
		router.GET("/activities", h.Activities)
		refresh := func() *httptest.ResponseRecorder {
			t.Helper()
			req := httptest.NewRequest(http.MethodGet, "/activities", nil)
			req.Header.Set("Cache-Control", "no-cache")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			return response
		}
		check := func(wantRange, verified, face bool) {
			t.Helper()
			response := refresh()
			var body struct {
				Data []struct {
					CourseID   int64 `json:"course_id"`
					Activities []struct {
						SignType int  `json:"sign_type"`
						Range    bool `json:"if_get_range"`
						Verified bool `json:"rules_verified"`
						Face     bool `json:"need_face"`
					} `json:"activities"`
				} `json:"data"`
			}
			if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil ||
				len(body.Data) != 1 || body.Data[0].CourseID != 99882 || len(body.Data[0].Activities) != 1 {
				t.Fatalf("selected activity disappeared: %s", response.Body.String())
			}
			got := body.Data[0].Activities[0]
			if got.SignType != 2 || got.Range != wantRange || got.Verified != verified || got.Face != face {
				t.Fatalf("incorrect activity requirement response: %+v", got)
			}
		}
		check(true, true, true)
		var cached model.SignActivity
		if err := database.Where("activity_id = ?", legacy.ActivityID).First(&cached).Error; err != nil ||
			cached.RulesVersion == 0 || !cached.IfGetRange {
			t.Fatalf("legacy completed cache was not upgraded: %+v err=%v", cached, err)
		}
		upstream.detailError = errors.New("must not refetch verified completed rules")
		check(true, true, true)
		if upstream.detailCalls != 1 {
			t.Fatalf("completed cache added repeat upstream work: %d", upstream.detailCalls)
		}
		upstream.detailError = nil
		upstream.detail.EndTime = now + 60000
		if err := database.Model(&cached).Updates(map[string]interface{}{"end_time": upstream.detail.EndTime, "if_get_range": false, "need_face": false}).Error; err != nil {
			t.Fatal(err)
		}
		check(true, true, false)
		upstream.detail.IfGetRange = false
		check(false, true, false)
		if upstream.detailCalls != 3 {
			t.Fatal("ongoing teacher requirement changes were not refreshed")
		}
		if err := database.Model(&cached).Updates(map[string]interface{}{"end_time": legacy.EndTime, "rules_version": 0}).Error; err != nil {
			t.Fatal(err)
		}
		upstream.detailError = errors.New("synthetic modern rule failure")
		check(false, false, false)
		upstream.active.ActiveID++
		if response := refresh(); response.Code != http.StatusBadGateway {
			t.Fatalf("uncached rule failure silently dropped activity: %d %s", response.Code, response.Body.String())
		}
		upstream.active.ActiveID = legacy.ActivityID
		upstream.detailError = errors.New("学习通登录已失效，请重新登录")
		if response := refresh(); response.Code != http.StatusUnauthorized {
			t.Fatalf("expired upstream authentication was hidden by cached rules: %d %s", response.Code, response.Body.String())
		}
	})

	t.Run("capture_preview_zero_writes_and_source_protection", func(t *testing.T) {
		var before, after int64
		if err := database.Unscoped().Model(&model.SignLocation{}).Count(&before).Error; err != nil {
			t.Fatal(err)
		}
		router := gin.New()
		router.POST("/preview", handler.NewLocationCaptureHandler(nil).CoordinatePreview)
		for i := 0; i < 3; i++ {
			w := httptest.NewRecorder()
			req := httptest.NewRequest("POST", "/preview", strings.NewReader(`{"latitude":39.915,"longitude":116.404,"accuracy":51,"captured_at":"2026-09-25T06:00:00Z"}`))
			req.Header.Set("Content-Type", "application/json")
			router.ServeHTTP(w, req)
			if w.Code != 200 {
				t.Fatal("坐标预览失败")
			}
		}
		if err := database.Unscoped().Model(&model.SignLocation{}).Count(&after).Error; err != nil || before != after {
			t.Fatal("预览不得写库")
		}
		svc := service.NewSignLocationService(database, nil)
		for _, source := range []string{"device_gps", "map_pick"} {
			row, err := svc.Create(service.CreateSignLocationInput{Name: "capture-" + source, Address: "synthetic", Latitude: 39.916404, Longitude: 116.410244,
				Source: source, Status: model.SignLocationEnabled, AMAPPoiID: "must-be-cleared"})
			if err != nil || row.Source != source || row.Status != model.SignLocationPending || row.AMAPPoiID != "" {
				t.Fatalf("采集来源保护失败: %v", err)
			}
			if err := svc.SetStatus(row.ID, model.SignLocationEnabled); err != nil {
				t.Fatal(err)
			}
			if err := database.Model(&row).Update("amap_poi_id", "synthetic-"+source).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.Update(row.ID, service.UpdateSignLocationInput{Name: row.Name, Address: row.Address, Latitude: 39.9165, Longitude: 116.4103, Source: source}); err != nil {
				t.Fatal(err)
			}
			var updated model.SignLocation
			if err := database.First(&updated, row.ID).Error; err != nil || updated.Status != model.SignLocationPending || updated.AMAPPoiID != "" || updated.Source != source {
				t.Fatal("重新采集必须pending并清POI")
			}
		}
	})

	t.Run("configuration_idempotency_and_preservation", func(t *testing.T) {
		svc := service.NewSignLocationService(database, nil)
		inputs := []config.SignLocationConfig{
			{Name: "config-poi", Address: "test", Latitude: 11, Longitude: 21, AMAPPoiID: "config-poi"},
			{Name: "config-coord", Address: "test", Latitude: 12.1234567, Longitude: 22.1234567},
		}
		first, err := svc.ImportConfigured(ctx, inputs)
		if err != nil || len(first) != 2 {
			t.Fatalf("首次导入失败: %v", err)
		}
		for _, row := range first {
			if row.Status != model.SignLocationPending || row.Source != "config" {
				t.Fatal("配置默认状态或来源错误")
			}
		}
		if err := svc.Update(first[0].ID, service.UpdateSignLocationInput{Name: "admin-edit", Address: "edited", Latitude: 13, Longitude: 23}); err != nil {
			t.Fatal(err)
		}
		if err := svc.SetStatus(first[0].ID, model.SignLocationEnabled); err != nil {
			t.Fatal(err)
		}
		inputs[1].Name = "changed-config-name"
		second, err := svc.ImportConfigured(ctx, inputs)
		if err != nil || len(second) != 2 || second[0].ID != first[0].ID || second[1].ID != first[1].ID ||
			second[0].Name != "admin-edit" || second[0].Status != model.SignLocationEnabled ||
			second[1].Name != "config-coord" || second[1].Latitude != 12.123457 {
			t.Fatalf("重复导入应复用记录并保留管理员更改: %v", err)
		}
		for i, source := range []string{"manual", "amap"} {
			row := model.SignLocation{Name: source, Address: "existing", Latitude: 30 + float64(i), Longitude: 40, AMAPPoiID: source, Source: source, Status: model.SignLocationEnabled}
			if err := database.Create(&row).Error; err != nil {
				t.Fatal(err)
			}
			got, err := svc.ImportConfigured(ctx, []config.SignLocationConfig{{Name: "overwrite", Address: "overwrite", AMAPPoiID: source}})
			if err != nil || len(got) != 1 || got[0].ID != row.ID || got[0].Name != source || got[0].Source != source || got[0].Status != model.SignLocationEnabled {
				t.Fatalf("不应覆盖 %s 记录: %v", source, err)
			}
		}
		var before, after int64
		if err := database.Model(&model.SignLocation{}).Count(&before).Error; err != nil {
			t.Fatal(err)
		}
		_, err = svc.ImportConfigured(ctx, []config.SignLocationConfig{
			{Name: "must-rollback", Address: "test", Latitude: 45, Longitude: 45},
			{Name: "invalid", Address: "test", Latitude: 91},
		})
		if err := database.Model(&model.SignLocation{}).Count(&after).Error; err != nil {
			t.Fatal(err)
		}
		if err == nil || before != after {
			t.Fatal("非法配置不应产生部分写入")
		}
	})

	t.Run("readonly_search_explicit_save_and_deleted_preservation", func(t *testing.T) {
		pois := fixedPOIs{{Name: "readonly-building", Address: "synthetic-campus", Latitude: 32.1234567, Longitude: 114.1234567, POIID: "readonly-poi"}}
		svc := service.NewSignLocationService(database, pois)
		var before, after int64
		if err := database.Unscoped().Model(&model.SignLocation{}).Count(&before).Error; err != nil {
			t.Fatal(err)
		}
		var candidate service.SignLocationCandidate
		for _, keyword := range []string{"教学楼", "图书馆"} {
			rows, err := svc.SearchCandidates(ctx, amap.SearchQuery{Keywords: keyword})
			if err != nil || len(rows) != 1 || rows[0].Source != "amap" || rows[0].Latitude != 32.123457 {
				t.Fatalf("搜索必须返回无数据库ID的规范候选: %v", err)
			}
			candidate = rows[0]
		}
		if err := database.Unscoped().Model(&model.SignLocation{}).Count(&after).Error; err != nil || before != after {
			t.Fatal("连续搜索不能写入数据库")
		}
		saved, err := svc.SaveCandidate(ctx, candidate)
		if err != nil || !saved.Created || saved.Location.Status != model.SignLocationPending || saved.Location.Source != "amap" {
			t.Fatalf("显式确认才新增pending: %v", err)
		}
		id := saved.Location.ID
		if err := svc.Update(id, service.UpdateSignLocationInput{Name: "admin-preserved", Address: "admin-address", Latitude: 33, Longitude: 115}); err != nil {
			t.Fatal(err)
		}
		if err := svc.SetStatus(id, model.SignLocationEnabled); err != nil {
			t.Fatal(err)
		}
		repeated, err := svc.SaveCandidate(ctx, candidate)
		if err != nil || repeated.Created || repeated.Location.ID != id || repeated.Location.Name != "admin-preserved" ||
			repeated.Location.Address != "admin-address" || repeated.Location.Latitude != 33 || repeated.Location.Status != model.SignLocationEnabled {
			t.Fatalf("重复保存必须保护管理员编辑和启用状态: %v", err)
		}
		if err := svc.SoftDelete(id); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.SaveCandidate(ctx, candidate); !errors.Is(err, service.ErrSignLocationDeleted) {
			t.Fatalf("禁止用同一POI恢复已删记录: %v", err)
		}
		candidate.AMAPPoiID = ""
		candidate.Name, candidate.Address, candidate.Latitude, candidate.Longitude = "admin-preserved", "admin-address", 33, 115
		if _, err := svc.SaveCandidate(ctx, candidate); !errors.Is(err, service.ErrSignLocationDeleted) {
			t.Fatalf("无POI时也不能以相同名称/坐标恢复已删地点: %v", err)
		}
		if err := database.Unscoped().Model(&model.SignLocation{}).Count(&after).Error; err != nil || after != before+1 {
			t.Fatal("搜索或重复确认产生额外记录")
		}
	})

	t.Run("concurrent_candidate_save_unique_conflicts", func(t *testing.T) {
		for _, withPOI := range []bool{true, false} {
			t.Run(fmt.Sprintf("poi_%t", withPOI), func(t *testing.T) {
				const workers = 64
				poi := amap.POI{Name: fmt.Sprintf("race-%t", withPOI), Address: "test", Latitude: 51.1234567, Longitude: 61}
				if withPOI {
					poi.POIID = "race-poi"
				}
				svc := service.NewSignLocationService(database, fixedPOIs{poi})
				var ready atomic.Int64
				gate := make(chan struct{})
				var conflicts atomic.Int64
				beforeName, afterName := "test:race_before", "test:race_after"
				if err := database.Callback().Create().Before("gorm:create").Register(beforeName, func(tx *gorm.DB) {
					if row, ok := tx.Statement.Dest.(*model.SignLocation); ok && row.Name == poi.Name {
						if ready.Add(1) == workers {
							close(gate)
						}
						select {
						case <-gate:
						case <-ctx.Done():
							tx.AddError(ctx.Err())
						}
					}
				}); err != nil {
					t.Fatal(err)
				}
				if err := database.Callback().Create().After("gorm:create").Register(afterName, func(tx *gorm.DB) {
					var pgErr *pgconn.PgError
					if errors.As(tx.Error, &pgErr) && pgErr.Code == "23505" {
						conflicts.Add(1)
					}
				}); err != nil {
					t.Fatal(err)
				}
				defer database.Callback().Create().Remove(beforeName)
				defer database.Callback().Create().Remove(afterName)
				type result struct {
					rows []model.SignLocation
					err  error
				}
				results := make(chan result, workers)
				for i := 0; i < workers; i++ {
					go func() {
						rows, err := savePOIs(ctx, svc, fixedPOIs{poi})
						results <- result{rows, err}
					}()
				}
				var id uint
				for i := 0; i < workers; i++ {
					got := <-results
					if got.err != nil || len(got.rows) != 1 {
						t.Errorf("并发候选失败: %v", got.err)
						continue
					}
					row := got.rows[0]
					if id == 0 {
						id = row.ID
					}
					if row.ID != id || row.Status != model.SignLocationPending || row.Source != "amap" || row.Latitude != 51.123457 {
						t.Error("并发结果必须复用同一待确认记录及六位坐标")
					}
				}
				var count int64
				if err := database.Model(&model.SignLocation{}).Where("name = ?", poi.Name).Count(&count).Error; err != nil || count != 1 || conflicts.Load() != workers-1 {
					t.Fatalf("必须真实触发 63 次唯一冲突且仅存 1 条: count=%d conflicts=%d err=%v", count, conflicts.Load(), err)
				}
				t.Logf("64 个并发请求，%d 次真实 PostgreSQL 唯一冲突，1 条待确认记录", conflicts.Load())
			})
		}
	})

	t.Run("explicit_restore_preserves_identity_fields_and_concurrency", func(t *testing.T) {
		svc := service.NewSignLocationService(database, nil)
		candidate := service.SignLocationCandidate{Name: "restore-search-name", Address: "restore-search-address", Latitude: 34, Longitude: 116, AMAPPoiID: "restore-poi"}
		saved, err := svc.SaveCandidate(ctx, candidate)
		if err != nil {
			t.Fatal(err)
		}
		id := saved.Location.ID
		if err := svc.Update(id, service.UpdateSignLocationInput{Name: "restore-admin-name", Address: "restore-admin-address", Latitude: 35, Longitude: 117}); err != nil {
			t.Fatal(err)
		}
		if err := svc.SetStatus(id, model.SignLocationDisabled); err != nil {
			t.Fatal(err)
		}
		if err := svc.SoftDelete(id); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 5; i++ {
			_, err := svc.SaveCandidate(ctx, candidate)
			var deleted *service.DeletedSignLocationError
			if !errors.As(err, &deleted) || deleted.Location.ID != id || deleted.Location.Name != "restore-admin-name" {
				t.Fatalf("软删冲突必须携带真实旧ID与管理员内容: %v", err)
			}
		}
		var removed model.SignLocation
		if err := database.Unscoped().First(&removed, id).Error; err != nil || !removed.DeletedAt.Valid || removed.Status != model.SignLocationDisabled {
			t.Fatal("未确认时不能恢复或改变旧状态")
		}
		start := make(chan struct{})
		errs := make(chan error, 64)
		var restored atomic.Int64
		for i := 0; i < 64; i++ {
			go func(restore bool) {
				<-start
				var result service.SaveCandidateResult
				var err error
				if restore {
					result, err = svc.RestoreCandidate(ctx, id)
				} else {
					result, err = svc.SaveCandidate(ctx, candidate)
				}
				if !restore && errors.Is(err, service.ErrSignLocationDeleted) {
					errs <- nil
					return
				}
				if err == nil && (result.Location.ID != id || result.Created || result.Location.Name != "restore-admin-name" ||
					result.Location.Address != "restore-admin-address" || result.Location.Latitude != 35 || result.Location.Longitude != 117 ||
					result.Location.Status != model.SignLocationPending || result.Location.Source != "amap") {
					err = fmt.Errorf("恢复/保存并发改变了旧身份或字段")
				}
				if result.Restored {
					restored.Add(1)
				}
				errs <- err
			}(i%2 == 0)
		}
		close(start)
		for i := 0; i < 64; i++ {
			if err := <-errs; err != nil {
				t.Error(err)
			}
		}
		if restored.Load() != 1 {
			t.Fatalf("仅一次显式恢复应改变softdelete: %d", restored.Load())
		}
		var count int64
		if err := database.Unscoped().Model(&model.SignLocation{}).Where("amap_poi_id = ?", candidate.AMAPPoiID).Count(&count).Error; err != nil || count != 1 {
			t.Fatal("并发恢复/保存不能创建重复记录")
		}
		for _, status := range []string{model.SignLocationEnabled, model.SignLocationDisabled} {
			if err := svc.SetStatus(id, status); err != nil {
				t.Fatal(err)
			}
			result, err := svc.RestoreCandidate(ctx, id)
			if err != nil || result.Restored || result.Location.Status != status {
				t.Fatal("对已恢复记录重复操作不能改变启停状态")
			}
		}
		t.Log("32路恢复+32路保存并发：仅一次恢复、同一旧ID、旧编辑字段保留")
	})

	t.Run("restore_unique_conflict_rolls_back_deleted_state", func(t *testing.T) {
		svc := service.NewSignLocationService(database, nil)
		for _, byPOI := range []bool{true, false} {
			input := service.CreateSignLocationInput{Name: fmt.Sprintf("restore-conflict-%t", byPOI), Address: "synthetic", Latitude: 36, Longitude: 118}
			if byPOI {
				input.AMAPPoiID = "restore-conflict-poi"
			}
			old, err := svc.Create(input)
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.SoftDelete(old.ID); err != nil {
				t.Fatal(err)
			}
			active, err := svc.Create(input)
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.SetStatus(active.ID, model.SignLocationEnabled); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.RestoreCandidate(ctx, old.ID); !errors.Is(err, service.ErrSignLocationConflict) {
				t.Fatalf("恢复唯一冲突应明确返回冲突: %v", err)
			}
			var deleted model.SignLocation
			if err := database.Unscoped().First(&deleted, old.ID).Error; err != nil || !deleted.DeletedAt.Valid {
				t.Fatal("恢复冲突必须回滚，保留软删状态")
			}
			result, err := svc.RestoreCandidate(ctx, active.ID)
			if err != nil || result.Restored || result.Location.Status != model.SignLocationEnabled {
				t.Fatal("不能改变已有启用记录")
			}
		}
		if _, err := svc.RestoreCandidate(ctx, 0); !errors.Is(err, service.ErrInvalidSignLocationInput) {
			t.Fatal("零ID应拒绝")
		}
		if _, err := svc.RestoreCandidate(ctx, 999999); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatal("不存在ID应明确返回")
		}
	})

	t.Run("candidate_composite_conflict_with_different_poi", func(t *testing.T) {
		pois := fixedPOIs{
			{Name: "same-building", Address: "test", Latitude: 55, Longitude: 65, POIID: "alias-a"},
			{Name: "same-building", Address: "test", Latitude: 55, Longitude: 65, POIID: "alias-b"},
		}
		rows, err := savePOIs(ctx, service.NewSignLocationService(database, pois), pois)
		if err != nil || len(rows) != 2 || rows[0].ID != rows[1].ID {
			t.Fatalf("复合坐标唯一冲突应复用已有地点: %v", err)
		}
		svc := service.NewSignLocationService(database, pois)
		if err := svc.SetStatus(rows[0].ID, model.SignLocationEnabled); err != nil {
			t.Fatal(err)
		}
		repeated, err := savePOIs(ctx, svc, pois)
		if err != nil || len(repeated) != 2 || repeated[0].ID != rows[0].ID || repeated[1].ID != rows[0].ID ||
			repeated[0].Status != model.SignLocationEnabled || repeated[1].Status != model.SignLocationEnabled {
			t.Fatalf("重复确认应复用地点并保留管理员启用状态: %v", err)
		}
	})

	t.Run("uniqueness_soft_delete_and_enabled_visibility", func(t *testing.T) {
		svc := service.NewSignLocationService(database, nil)
		input := service.CreateSignLocationInput{Name: "manual-unique", Address: "test", Latitude: 71, Longitude: 81, AMAPPoiID: "manual-unique"}
		row, err := svc.Create(input)
		if err != nil {
			t.Fatal(err)
		}
		input.AMAPPoiID = "different-poi"
		if _, err := svc.Create(input); !errors.Is(err, service.ErrSignLocationConflict) {
			t.Fatalf("复合唯一冲突应返回业务冲突: %v", err)
		}
		input.Name = "different-name"
		input.AMAPPoiID = row.AMAPPoiID
		if _, err := svc.Create(input); !errors.Is(err, service.ErrSignLocationConflict) {
			t.Fatalf("POI 唯一冲突应返回业务冲突: %v", err)
		}
		signSvc := service.NewSignService(database, nil, nil)
		if _, err := signSvc.ResolveLocationSpecial(row.ID, nil); err == nil {
			t.Fatal("待确认地点不可用于签到")
		}
		if err := svc.SetStatus(row.ID, model.SignLocationEnabled); err != nil {
			t.Fatal(err)
		}
		special, err := signSvc.ResolveLocationSpecial(row.ID, map[string]interface{}{"latitude": "0", "longitude": "0", "description": "spoof"})
		if err != nil || special["latitude"] != "71" || special["longitude"] != "81" || special["description"] != "test" {
			t.Fatalf("地点坐标映射错误: %v", err)
		}
		for _, status := range []string{model.SignLocationEnabled, model.SignLocationDisabled} {
			if err := svc.SetStatus(row.ID, status); err != nil {
				t.Fatal(err)
			}
			rows, err := svc.ListEnabled(ctx)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, candidate := range rows {
				found = found || candidate.ID == row.ID
			}
			if found != (status == model.SignLocationEnabled) {
				t.Fatal("用户列表地点状态过滤错误")
			}
		}
		if _, err := signSvc.ResolveLocationSpecial(row.ID, nil); err == nil {
			t.Fatal("停用地点不可用于签到")
		}
		if err := svc.SoftDelete(row.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := signSvc.ResolveLocationSpecial(row.ID, nil); err == nil {
			t.Fatal("软删除地点不可用于签到")
		}
		input.Name = row.Name
		if replacement, err := svc.Create(input); err != nil || replacement.ID == row.ID {
			t.Fatalf("软删除后应允许重新创建: %v", err)
		}
		for _, name := range []string{"empty-poi-a", "empty-poi-b"} {
			if _, err := svc.Create(service.CreateSignLocationInput{Name: name, Address: "test", Latitude: 80, Longitude: 90}); err != nil {
				t.Fatalf("空 POI 不应互相冲突: %v", err)
			}
		}
	})

	t.Run("personal_locations_are_isolated_by_owner", func(t *testing.T) {
		svc := service.NewSignLocationService(database, nil)
		name := fmt.Sprintf("personal-%d", time.Now().UnixNano())
		input := service.CreateSignLocationInput{Name: name, Address: "private address", Latitude: 31.2, Longitude: 121.5}
		first, err := svc.CreatePersonal(ctx, 81001, input)
		if err != nil {
			t.Fatal(err)
		}
		second, err := svc.CreatePersonal(ctx, 81002, input)
		if err != nil {
			t.Fatalf("different users may save the same location: %v", err)
		}
		for uid, visibleID := range map[int64]uint{81001: first.ID, 81002: second.ID} {
			rows, err := svc.ListEnabledForUser(ctx, uid)
			if err != nil {
				t.Fatal(err)
			}
			foundOwn, foundOther := false, false
			for _, row := range rows {
				foundOwn = foundOwn || row.ID == visibleID
				foundOther = foundOther || row.ID == first.ID && uid == 81002 || row.ID == second.ID && uid == 81001
			}
			if !foundOwn || foundOther {
				t.Fatalf("uid %d did not see only their own personal location", uid)
			}
		}
		if err := svc.UpdatePersonal(ctx, 81002, first.ID, service.UpdateSignLocationInput{Name: "takeover", Address: "other", Latitude: 31.2, Longitude: 121.5}); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatalf("another user must not update this location: %v", err)
		}
		if err := svc.DeletePersonal(ctx, 81002, first.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatalf("another user must not delete this location: %v", err)
		}
		signSvc := service.NewSignService(database, nil, nil)
		qrResult := signSvc.ExecuteOne(81002, service.ExecuteSignRequest{SignType: 2, LocationID: first.ID, TargetUID: 81002})
		if qrResult.Success || qrResult.Message != "签到地点不可用" {
			t.Fatalf("QR sign must reject another user's location before contacting external services: %+v", qrResult)
		}
		if _, err := signSvc.ResolveLocationSpecialForUser(first.ID, 81002, nil); !errors.Is(err, service.ErrSignLocationUnavailable) {
			t.Fatalf("another user must not use this personal location: %v", err)
		}
		if _, err := signSvc.ResolveLocationSpecialForUser(first.ID, 81001, nil); err != nil {
			t.Fatalf("owner should be able to use their personal location: %v", err)
		}
		globalRows, err := svc.List(ctx, "")
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range globalRows {
			if row.ID == first.ID || row.ID == second.ID {
				t.Fatal("admin global location list must not include personal locations")
			}
		}
		public, err := svc.Create(service.CreateSignLocationInput{Name: name + "-legacy", Address: "legacy unowned address", Latitude: 31, Longitude: 121})
		if err != nil {
			t.Fatal(err)
		}
		if err := svc.SetStatus(public.ID, model.SignLocationEnabled); err != nil {
			t.Fatal(err)
		}
		signSvc.UsePersonalLocationsOnly()
		if _, err := signSvc.ResolveLocationSpecialForUser(public.ID, 81001, nil); !errors.Is(err, service.ErrSignLocationUnavailable) {
			t.Fatalf("personal-only mode must reject legacy global records: %v", err)
		}
		if _, err := signSvc.ResolveLocationSpecialForUser(first.ID, 81001, nil); err != nil {
			t.Fatalf("owner must retain access in personal-only mode: %v", err)
		}
		h := handler.NewSignLocationHandler(svc)
		h.UsePersonalLocationsOnly()
		for _, uid := range []int64{81001, 81002} {
			router := gin.New()
			router.Use(func(c *gin.Context) { c.Set(common.CtxUserUID, uid); c.Set(common.CtxPermission, 2); c.Next() })
			router.GET("/locations", h.ListEnabled)
			router.PUT("/personal/:id", h.UpdatePersonal)
			router.DELETE("/personal/:id", h.DeletePersonal)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/locations", nil))
			var body struct {
				Data []model.SignLocation `json:"data"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || recorder.Code != 200 {
				t.Fatalf("personal list HTTP response: %s (%v)", recorder.Body, err)
			}
			expectedID := first.ID
			if uid == 81002 {
				expectedID = second.ID
			}
			if len(body.Data) != 1 || body.Data[0].ID != expectedID || !body.Data[0].IsPersonal {
				t.Fatalf("admin uid %d saw records outside their ownership: %+v", uid, body.Data)
			}
			if uid == 81002 {
				for _, method := range []string{http.MethodPut, http.MethodDelete} {
					recorder := httptest.NewRecorder()
					req := httptest.NewRequest(method, fmt.Sprintf("/personal/%d", first.ID), strings.NewReader(`{"name":"takeover","address":"other","latitude":31,"longitude":121}`))
					req.Header.Set("Content-Type", "application/json")
					router.ServeHTTP(recorder, req)
					if recorder.Code != http.StatusNotFound {
						t.Fatalf("cross-owner %s must return 404, got %d", method, recorder.Code)
					}
				}
			}
		}
	})
}
