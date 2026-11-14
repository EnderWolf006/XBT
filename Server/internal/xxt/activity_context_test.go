package xxt

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestActivityRequestsRespectCancellation(t *testing.T) {
	client := New("", "test", false, 1)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client.sessions["test"] = &Session{Password: "test", Jar: jar, LastLoginAt: time.Now()}
	client.http.Transport = coordinateTransport(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	for _, run := range []func(context.Context) error{
		func(ctx context.Context) error {
			_, err := client.GetActivesContext(ctx, "test", "test", 1, 1)
			return err
		},
		func(ctx context.Context) error {
			_, err := client.GetSignDetailContext(ctx, "test", "test", 1)
			return err
		},
		func(ctx context.Context) error {
			_, err := client.GetNeedFaceContext(ctx, "test", "test", 1, 1, 1)
			return err
		},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		err := run(ctx)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("upstream request ignored deadline: %v", err)
		}
	}
}

func TestSignDetailIncludesModernLocationRules(t *testing.T) {
	legacy := `{"startTime":1700000000000,"endTime":1700000060000,"otherId":2,"ifRefreshEwm":0,"ifPhoto":0,"ifGetRange":0,"latitude":0,"longitude":0}`
	for _, tt := range []struct {
		name, legacy, modern, wantError string
		wantRange, photo, refresh, face bool
	}{
		{name: "modern_position_validation", modern: `{"result":1,"data":{"ifopenAddress":1}}`, wantRange: true},
		{name: "combined_qr_position_photo", modern: `{"result":1,"data":{"ifopenAddress":1,"ifphoto":1,"ifrefreshewm":1}}`, wantRange: true, photo: true, refresh: true},
		{name: "app_face_is_still_explicit", modern: `{"result":1,"data":{"ifopenAddress":1,"openCheckFaceFlag":1}}`, wantRange: true, face: true},
		{name: "no_position_is_not_inferred", modern: `{"result":1,"data":{"ifopenAddress":0}}`},
		{name: "legacy_range_is_preserved", legacy: strings.Replace(legacy, `"ifGetRange":0`, `"ifGetRange":1`, 1), modern: `{"result":1,"data":{"ifopenAddress":0}}`, wantRange: true},
		{name: "authentication_failure_is_not_false", modern: `{"result":0,"msg":"","errorMsg":"用户未登录","data":null}`, wantError: "登录"},
		{name: "missing_rule_is_not_false", modern: `{"result":1,"data":{"otherId":2}}`, wantError: "规则缺失"},
		{name: "bounded_response", modern: strings.Repeat(" ", 256<<10) + `{"result":1,"data":{"ifopenAddress":1}}`, wantError: "响应过大"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			client := New("", "test", false, 1)
			jar, err := cookiejar.New(nil)
			if err != nil {
				t.Fatal(err)
			}
			client.sessions["test"] = &Session{Password: "test", Jar: jar, LastLoginAt: time.Now()}
			var paths []string
			client.http.Transport = coordinateTransport(func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodGet || req.URL.Host != "mobilelearn.chaoxing.com" {
					t.Fatal("rules must only use read-only activity requests")
				}
				paths = append(paths, req.URL.Path)
				body := tt.modern
				switch req.URL.Path {
				case "/newsign/signDetail":
					body = legacy
					if tt.legacy != "" {
						body = tt.legacy
					}
					if req.URL.Query().Get("activePrimaryId") != "77" {
						t.Fatal("wrong legacy activity")
					}
				case "/v2/apis/active/getPPTActiveInfo":
					if req.URL.Query().Get("activeId") != "77" {
						t.Fatal("wrong modern activity")
					}
				default:
					t.Fatalf("unexpected login or sign request: %s", req.URL.Path)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			detail, err := client.GetSignDetailContext(context.Background(), "test", "test", 77)
			if len(paths) != 2 {
				t.Fatalf("unexpected extra upstream requests: %v", paths)
			}
			if tt.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantError) {
					t.Fatalf("invalid rules must fail explicitly: %v", err)
				}
				return
			}
			if err != nil || detail.SignType != SignQRCode || detail.StartTime != 1700000000000 ||
				detail.EndTime != 1700000060000 || detail.IfGetRange != tt.wantRange ||
				detail.IfPhoto != tt.photo || detail.IfRefreshEWM != tt.refresh || detail.NeedFace != tt.face {
				t.Fatalf("incorrect merged activity rules: %+v err=%v", detail, err)
			}
		})
	}
}

func TestModernSignRulesRespectActivityDeadline(t *testing.T) {
	client := New("", "test", false, 1)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client.sessions["test"] = &Session{Password: "test", Jar: jar, LastLoginAt: time.Now()}
	client.http.Transport = coordinateTransport(func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/newsign/signDetail" {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"otherId":2}`))}, nil
		}
		if req.URL.Path != "/v2/apis/active/getPPTActiveInfo" {
			t.Fatal("unexpected request")
		}
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, err = client.GetSignDetailContext(ctx, "test", "test", 77)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("modern rules ignored the activity deadline: %v", err)
	}
}

func TestColdSessionLoginIsMerged(t *testing.T) {
	client := New("1234567890123456", "test", false, 1)
	var logins atomic.Int32
	client.http.Transport = coordinateTransport(func(req *http.Request) (*http.Response, error) {
		switch req.URL.Path {
		case "/fanyalogin":
			logins.Add(1)
			cookie := &http.Cookie{Name: "UID", Value: "99001", Path: "/"}
			header := make(http.Header)
			header.Add("Set-Cookie", cookie.String())
			return &http.Response{StatusCode: 200, Header: header, Body: io.NopCloser(strings.NewReader(`{"status":true}`))}, nil
		case "/base":
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`<p class="user-name">test</p>`))}, nil
		default:
			t.Fatalf("unexpected upstream path: %s", req.URL.Path)
			return nil, errors.New("unexpected request")
		}
	})
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			session, err := client.ensureSessionContext(context.Background(), "test", "test")
			if err == nil && session.UID != 99001 {
				err = errors.New("wrong session uid")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if logins.Load() != 1 {
		t.Fatalf("cold-session stampede: %d logins", logins.Load())
	}
}
