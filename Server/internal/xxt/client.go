package xxt

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	SignNormal   = 0
	SignQRCode   = 2
	SignGesture  = 3
	SignLocation = 4
	SignCode     = 5
	captchaID    = "42sxgHoTPTKbt0uZxPJ7ssOvtXr3ZgZ1"
	captchaType  = "slide"
)

type Client struct {
	aesKey         string
	mobileUA       string
	activeFetchMax int
	http           *http.Client
	sessionMu      sync.Mutex
	sessions       map[string]*Session
}

type Session struct {
	Mobile      string
	Password    string
	UID         int64
	Name        string
	Avatar      string
	Jar         *cookiejar.Jar
	LastLoginAt time.Time
}

type LoginResult struct {
	UID    int64
	Name   string
	Avatar string
}

type Course struct {
	Teacher  string
	Name     string
	CourseID int64
	ClassID  int64
	Icon     string
}

type Active struct {
	ActiveID int64
	Name     string
}

type SignDetail struct {
	StartTime    int64
	EndTime      int64
	SignType     int
	IfRefreshEWM bool
}

type FixedParams struct {
	ActiveID     int64
	UID          int64
	CourseID     int64
	ClassID      int64
	IfRefreshEWM bool
}

func New(aesKey, mobileUA string, insecureTLS bool, activeFetchMax int) *Client {
	tr := &http.Transport{}
	if insecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	if activeFetchMax <= 0 {
		activeFetchMax = 20
	}
	return &Client{
		aesKey:         aesKey,
		mobileUA:       mobileUA,
		activeFetchMax: activeFetchMax,
		http: &http.Client{
			Timeout:   20 * time.Second,
			Transport: tr,
		},
		sessions: make(map[string]*Session),
	}
}

