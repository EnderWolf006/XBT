package media

import (
	"context"
	"io"
	"os"
	"testing"
	"time"
)

func TestRealImageSourceReadOnly(t *testing.T) {
	source := os.Getenv("XBT_MEDIA_SOURCE")
	if source == "" {
		t.Skip("set XBT_MEDIA_SOURCE for an anonymous read-only upstream image check")
	}
	cache, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	image, hit, err := cache.Open(context.Background(), 1, source)
	if err != nil || hit {
		t.Fatalf("image fetch failed: %v", err)
	}
	size, err := io.Copy(io.Discard, image)
	image.Close()
	if err != nil || size == 0 {
		t.Fatalf("image body invalid: bytes=%d error=%v", size, err)
	}
	miss := time.Since(start)
	start = time.Now()
	image, hit, err = cache.Open(context.Background(), 1, source)
	if err != nil || !hit {
		t.Fatalf("image cache hit failed: %v", err)
	}
	image.Close()
	t.Logf("real_image_bytes=%d cold=%s warm=%s", size, miss, time.Since(start))
}
