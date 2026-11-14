package media

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type testTransport func(*http.Request) (*http.Response, error)

func (f testTransport) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func imageBytes(t *testing.T, size int) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	if len(data) < size {
		data = append(data, make([]byte, size-len(data))...)
	}
	return data
}

func testCache(t *testing.T, fetch testTransport) *Cache {
	t.Helper()
	cache, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cache.http = &http.Client{Transport: fetch}
	return cache
}

func reply(data []byte) *http.Response {
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(data)), ContentLength: int64(len(data))}
}

func TestSourceAndNetworkRestrictions(t *testing.T) {
	for _, source := range []string{
		"https://photo.chaoxing.com/p/one?temp=1", "http://p.ananas.chaoxing.com/cover.jpg",
	} {
		if normalized, err := NormalizeSource(source); err != nil || normalized[:8] != "https://" {
			t.Fatalf("valid source rejected: %q, %v", normalized, err)
		}
	}
	for _, source := range []string{
		"http://127.0.0.1/a", "file:///etc/passwd", "https://photo.chaoxing.com.evil.example/a",
		"https://photo.chaoxing.com:443/a", "https://user:pass@photo.chaoxing.com/a",
		"https://169.254.169.254/a", "//photo.chaoxing.com/a", "https://example.com/a",
		"https://p.cldisk.com/direct.png",
	} {
		if _, err := NormalizeSource(source); !errors.Is(err, ErrSource) {
			t.Fatalf("unsafe source accepted: %s", source)
		}
	}
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "::1", "fe80::1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "::ffff:192.168.1.1", "2001:db8::1"} {
		if publicIP(net.ParseIP(address)) {
			t.Fatalf("non-public IP accepted: %s", address)
		}
	}
	if !publicIP(net.ParseIP("114.114.114.114")) {
		t.Fatal("public IP rejected")
	}
	client := newHTTPClient()
	for _, target := range []string{"https://127.0.0.1/a", "http://photo.chaoxing.com/a", "https://p.cldisk.com.evil.example/a"} {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := client.CheckRedirect(req, []*http.Request{req}); err == nil {
			t.Fatal("unsafe redirect accepted")
		}
	}
	redirect, err := http.NewRequest(http.MethodGet, "https://p.cldisk.com/star3/image.png", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(redirect, []*http.Request{redirect}); err != nil || redirect.Header.Get("Referer") != imageReferer {
		t.Fatal("verified avatar CDN redirect did not retain the platform referrer")
	}
	if err := client.CheckRedirect(redirect, make([]*http.Request, 4)); err == nil {
		t.Fatal("excessive redirects accepted")
	}
}

func TestCacheHitIsolationAndRestart(t *testing.T) {
	data := imageBytes(t, 1024)
	var calls atomic.Int32
	transport := testTransport(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		if req.Header.Get("Authorization") != "" || req.Header.Get("Cookie") != "" || req.URL.Scheme != "https" {
			t.Fatal("credentials forwarded or insecure image request")
		}
		if req.Header.Get("Referer") != imageReferer {
			t.Fatal("platform image referrer was not supplied")
		}
		return reply(data), nil
	})
	cache := testCache(t, transport)
	const source = "https://photo.chaoxing.com/p/one?temp=1"
	for _, step := range []struct {
		uid int64
		hit bool
	}{{1, false}, {1, true}, {2, false}} {
		image, hit, err := cache.Open(context.Background(), step.uid, source)
		if err != nil || hit != step.hit {
			t.Fatalf("hit=%v err=%v want hit=%v", hit, err, step.hit)
		}
		body, err := io.ReadAll(image)
		if err != nil || !bytes.Equal(body, data) || image.ContentType != "image/png" {
			t.Fatal("cached image changed")
		}
		if err := image.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 2 {
		t.Fatal("image cache did not isolate accounts or reuse hits")
	}
	restarted, err := New(cache.dir)
	if err != nil {
		t.Fatal(err)
	}
	image, hit, err := restarted.Open(context.Background(), 1, source)
	if err != nil || !hit {
		t.Fatalf("disk cache not reused after restart: hit=%v err=%v", hit, err)
	}
	image.Close()
}

func TestDiskBudgetEvictionAndExpiry(t *testing.T) {
	data := imageBytes(t, 1024)
	var calls atomic.Int32
	cache := testCache(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return reply(data), nil
	})
	cache.fileBytes, cache.maxBytes = 1024, 2048
	open := func(name string) bool {
		t.Helper()
		image, hit, err := cache.Open(context.Background(), 1, "https://photo.chaoxing.com/"+name)
		if err != nil {
			t.Fatal(err)
		}
		image.Close()
		return hit
	}
	open("a")
	open("b")
	if !open("a") {
		t.Fatal("missing cached a")
	}
	open("c")
	if !open("a") || open("b") {
		t.Fatal("LRU did not retain the recently used entry")
	}
	cache.mu.Lock()
	total := cache.bytes
	for _, element := range cache.entries {
		element.Value.(*entry).modified = time.Now().Add(-cache.ttl - time.Second)
	}
	cache.mu.Unlock()
	if total > cache.maxBytes {
		t.Fatalf("cache exceeds budget: %d > %d", total, cache.maxBytes)
	}
	before := calls.Load()
	if open("b") || calls.Load() != before+1 {
		t.Fatal("expired image did not refresh")
	}
	files, err := os.ReadDir(cache.dir)
	if err != nil {
		t.Fatal(err)
	}
	var actualBytes int64
	for _, file := range files {
		info, err := file.Info()
		if err != nil {
			t.Fatal(err)
		}
		actualBytes += info.Size()
	}
	if actualBytes > cache.maxBytes {
		t.Fatalf("on-disk bytes exceed budget: %d", actualBytes)
	}
}