func (c *Client) PreLogin(mobile, password string) (*LoginResult, error) {
	jar, _ := cookiejar.New(nil)
	cli := *c.http
	cli.Jar = jar

	form := url.Values{}
	form.Set("fid", "-1")
	form.Set("uname", encryptXXTByAES(mobile, c.aesKey))
	form.Set("password", encryptXXTByAES(password, c.aesKey))
	form.Set("refer", "https://i.chaoxing.com")
	form.Set("t", "true")
	form.Set("forbidotherlogin", "0")
	form.Set("validate", "")
	form.Set("doubleFactorLogin", "0")
	form.Set("independentId", "0")
	form.Set("independentNameId", "0")

	req, _ := http.NewRequest(http.MethodPost, "https://passport2.chaoxing.com/fanyalogin?"+form.Encode(), nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var lr struct {
		Status bool `json:"status"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&lr); err != nil {
		return nil, fmt.Errorf("login decode failed: %w", err)
	}
	if !lr.Status {
		return nil, fmt.Errorf("账号或密码错误")
	}

	req2, _ := http.NewRequest(http.MethodGet, "http://i.chaoxing.com/base", nil)
	req2.Header.Set("User-Agent", "Mozilla/5.0")
	resp2, err := cli.Do(req2)
	if err != nil {
		return nil, err
	}
	defer resp2.Body.Close()
	html, _ := io.ReadAll(resp2.Body)
	s := string(html)

	name := extractBetween(s, `<p class="user-name">`, `</p>`)
	avatar := extractBetween(s, `<img class="icon-head" src="`, `">`)
	uid := int64(0)
	for _, ck := range jar.Cookies(&url.URL{Scheme: "https", Host: "passport2.chaoxing.com"}) {
		if ck.Name == "UID" {
			uid, _ = strconv.ParseInt(ck.Value, 10, 64)
			break
		}
	}
	if uid == 0 {
		for _, ck := range jar.Cookies(&url.URL{Scheme: "https", Host: "i.chaoxing.com"}) {
			if ck.Name == "UID" {
				uid, _ = strconv.ParseInt(ck.Value, 10, 64)
				break
			}
		}
	}
	if uid == 0 {
		return nil, fmt.Errorf("登录后未获取到UID")
	}

	c.sessionMu.Lock()
	c.sessions[mobile] = &Session{
		Mobile:      mobile,
		Password:    password,
		UID:         uid,
		Name:        name,
		Avatar:      avatar,
		Jar:         jar,
		LastLoginAt: time.Now(),
	}
	c.sessionMu.Unlock()

	return &LoginResult{UID: uid, Name: name, Avatar: avatar}, nil
}

func (c *Client) ensureSession(mobile, password string) (*Session, error) {
	c.sessionMu.Lock()
	s, ok := c.sessions[mobile]
	c.sessionMu.Unlock()
	if ok && s.Password == password && time.Since(s.LastLoginAt) < 24*time.Hour {
		return s, nil
	}
	_, err := c.PreLogin(mobile, password)
	if err != nil {
		return nil, err
	}
	c.sessionMu.Lock()
	defer c.sessionMu.Unlock()
	return c.sessions[mobile], nil
}

func (c *Client) GetCourses(mobile, password string) ([]Course, error) {
	s, err := c.ensureSession(mobile, password)
	if err != nil {
		return nil, err
	}
	cli := *c.http
	cli.Jar = s.Jar

	u := "https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&getTchClazzType=1&mcode="
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var payload struct {
		ChannelList []struct {
			Content map[string]interface{} `json:"content"`
		} `json:"channelList"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}

	seen := map[string]struct{}{}
	courses := make([]Course, 0)
	for _, ch := range payload.ChannelList {
		content := ch.Content
		if content == nil {
			continue
		}
		if _, ok := content["folderName"]; ok {
			continue
		}
		if rt, ok := content["roletype"].(float64); ok && int(rt) == 1 {
			continue
		}
		courseMap, ok := content["course"].(map[string]interface{})
		if !ok {
			continue
		}
		dataArr, ok := courseMap["data"].([]interface{})
		if !ok {
			continue
		}
		for _, item := range dataArr {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			squareURL, _ := m["courseSquareUrl"].(string)
			u2, err := url.Parse(squareURL)
			if err != nil {
				continue
			}
			q := u2.Query()
			courseID, _ := strconv.ParseInt(q.Get("courseId"), 10, 64)
			classID, _ := strconv.ParseInt(q.Get("classId"), 10, 64)
			if courseID == 0 || classID == 0 {
				continue
			}
			key := fmt.Sprintf("%d_%d", courseID, classID)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			courses = append(courses, Course{
				Teacher:  strVal(m["teacherfactor"]),
				Name:     strVal(m["name"]),
				CourseID: courseID,
				ClassID:  classID,
				Icon:     strVal(m["imageurl"]),
			})
		}
	}
	return courses, nil
}

func (c *Client) GetActives(mobile, password string, courseID, classID int64) ([]Active, error) {
	s, err := c.ensureSession(mobile, password)
	if err != nil {
		return nil, err
	}
	cli := *c.http
	cli.Jar = s.Jar

	u := fmt.Sprintf("https://mobilelearn.chaoxing.com/ppt/activeAPI/taskactivelist?courseId=%d&classId=%d", courseID, classID)
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", c.mobileUA)
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var payload interface{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}

	activeList := findActiveList(payload)
	if len(activeList) == 0 {
		activeList = findBestActivityArray(payload)
	}
	if len(activeList) == 0 {
		log.Printf("GetActives empty source: course=%d class=%d body=%s", courseID, classID, truncateForLog(string(raw), 240))
	}
	out := make([]Active, 0)
	seen := make(map[int64]struct{})
	for _, a := range activeList {
		activeType := int64FromAny(firstNonNil(a["activeType"], a["type"], a["atype"]))
		name := strVal(firstNonNil(a["nameOne"], a["name"], a["activeName"], a["title"]))
		id := int64FromAny(firstNonNil(a["id"], a["activeId"], a["active_id"]))
		if id == 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		if activeType != 2 && !strings.Contains(name, "签到") {
			continue
		}
		if name == "" {
			name = fmt.Sprintf("活动 %d", id)
		}
		out = append(out, Active{
			ActiveID: id,
			Name:     name,
		})
		if len(out) >= c.activeFetchMax {
			break
		}
	}
	return out, nil
}

func (c *Client) GetSignDetail(mobile, password string, activityID int64) (SignDetail, error) {
	s, err := c.ensureSession(mobile, password)
	if err != nil {
		return SignDetail{}, err
	}
	cli := *c.http
	cli.Jar = s.Jar
	u := fmt.Sprintf("https://mobilelearn.chaoxing.com/newsign/signDetail?activePrimaryId=%d&type=1", activityID)
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", c.mobileUA)
	resp, err := cli.Do(req)
	if err != nil {
		return SignDetail{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return SignDetail{}, err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return SignDetail{}, err
	}
	end := parseTimeMillis(payload["endTime"])
	if end == 0 {
		end = 64060559999000
	}
	return SignDetail{
		StartTime:    parseTimeMillis(payload["startTime"]),
		EndTime:      end,
		SignType:     int(int64FromAny(payload["otherId"])),
		IfRefreshEWM: boolFromAny(payload["ifRefreshEwm"]),
	}, nil
}

func (c *Client) PreSign(mobile, password string, fixed FixedParams, code, enc string) error {
	s, err := c.ensureSession(mobile, password)
	if err != nil {
		return err
	}
	cli := *c.http
	cli.Jar = s.Jar

	vals := url.Values{}
	vals.Set("courseId", strconv.FormatInt(fixed.CourseID, 10))
	vals.Set("classId", strconv.FormatInt(fixed.ClassID, 10))
	vals.Set("activePrimaryId", strconv.FormatInt(fixed.ActiveID, 10))
	vals.Set("general", "1")
	vals.Set("sys", "1")
	vals.Set("ls", "1")
	vals.Set("appType", "15")
	vals.Set("uid", strconv.FormatInt(fixed.UID, 10))
	vals.Set("isTeacherViewOpen", "0")
	if fixed.IfRefreshEWM {
		rcode := fmt.Sprintf("SIGNIN:aid=%d&source=15&Code=%s&enc=%s", fixed.ActiveID, code, enc)
		vals.Set("rcode", url.QueryEscape(rcode))
	}

	req, _ := http.NewRequest(http.MethodGet, "https://mobilelearn.chaoxing.com/newsign/preSign?"+vals.Encode(), nil)
	req.Header.Set("User-Agent", c.mobileUA)
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	a1 := fmt.Sprintf("https://mobilelearn.chaoxing.com/pptSign/analysis?vs=1&DB_STRATEGY=RANDOM&aid=%d", fixed.ActiveID)
	req2, _ := http.NewRequest(http.MethodGet, a1, nil)
	req2.Header.Set("User-Agent", c.mobileUA)
	resp2, err := cli.Do(req2)
	if err != nil {
		return err
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	m := regexp.MustCompile(`code='\\+'(.*?)'`).FindSubmatch(body2)
	if len(m) < 2 {
		return nil
	}
	code2 := string(m[1])
	a2 := "https://mobilelearn.chaoxing.com/pptSign/analysis2?DB_STRATEGY=RANDOM&code=" + url.QueryEscape(code2)
	req3, _ := http.NewRequest(http.MethodGet, a2, nil)
	req3.Header.Set("User-Agent", c.mobileUA)
	resp3, err := cli.Do(req3)
	if err == nil {
		defer resp3.Body.Close()
		_, _ = io.Copy(io.Discard, resp3.Body)
	}
	return nil
}

func (c *Client) Sign(mobile, password string, fixed FixedParams, signType int, special map[string]interface{}) (string, error) {
	s, err := c.ensureSession(mobile, password)
	if err != nil {
		return "", err
	}
	cli := *c.http
	cli.Jar = s.Jar

	params := url.Values{}
	params.Set("activeId", strconv.FormatInt(fixed.ActiveID, 10))
	params.Set("uid", strconv.FormatInt(fixed.UID, 10))
	params.Set("clientip", "")
	params.Set("appType", "15")
	params.Set("fid", "")
	params.Set("name", s.Name)
	// 先空 validate 发起一次请求；仅在学习通明确要求时再走验证码。
	params.Set("validate", "")

	switch signType {
	case SignQRCode:
		enc := strVal(special["enc"])
		if enc == "" {
			return "", fmt.Errorf("缺少二维码 enc 参数")
		}
		params.Set("enc", enc)
		// 兼容 1.0 的二维码附加位置变种：透传 location 给学习通。
		// 兼容两种输入：
		// 1) special.location（1.0 旧格式）
		// 2) special.latitude/longitude/description（2.0 前端当前格式）
		if locationJSON, ok := buildQRCodeLocationParam(special); ok {
			params.Set("location", locationJSON)
		}
		params.Set("useragent", "")
		params.Set("latitude", "-1")
		params.Set("longitude", "-1")
	case SignGesture, SignCode:
		signCode := strVal(special["sign_code"])
		if signCode == "" {
			return "", fmt.Errorf("缺少 sign_code 参数")
		}
		if signType == SignGesture {
			checkURL := fmt.Sprintf("https://mobilelearn.chaoxing.com/widget/sign/pcStuSignController/checkSignCode?activeId=%d&signCode=%s", fixed.ActiveID, url.QueryEscape(signCode))
			reqC, _ := http.NewRequest(http.MethodGet, checkURL, nil)
			reqC.Header.Set("User-Agent", c.mobileUA)
			respC, err := cli.Do(reqC)
			if err == nil {
				defer respC.Body.Close()
				var check struct {
					Result   int    `json:"result"`
					ErrorMsg string `json:"errorMsg"`
				}
				_ = json.NewDecoder(respC.Body).Decode(&check)
				if check.Result != 1 {
					if check.ErrorMsg == "" {
						check.ErrorMsg = "手势码校验失败"
					}
					return "", fmt.Errorf("%s", check.ErrorMsg)
				}
			}
		}
		params.Set("signCode", signCode)
		params.Set("latitude", "")
		params.Set("longitude", "")
	case SignLocation:
		params.Set("address", strVal(special["description"]))
		params.Set("latitude", strVal(special["latitude"]))
		params.Set("longitude", strVal(special["longitude"]))
		params.Set("ifTiJiao", "1")
	default:
		params.Set("latitude", "-1")
		params.Set("longitude", "-1")
	}

	// 二维码签到在部分场景下会出现 enc 只能使用一次的情况。
	// 若先空 validate 试探再重试，会导致第二次请求被判定“签到校验未通过”。
	// 这里与 1.0 行为对齐：二维码签到首发请求直接携带验证码。
	if signType == SignQRCode {
		validate, err := c.fetchCaptchaValidate(fixed)
		if err != nil {
			log.Printf("captcha fetch failed before qrcode sign: activity=%d uid=%d err=%v", fixed.ActiveID, fixed.UID, err)
		} else {
			params.Set("validate", validate)
		}
		return c.doStuSignRequest(&cli, params)
	}

	result, err := c.doStuSignRequest(&cli, params)
	if err != nil {
		return "", err
	}
	if result != "validate" {
		return result, nil
	}

	// 仅对需要验证码的活动执行一次验证码识别，不在后端重试。
	validate, err := c.fetchCaptchaValidate(fixed)
	if err != nil {
		log.Printf("captcha fetch failed: activity=%d uid=%d err=%v", fixed.ActiveID, fixed.UID, err)
		return "validate", nil
	}
	params.Set("validate", validate)
	return c.doStuSignRequest(&cli, params)
}

func (c *Client) doStuSignRequest(cli *http.Client, params url.Values) (string, error) {
	u := "https://mobilelearn.chaoxing.com/pptSign/stuSignajax?" + params.Encode()
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("User-Agent", c.mobileUA)
	resp, err := cli.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return strings.TrimSpace(string(body)), nil
}

func buildQRCodeLocationParam(special map[string]interface{}) (string, bool) {
	if locRaw, ok := special["location"]; ok && locRaw != nil {
		switch v := locRaw.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return v, true
			}
		default:
			if b, err := json.Marshal(v); err == nil && string(b) != "null" && string(b) != `""` {
				return string(b), true
			}
		}
	}

	latStr := strings.TrimSpace(strVal(special["latitude"]))
	lngStr := strings.TrimSpace(strVal(special["longitude"]))
	desc := strings.TrimSpace(strVal(special["description"]))
	if latStr == "" && lngStr == "" && desc == "" {
		return "", false
	}

	location := map[string]interface{}{
		"result":  1,
		"address": desc,
	}
	if lat, err := strconv.ParseFloat(latStr, 64); err == nil {
		location["latitude"] = lat
	} else if latStr != "" {
		location["latitude"] = latStr
	}
	if lng, err := strconv.ParseFloat(lngStr, 64); err == nil {
		location["longitude"] = lng
	} else if lngStr != "" {
		location["longitude"] = lngStr
	}
	if desc != "" {
		location["mockData"] = map[string]interface{}{
			"description": desc,
		}
	}

	b, err := json.Marshal(location)
	if err != nil || string(b) == "{}" {
		return "", false
	}
	return string(b), true
}
