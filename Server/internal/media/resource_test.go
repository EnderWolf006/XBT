package media

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"testing"
	"time"
)

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// Opt-in: exercise the actual 200 MiB disk budget with streamed 2 MiB objects.
func TestImageCacheResourceBudget(t *testing.T) {
	if os.Getenv("XBT_MEDIA_RESOURCE_CHECK") != "1" {
		t.Skip("set XBT_MEDIA_RESOURCE_CHECK=1 for bounded disk/memory workload")
	}

	head := imageBytes(t, 512)
	cache := testCache(t, func(*http.Request) (*http.Response, error) {
		body := io.MultiReader(bytes.NewReader(head), io.LimitReader(zeroReader{}, MaxFileBytes-int64(len(head))))
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(body), ContentLength: MaxFileBytes}, nil
	})
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	peak := before.HeapAlloc
	start := time.Now()
	for i := 0; i < 128; i++ {
		image, _, err := cache.Open(context.Background(), 1, fmt.Sprintf("https://photo.chaoxing.com/resource-%d", i))
		if err != nil {
			t.Fatal(err)
		}
		image.Close()
		runtime.ReadMemStats(&after)
		if after.HeapAlloc > peak {
			peak = after.HeapAlloc
		}
	}
	files, err := os.ReadDir(cache.dir)
	if err != nil {
		t.Fatal(err)
	}
	var diskBytes int64
	for _, file := range files {
		info, err := file.Info()
		if err != nil {
			t.Fatal(err)
		}
		diskBytes += info.Size()
	}
	if diskBytes > MaxDiskBytes || cache.bytes > MaxDiskBytes || len(cache.entries) > maxEntries || cache.reserved != 0 {
		t.Fatalf("disk/index/reservation budget exceeded: disk=%d accounted=%d entries=%d reserved=%d", diskBytes, cache.bytes, len(cache.entries), cache.reserved)
	}
	if peak-before.HeapAlloc > 10<<20 {
		t.Fatalf("image workload added excessive live heap: %.2f MiB", float64(peak-before.HeapAlloc)/(1<<20))
	}
	t.Logf("streamed=256MiB disk=%.2fMiB entries=%d added_peak_heap=%.2fMiB elapsed=%s",
		float64(diskBytes)/(1<<20), len(cache.entries), float64(peak-before.HeapAlloc)/(1<<20), time.Since(start))
}