func TestConcurrentFillsAndDeduplication(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(fmt.Sprint(same), func(t *testing.T) {
			data := imageBytes(t, 1024)
			gate := make(chan struct{})
			var active, maximum, calls atomic.Int32
			cache := testCache(t, func(req *http.Request) (*http.Response, error) {
				calls.Add(1)
				current := active.Add(1)
				for old := maximum.Load(); current > old && !maximum.CompareAndSwap(old, current); old = maximum.Load() {
				}
				defer active.Add(-1)
				select {
				case <-gate:
					return reply(data), nil
				case <-req.Context().Done():
					return nil, req.Context().Err()
				}
			})
			var wg sync.WaitGroup
			errs := make(chan error, 10)
			for i := 0; i < 10; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					if same {
						i = 0
					}
					image, _, err := cache.Open(context.Background(), 1, fmt.Sprintf("https://photo.chaoxing.com/%d", i))
					if err == nil {
						err = image.Close()
					}
					errs <- err
				}(i)
			}
			target := int32(2)
			if same {
				target = 1
			}
			deadline := time.Now().Add(3 * time.Second)
			for active.Load() < target && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			close(gate)
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatal(err)
				}
			}
			if maximum.Load() > 2 || (same && calls.Load() != 1) || (!same && calls.Load() != 10) {
				t.Fatalf("unbounded/duplicate fills: max=%d calls=%d", maximum.Load(), calls.Load())
			}
		})
	}
}

func TestConcurrentFillsReserveIndexCapacity(t *testing.T) {
	data := imageBytes(t, 128)
	cache := testCache(t, func(*http.Request) (*http.Response, error) {
		return reply(data), nil
	})
	for i := 0; i < maxEntries-1; i++ {
		image, _, err := cache.Open(context.Background(), 1, fmt.Sprintf("https://photo.chaoxing.com/seed-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		image.Close()
	}
	started, gate := make(chan struct{}, 2), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	defer release()
	cache.http.Transport = testTransport(func(req *http.Request) (*http.Response, error) {
		started <- struct{}{}
		select {
		case <-gate:
			return reply(data), nil
		case <-req.Context().Done():
			return nil, req.Context().Err()
		}
	})
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			image, _, err := cache.Open(context.Background(), 1, fmt.Sprintf("https://photo.chaoxing.com/parallel-%d", i))
			if err == nil {
				err = image.Close()
			}
			errs <- err
		}(i)
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("parallel image fills did not start")
		}
	}
	cache.mu.Lock()
	total := len(cache.entries) + int(cache.reserved/cache.fileBytes)
	cache.mu.Unlock()
	if total > maxEntries {
		t.Errorf("cached and pending image count exceeds limit: %d", total)
	}
	release()
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.entries) > maxEntries {
		t.Fatal("parallel fills exceeded image index limit")
	}
}

func TestInvalidResponsesAreNotCached(t *testing.T) {
	for _, scenario := range []string{"html", "oversize", "chunked-oversize", "error"} {
		t.Run(scenario, func(t *testing.T) {
			data := imageBytes(t, 2049)
			cache := testCache(t, func(*http.Request) (*http.Response, error) {
				response := reply(data)
				switch scenario {
				case "html":
					response = reply([]byte("<html>login required</html>"))
				case "chunked-oversize":
					response.ContentLength = -1
				case "error":
					response.StatusCode = 403
				}
				return response, nil
			})
			cache.fileBytes = 1024
			if _, _, err := cache.Open(context.Background(), 1, "https://photo.chaoxing.com/a"); err == nil {
				t.Fatal("invalid image accepted")
			}
			if files, _ := os.ReadDir(cache.dir); len(files) != 0 || cache.bytes != 0 || cache.reserved != 0 {
				t.Fatal("failed fill leaked data or reserved budget")
			}
		})
	}
}

func TestCacheStartupCleansOnlyOwnExpiredFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, fmt.Sprintf("%064d.png", 1))
	if err := os.WriteFile(path, imageBytes(t, 128), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-cacheTTL - time.Second)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "unrelated.txt")
	if err := os.WriteFile(other, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	cache, err := New(dir)
	if err != nil || cache.bytes != 0 {
		t.Fatalf("startup cleanup failed: %v", err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("expired cache file remains")
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("unrelated file was removed")
	}
}
