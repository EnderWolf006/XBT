package amap

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"xbt2/server/internal/config"
)

func TestParsePOIResponse(t *testing.T) {
	body := []byte(`{"status":"1","pois":[{"id":"p1","name":"第一教学楼","address":"江淮校区","location":"114.100000,32.100000"}]}`)
	got, err := parsePOIResponse(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Latitude != 32.1 || got[0].Longitude != 114.1 {
		t.Fatalf("unexpected result: %#v", got)
	}
}

func TestSearchPOIUsesInjectedClientAndCampus(t *testing.T) {
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"1","pois":[{"id":"p1","name":"教学楼","address":"校区","location":"114,32"}]}`))
	}))
	defer srv.Close()

	client := NewClient(config.AMapConfig{APIKey: "secret", CampusAddress: "江淮校区"}, srv.Client())
	client.Endpoint = srv.URL
	got, err := client.SearchPOI(context.Background(), SearchQuery{Keywords: "教学楼"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].POIID != "p1" {
		t.Fatalf("unexpected result: %#v", got)
	}
	if gotQuery.Get("key") != "secret" || gotQuery.Get("keywords") != "江淮校区 教学楼" || gotQuery.Has("city") ||
		gotQuery.Get("offset") != "25" || gotQuery.Get("page") != "1" || gotQuery.Get("extensions") != "base" {
		t.Fatal("校区文字应组合到关键词而非城市参数，且只请求有界第一页")
	}
}

func TestSearchPOIPaginatesAndDeduplicatesWithinLimit(t *testing.T) {
	var pages []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		pages = append(pages, page)
		start := 0
		if page == "2" {
			start = 24
		} else if page == "3" {
			start = 49
		}
		var body strings.Builder
		body.WriteString(`{"status":"1","pois":[`)
		for i := 0; i < 25; i++ {
			if i > 0 {
				body.WriteByte(',')
			}
			fmt.Fprintf(&body, `{"id":"p%d","name":"地点%d","address":"地址","location":"114.%d,32"}`, start+i, start+i, start+i)
		}
		body.WriteString(`]}`)
		_, _ = w.Write([]byte(body.String()))
	}))
	defer srv.Close()

	client := NewClient(config.AMapConfig{APIKey: "secret", CampusAddress: "江淮校区"}, srv.Client())
	client.Endpoint = srv.URL
	got, err := client.SearchPOI(context.Background(), SearchQuery{Keywords: "华北水利水电大学", Scope: "full"})
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 3 || pages[0] != "1" || pages[1] != "2" || pages[2] != "3" {
		t.Fatalf("expected exactly the bounded pages 1-3, got %v", pages)
	}
	if len(got) != 74 {
		t.Fatalf("expected 74 unique results after cross-page deduplication, got %d", len(got))
	}
}

func TestSearchPOIStopsAfterShortPage(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Query().Get("page") == "1" {
			var body strings.Builder
			body.WriteString(`{"status":"1","pois":[`)
			for i := 0; i < 25; i++ {
				if i > 0 {
					body.WriteByte(',')
				}
				fmt.Fprintf(&body, `{"id":"p%d","name":"地点%d","address":"地址","location":"114.%d,32"}`, i, i, i)
			}
			body.WriteString(`]}`)
			_, _ = w.Write([]byte(body.String()))
			return
		}
		_, _ = w.Write([]byte(`{"status":"1","pois":[{"id":"last","name":"最后一条","address":"地址","location":"114,32"}]}`))
	}))
	defer srv.Close()

	client := NewClient(config.AMapConfig{APIKey: "secret"}, srv.Client())
	client.Endpoint = srv.URL
	got, err := client.SearchPOI(context.Background(), SearchQuery{Keywords: "学校", Scope: "full"})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(got) != 26 {
		t.Fatalf("expected to stop after short second page with 26 rows, calls=%d rows=%d", calls, len(got))
	}
}

func TestSearchPOIValidationAndProviderErrors(t *testing.T) {
	for _, tc := range []struct {
		name     string
		cfg      config.AMapConfig
		keywords string
		body     string
		want     string
	}{
		{"empty key", config.AMapConfig{CampusAddress: "校区"}, "楼", "", "api key"},
		{"empty campus", config.AMapConfig{APIKey: "k"}, "楼", "", "campus"},
		{"empty keywords", config.AMapConfig{APIKey: "k", CampusAddress: "校区"}, " ", "", "keywords"},
		{"provider error", config.AMapConfig{APIKey: "k", CampusAddress: "校区"}, "楼", `{"status":"0","info":"INVALID_USER_KEY"}`, "provider"},
		{"bad json", config.AMapConfig{APIKey: "k", CampusAddress: "校区"}, "楼", `{`, "JSON"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var client *Client
			if tc.body != "" {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(tc.body)) }))
				defer srv.Close()
				client = NewClient(tc.cfg, srv.Client())
				client.Endpoint = srv.URL
			} else {
				client = NewClient(tc.cfg, http.DefaultClient)
			}
			_, err := client.SearchPOI(context.Background(), SearchQuery{Keywords: tc.keywords})
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tc.want)) {
				t.Fatalf("error=%v, want %q", err, tc.want)
			}
		})
	}
}

func TestParsePOIDeduplicatesAndRejectsCoordinates(t *testing.T) {
	body := []byte(`{"status":"1","pois":[{"id":"p1","name":"乙","address":"址","location":"114,32"},{"id":"p1","name":"甲","address":"址","location":"114,32"},{"name":"无ID","address":"址","location":"114,32"},{"name":"无ID","address":"址","location":"114,32"},{"name":"坏","address":"址","location":"181,32"},{"name":"格式1","address":"址","location":"invalid"},{"name":"格式2","address":"址","location":"114"},{"name":"格式3","address":"址","location":"114,32,1"},{"name":"格式4","address":"址","location":"114,not-a-number"}]}`)
	got, err := parsePOIResponse(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "乙" || got[1].Name != "无ID" {
		t.Fatalf("unexpected result: %#v", got)
	}
}

func TestParsePOIResponseUsesFallbackProviderError(t *testing.T) {
	_, err := parsePOIResponse([]byte(`{"status":"0"}`))
	if err == nil || !strings.Contains(err.Error(), "unknown provider error") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSearchPOIRespectsCanceledContext(t *testing.T) {
	client := NewClient(config.AMapConfig{APIKey: "secret", CampusAddress: "校区"}, &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})})
	client.Endpoint = "https://example.invalid"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := client.SearchPOI(ctx, SearchQuery{Keywords: "教学楼"})
	if err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("unexpected error: %v", err)
	}

}

func TestSearchQueryScopeAndProviderOrder(t *testing.T) {
	for _, tc := range []struct {
		query SearchQuery
		want  string
	}{
		{SearchQuery{Keywords: " 图书馆 ", Scope: "campus"}, "合成大学北校区 图书馆"},
		{SearchQuery{Keywords: "合成大学北校区一号楼"}, "合成大学北校区一号楼"},
		{SearchQuery{Keywords: "另一所合成大学二号楼", Scope: "full"}, "另一所合成大学二号楼"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Query().Get("keywords") != tc.want || r.URL.Query().Has("city") {
					t.Error("查询组合不符合显式检索范围")
				}

				_, _ = w.Write([]byte(`{"status":"1","pois":[{"id":"z","name":"Z楼","address":"合成地址","location":"114,32"},{"id":"a","name":"A楼","address":"合成地址","location":"114.1,32.1"},{"id":"bad","name":"坏坐标","address":"合成地址","location":"NaN,32"}]}`))
			}))
			defer srv.Close()
			c := NewClient(config.AMapConfig{APIKey: "synthetic", CampusAddress: "合成大学北校区"}, srv.Client())
			c.Endpoint = srv.URL
			rows, err := c.SearchPOI(context.Background(), tc.query)
			if err != nil || calls != 1 || len(rows) != 2 || rows[0].POIID != "z" || rows[1].POIID != "a" {
				t.Fatalf("一次有界请求、有效坐标过滤及上游相关顺序应保持: %v", err)
			}
		})
	}
}

func TestQueryKeywordsDetailedAddressDoesNotChangeExplicitFullName(t *testing.T) {
	c := NewClient(config.AMapConfig{APIKey: "synthetic", CampusAddress: "合成市合成路123号"}, nil)
	for _, tc := range []struct {
		query SearchQuery
		want  string
	}{
		{SearchQuery{Keywords: "教学楼"}, "合成市合成路123号 教学楼"},
		{SearchQuery{Keywords: " 合成大学东校区第一教学楼 ", Scope: "full"}, "合成大学东校区第一教学楼"},
		{SearchQuery{Keywords: "合成市合成路123号 教学楼", Scope: "campus"}, "合成市合成路123号 教学楼"},
	} {
		got, err := c.QueryKeywords(tc.query)
		if err != nil || got != tc.want {
			t.Fatalf("实际检索词必须透明且不擅改地址/完整楼名: %v", err)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}
