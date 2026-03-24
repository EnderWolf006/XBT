package xxt

import (
	"bytes"
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"math"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (c *Client) fetchCaptchaValidate(fixed FixedParams) (string, error) {
	jar, _ := cookiejar.New(nil)
	captchaHTTP := *c.http
	captchaHTTP.Jar = jar

	captchaKey, token := generateCaptchaKeyAndToken(captchaID, captchaType)
	referer := fmt.Sprintf(
		"https://mobilelearn.chaoxing.com/page/sign/signIn?courseId=%d&classId=%d&activeId=%d&fid=0&timetable=0",
		fixed.CourseID, fixed.ClassID, fixed.ActiveID,
	)

	imageURL := "https://captcha.chaoxing.com/captcha/get/verification/image"
	q := url.Values{}
	q.Set("callback", "cx_captcha_function")
	q.Set("captchaId", captchaID)
	q.Set("type", captchaType)
	q.Set("version", "1.1.20")
	q.Set("captchaKey", captchaKey)
	q.Set("token", token)
	q.Set("referer", referer)

	req, _ := http.NewRequest(http.MethodGet, imageURL+"?"+q.Encode(), nil)
	setCaptchaHeaders(req, referer)
	resp, err := captchaHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	obj, err := extractJSONPObject(body)
	if err != nil {
		return "", err
	}
	var payload struct {
		Token               string `json:"token"`
		ImageVerificationVo struct {
			ShadeImage  string `json:"shadeImage"`
			CutoutImage string `json:"cutoutImage"`
		} `json:"imageVerificationVo"`
	}
	if err := json.Unmarshal(obj, &payload); err != nil {
		return "", err
	}
	if payload.Token == "" || payload.ImageVerificationVo.ShadeImage == "" || payload.ImageVerificationVo.CutoutImage == "" {
		return "", errors.New("captcha payload incomplete")
	}

	bgBytes, err := c.downloadBytes(&captchaHTTP, payload.ImageVerificationVo.ShadeImage, referer)
	if err != nil {
		return "", err
	}
	targetBytes, err := c.downloadBytes(&captchaHTTP, payload.ImageVerificationVo.CutoutImage, referer)
	if err != nil {
		return "", err
	}
	candidates, err := detectSlideXCandidates(targetBytes, bgBytes)
	if err != nil {
		return "", err
	}

	var lastErr error
	for _, x := range candidates {
		validate, err := c.verifyCaptchaAtX(&captchaHTTP, referer, payload.Token, x)
		if err == nil && strings.TrimSpace(validate) != "" {
			return validate, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("captcha verify failed")
	}
	return "", lastErr
}

func (c *Client) verifyCaptchaAtX(cli *http.Client, referer, token string, x int) (string, error) {
	checkURL := "https://captcha.chaoxing.com/captcha/check/verification/result"
	q2 := url.Values{}
	q2.Set("callback", "cx_captcha_function")
	q2.Set("captchaId", captchaID)
	q2.Set("type", captchaType)
	q2.Set("token", token)
	q2.Set("textClickArr", fmt.Sprintf("[{\"x\":%d}]", x))
	q2.Set("coordinate", "[]")
	q2.Set("runEnv", "10")
	q2.Set("version", "1.1.20")
	req2, _ := http.NewRequest(http.MethodGet, checkURL+"?"+q2.Encode(), nil)
	setCaptchaHeaders(req2, referer)
	resp2, err := cli.Do(req2)
	if err != nil {
		return "", err
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	obj2, err := extractJSONPObject(body2)
	if err != nil {
		return "", err
	}
	var verify struct {
		Result    bool   `json:"result"`
		ExtraData string `json:"extraData"`
	}
	if err := json.Unmarshal(obj2, &verify); err != nil {
		return "", err
	}
	if !verify.Result {
		return "", errors.New("captcha verify failed")
	}
	var extra struct {
		Validate string `json:"validate"`
	}
	if err := json.Unmarshal([]byte(verify.ExtraData), &extra); err != nil {
		return "", err
	}
	if extra.Validate == "" {
		return "", errors.New("validate empty")
	}
	return extra.Validate, nil
}

func (c *Client) downloadBytes(cli *http.Client, rawURL string, referer string) ([]byte, error) {
	req, _ := http.NewRequest(http.MethodGet, rawURL, nil)
	setCaptchaHeaders(req, referer)
	resp, err := cli.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func setCaptchaHeaders(req *http.Request, referer string) {
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36")
	req.Header.Set("Referer", referer)
	req.Header.Set("Accept", "*/*")
}

func extractJSONPObject(body []byte) ([]byte, error) {
	s := string(body)
	start := strings.IndexByte(s, '{')
	end := strings.LastIndexByte(s, '}')
	if start < 0 || end < 0 || end <= start {
		return nil, errors.New("invalid jsonp")
	}
	return []byte(s[start : end+1]), nil
}

func generateCaptchaKeyAndToken(captchaIDVal, captchaTypeVal string) (string, string) {
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	randomStr := randomString(32) + ts
	captchaKey := md5Hex(randomStr)
	token := md5Hex(ts + captchaIDVal + captchaTypeVal + captchaKey)
	tsNum, _ := strconv.ParseInt(ts, 10, 64)
	token = token + ":" + strconv.FormatInt(tsNum+0x493e0, 10)
	return captchaKey, token
}

func randomString(n int) string {
	const chars = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
	if n <= 0 {
		return ""
	}
	buf := make([]byte, n)
	raw := make([]byte, n)
	_, _ = rand.Read(raw)
	for i := 0; i < n; i++ {
		buf[i] = chars[int(raw[i])%len(chars)]
	}
	return string(buf)
}

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func detectSlideXCandidates(targetBytes, bgBytes []byte) ([]int, error) {
	targetImg, _, err := image.Decode(bytes.NewReader(targetBytes))
	if err != nil {
		return nil, err
	}
	bgImg, _, err := image.Decode(bytes.NewReader(bgBytes))
	if err != nil {
		return nil, err
	}
	tb := targetImg.Bounds()
	bb := bgImg.Bounds()
	tw, th := tb.Dx(), tb.Dy()
	bw, bh := bb.Dx(), bb.Dy()
	if tw <= 0 || th <= 0 || bw <= 0 || bh <= 0 {
		return nil, errors.New("invalid image size")
	}

	limitY := minInt(th, bh)
	type pt struct{ x, y int }
	mask := make([]pt, 0, tw*limitY/2)
	for y := 0; y < limitY; y += 2 {
		for x := 0; x < tw; x += 2 {
			_, _, _, a := targetImg.At(tb.Min.X+x, tb.Min.Y+y).RGBA()
			if a>>8 < 32 {
				continue
			}
			mask = append(mask, pt{x: x, y: y})
		}
	}
	if len(mask) < 80 {
		return nil, errors.New("captcha mask too small")
	}

	maxX := bw - tw
	if maxX <= 1 {
		return nil, errors.New("captcha width mismatch")
	}

	type match struct {
		x     int
		score float64
	}
	matches := make([]match, 0, maxX+1)
	edge := make([]float64, maxX+1)
	for offX := 0; offX <= maxX; offX++ {
		score := 0.0
		for _, p := range mask {
			tg := gray(targetImg.At(tb.Min.X+p.x, tb.Min.Y+p.y))
			bg := gray(bgImg.At(bb.Min.X+offX+p.x, bb.Min.Y+p.y))
			score += math.Abs(tg - bg)
		}
		score /= float64(len(mask))
		matches = append(matches, match{x: offX, score: score})

		es := 0.0
		for y := 0; y < limitY; y += 2 {
			l := gray(bgImg.At(bb.Min.X+offX, bb.Min.Y+y))
			r := gray(bgImg.At(bb.Min.X+offX+tw-1, bb.Min.Y+y))
			es += math.Abs(r - l)
		}
		edge[offX] = es
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].score < matches[j].score })

	tgtColEdge := make([]float64, tw)
	for x := 1; x < tw-1; x++ {
		s := 0.0
		for y := 0; y < limitY; y += 2 {
			l := gray(targetImg.At(tb.Min.X+x-1, tb.Min.Y+y))
			r := gray(targetImg.At(tb.Min.X+x+1, tb.Min.Y+y))
			s += math.Abs(r - l)
		}
		tgtColEdge[x] = s
	}
	bgColEdge := make([]float64, bw)
	for x := 1; x < bw-1; x++ {
		s := 0.0
		for y := 0; y < limitY; y += 2 {
			l := gray(bgImg.At(bb.Min.X+x-1, bb.Min.Y+y))
			r := gray(bgImg.At(bb.Min.X+x+1, bb.Min.Y+y))
			s += math.Abs(r - l)
		}
		bgColEdge[x] = s
	}
	profileMatches := make([]match, 0, maxX+1)
	for offX := 0; offX <= maxX; offX++ {
		s := 0.0
		n := 0
		for x := 1; x < tw-1; x++ {
			bx := offX + x
			if bx <= 0 || bx >= bw-1 {
				continue
			}
			s += math.Abs(tgtColEdge[x] - bgColEdge[bx])
			n++
		}
		if n == 0 {
			continue
		}
		profileMatches = append(profileMatches, match{x: offX, score: s / float64(n)})
	}
	sort.Slice(profileMatches, func(i, j int) bool { return profileMatches[i].score < profileMatches[j].score })

	edgeIdx := make([]int, 0, len(edge))
	for i := range edge {
		edgeIdx = append(edgeIdx, i)
	}
	sort.Slice(edgeIdx, func(i, j int) bool { return edge[edgeIdx[i]] > edge[edgeIdx[j]] })

	limit := minInt(12, len(matches))
	edgeLimit := minInt(8, len(edgeIdx))
	cands := make([]int, 0, 64)
	seen := make(map[int]struct{}, 64)
	add := func(v int) {
		if v < 0 || v > maxX {
			return
		}
		if _, ok := seen[v]; ok {
			return
		}
		seen[v] = struct{}{}
		cands = append(cands, v)
	}
	for i := 0; i < limit; i++ {
		base := matches[i].x
		for _, d := range []int{0, -1, 1, -2, 2, -3, 3, -5, 5, -8, 8} {
			add(base + d)
		}
	}
	profileLimit := minInt(8, len(profileMatches))
	for i := 0; i < profileLimit; i++ {
		base := profileMatches[i].x
		for _, d := range []int{0, -1, 1, -2, 2, -4, 4, -6, 6} {
			add(base + d)
		}
	}
	for i := 0; i < edgeLimit; i++ {
		base := edgeIdx[i]
		for _, d := range []int{0, -2, 2, -4, 4} {
			add(base + d)
		}
	}
	if len(cands) == 0 {
		return nil, errors.New("failed to locate slider x")
	}
	if len(cands) > 40 {
		cands = cands[:40]
	}
	return cands, nil
}

func gray(c color.Color) float64 {
	r, g, b, _ := c.RGBA()
	rf := float64(r >> 8)
	gf := float64(g >> 8)
	bf := float64(b >> 8)
	return 0.299*rf + 0.587*gf + 0.114*bf
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
