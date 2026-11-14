package amap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"xbt2/server/internal/config"
)

const defaultEndpoint = "https://restapi.amap.com/v3/place/text"
const searchPageSize = 25
const maxSearchPages = 3

type POI struct {
	Name      string  `json:"name"`
	Address   string  `json:"address"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	POIID     string  `json:"poi_id"`
}
type SearchQuery struct {
	Keywords string `json:"keywords"`
	Scope    string `json:"scope"`
}
type Client struct {
	Config   config.AMapConfig
	HTTP     *http.Client
	Endpoint string
}

func NewClient(cfg config.AMapConfig, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{Config: cfg, HTTP: httpClient, Endpoint: defaultEndpoint}
}
func (c *Client) QueryKeywords(query SearchQuery) (string, error) {
	campus := strings.TrimSpace(c.Config.CampusAddress)
	if query.Scope != "full" && campus == "" {
		return "", errors.New("amap campus address is required")
	}
	keywords := strings.TrimSpace(query.Keywords)
	if keywords == "" {
		return "", errors.New("keywords are required")
	}
	if query.Scope != "" && query.Scope != "campus" && query.Scope != "full" {
		return "", errors.New("invalid search scope")
	}
	if query.Scope != "full" && !strings.Contains(keywords, campus) {
		keywords = campus + " " + keywords
	}
	return keywords, nil
}

func (c *Client) SearchPOI(ctx context.Context, query SearchQuery) ([]POI, error) {
	if strings.TrimSpace(c.Config.APIKey) == "" {
		return nil, errors.New("amap api key is required")
	}
	keywords, err := c.QueryKeywords(query)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	seen := make(map[string]struct{})
	results := make([]POI, 0, searchPageSize)
	for page := 1; page <= maxSearchPages; page++ {
		rows, rawCount, err := c.searchPage(ctx, hc, keywords, page)
		if err != nil {
			return nil, err
		}
		for _, poi := range rows {
			key := poi.POIID
			if key == "" {
				key = strings.Join([]string{strings.TrimSpace(poi.Name), strings.TrimSpace(poi.Address),
					strconv.FormatFloat(poi.Longitude, 'f', -1, 64), strconv.FormatFloat(poi.Latitude, 'f', -1, 64)}, "\x00")
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			results = append(results, poi)
		}
		if rawCount < searchPageSize {
			break
		}
	}
	return results, nil
}

func (c *Client) searchPage(ctx context.Context, client *http.Client, keywords string, page int) ([]POI, int, error) {
	q := url.Values{}
	q.Set("key", c.Config.APIKey)
	q.Set("keywords", keywords)
	q.Set("offset", strconv.Itoa(searchPageSize))
	q.Set("page", strconv.Itoa(page))
	q.Set("extensions", "base")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Endpoint+"?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, fmt.Errorf("create amap request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, 0, errors.New("amap request timed out")
		}
		if errors.Is(err, context.Canceled) {
			return nil, 0, errors.New("amap request canceled")
		}
		return nil, 0, errors.New("amap request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, 0, fmt.Errorf("amap http error: status %d", resp.StatusCode)
	}
	var body amapResponse
	if err = json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, 0, fmt.Errorf("decode amap JSON: %w", err)
	}
	if body.Status != "1" {
		info := strings.TrimSpace(body.Info)
		if info == "" {
			info = "unknown provider error"
		}
		return nil, 0, fmt.Errorf("amap provider error: %s", info)
	}
	rows, err := normalizePOIs(body.POIs)
	return rows, len(body.POIs), err
}

type amapResponse struct {
	Status string   `json:"status"`
	Info   string   `json:"info"`
	POIs   []rawPOI `json:"pois"`
}
type rawPOI struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Address  string `json:"address"`
	Location string `json:"location"`
}

func parsePOIResponse(body []byte) ([]POI, error) {
	var r amapResponse
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("decode amap JSON: %w", err)
	}
	if r.Status != "1" {
		info := strings.TrimSpace(r.Info)
		if info == "" {
			info = "unknown provider error"
		}
		return nil, fmt.Errorf("amap provider error: %s", info)
	}
	return normalizePOIs(r.POIs)
}
func normalizePOIs(raw []rawPOI) ([]POI, error) {
	seen := map[string]struct{}{}
	out := make([]POI, 0, len(raw))
	for _, x := range raw {
		p := strings.Split(strings.TrimSpace(x.Location), ",")
		if len(p) != 2 {
			continue
		}
		lon, e1 := strconv.ParseFloat(strings.TrimSpace(p[0]), 64)
		lat, e2 := strconv.ParseFloat(strings.TrimSpace(p[1]), 64)
		if e1 != nil || e2 != nil || math.IsNaN(lon) || math.IsNaN(lat) || math.IsInf(lon, 0) || math.IsInf(lat, 0) || lon < -180 || lon > 180 || lat < -90 || lat > 90 {
			continue
		}
		v := POI{Name: x.Name, Address: x.Address, Longitude: lon, Latitude: lat, POIID: x.ID}
		k := x.ID
		if strings.TrimSpace(k) == "" {
			k = strings.Join([]string{strings.TrimSpace(x.Name), strings.TrimSpace(x.Address), strconv.FormatFloat(lon, 'f', -1, 64), strconv.FormatFloat(lat, 'f', -1, 64)}, "\x00")
		}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, v)
	}
	return out, nil
}
