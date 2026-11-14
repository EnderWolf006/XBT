package service

import (
	"context"
	"testing"

	"xbt2/server/internal/amap"
	"xbt2/server/internal/model"
)

type mapSearchStub struct {
	query amap.SearchQuery
	pois  []amap.POI
}

func (s *mapSearchStub) SearchPOI(_ context.Context, query amap.SearchQuery) ([]amap.POI, error) {
	s.query = query
	return s.pois, nil
}
func (s *mapSearchStub) QueryKeywords(query amap.SearchQuery) (string, error) {
	return query.Keywords, nil
}

func TestSearchMapCandidatesForcesFullScopeAndSortsNamesStably(t *testing.T) {
	stub := &mapSearchStub{pois: []amap.POI{
		{POIID: "other", Name: "华北水利水电大学江淮校区", Address: "校区", Longitude: 114, Latitude: 32},
		{POIID: "exact", Name: "华北水利水电大学", Address: "学校", Longitude: 114, Latitude: 32},
		{POIID: "also", Name: "华北水利水电大学龙子湖校区", Address: "校区", Longitude: 114, Latitude: 32},
		{POIID: "unmatched", Name: "水利学院", Address: "校区", Longitude: 114, Latitude: 32},
	}}
	svc := NewSignLocationService(nil, stub)
	rows, err := svc.SearchMapCandidates(context.Background(), amap.SearchQuery{
		Keywords: "华北水利水电大学", Scope: "campus",
	})
	if err != nil {
		t.Fatal(err)
	}
	if stub.query.Scope != "full" {
		t.Fatalf("map search must force full scope, got %q", stub.query.Scope)
	}
	want := []string{"华北水利水电大学", "华北水利水电大学江淮校区", "华北水利水电大学龙子湖校区", "水利学院"}
	for i, name := range want {
		if rows[i].Name != name {
			t.Fatalf("candidate %d: got %q, want %q", i, rows[i].Name, name)
		}
	}
}

func TestValidateSignLocationRejectsInvalidCoordinates(t *testing.T) {
	err := validateSignLocation(CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 91, Longitude: 114})
	if err == nil {
		t.Fatal("expected invalid latitude error")
	}
}

func TestValidateSignLocationRejectsInvalidStatus(t *testing.T) {
	err := validateSignLocation(CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 32, Longitude: 114, Status: "bad"})
	if err == nil {
		t.Fatal("expected invalid status error")
	}
}

func TestValidateSignLocationAcceptsValidInput(t *testing.T) {
	err := validateSignLocation(CreateSignLocationInput{Name: "楼", Address: "址", Latitude: 32, Longitude: 114, Status: model.SignLocationPending})
	if err != nil {
		t.Fatalf("expected valid input, got %v", err)
	}
}
