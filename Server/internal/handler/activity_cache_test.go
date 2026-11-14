package handler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestActivityCacheIsolatesAccountsAndEnforcesByteBudget(t *testing.T) {
	cache := newActivityCache()
	cache.maxBytes = 32
	var calls atomic.Int32
	load := func(value string) func(context.Context) ([]byte, error) {
		return func(context.Context) ([]byte, error) {
			calls.Add(1)
			return []byte(value), nil
		}
	}
	for _, step := range []struct {
		uid     int64
		value   string
		refresh bool
		state   string
	}{
		{1, "account-one", false, "MISS"}, {1, "account-one", false, "HIT"},
		{2, "account-two", false, "MISS"}, {1, "fresh-one", true, "MISS"},
		{3, "account-three", false, "MISS"}, {2, "account-two", false, "MISS"},
	} {
		body, state, err := cache.get(context.Background(), step.uid, step.refresh, load(step.value))
		if err != nil || string(body) != step.value || state != step.state {
			t.Fatalf("uid=%d body=%s state=%s err=%v", step.uid, body, state, err)
		}
		if cache.bytes > cache.maxBytes {
			t.Fatal("activity cache byte budget exceeded")
		}
	}
	if calls.Load() != 5 {
		t.Fatal("unexpected activity upstream request count")
	}
	big := bytes.Repeat([]byte("x"), cache.maxBytes+1)
	if _, _, err := cache.get(context.Background(), 4, false, func(context.Context) ([]byte, error) { return big, nil }); err != nil {
		t.Fatal(err)
	}
	if cache.entries[4] != nil || cache.bytes > cache.maxBytes {
		t.Fatal("oversized activity response was cached")
	}
}

func TestActivityCacheProductionBudget(t *testing.T) {
	cache := newActivityCache()
	for uid := int64(1); uid <= 3; uid++ {
		value := bytes.Repeat([]byte{byte(uid)}, 400<<10)
		body, _, err := cache.get(context.Background(), uid, false, func(context.Context) ([]byte, error) {
			return value, nil
		})
		if err != nil || !bytes.Equal(body, value) {
			t.Fatalf("activity load failed: %v", err)
		}
		if cache.bytes > 1<<20 {
			t.Fatal("production activity cache exceeded 1 MiB")
		}
	}
	if cache.entries[1] != nil || len(cache.entries) != 2 {
		t.Fatal("production activity budget did not evict the oldest account")
	}
	value := bytes.Repeat([]byte("x"), (1<<20)+1)
	if _, _, err := cache.get(context.Background(), 4, false, func(context.Context) ([]byte, error) {
		return value, nil
	}); err != nil {
		t.Fatal(err)
	}
	if cache.entries[4] != nil || cache.bytes > 1<<20 {
		t.Fatal("oversized activity payload entered the production cache")
	}
}

func TestActivityCacheDeduplicatesAndSurvivesCanceledWaiter(t *testing.T) {
	cache := newActivityCache()
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	load := func(context.Context) ([]byte, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return []byte("result"), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() {
		_, _, err := cache.get(ctx, 1, false, load)
		canceled <- err
	}()
	<-started
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, _, err := cache.get(context.Background(), 1, false, load)
			if err == nil && string(body) != "result" {
				err = fmt.Errorf("wrong shared result")
			}
			errs <- err
		}()
	}
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatal("waiter did not cancel")
	}
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate account refreshes were not merged")
	}
}

func TestActivityMutationCannotRepopulateOldResult(t *testing.T) {
	cache := newActivityCache()
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(finished)
		_, _, _ = cache.get(context.Background(), 1, false, func(context.Context) ([]byte, error) {
			close(started)
			<-release
			return []byte("before-sign"), nil
		})
	}()
	<-started
	cache.clear()
	newLoad := func(context.Context) ([]byte, error) { return []byte("after-sign"), nil }
	body, state, err := cache.get(context.Background(), 1, false, newLoad)
	if err != nil || state != "MISS" || string(body) != "after-sign" {
		t.Fatalf("refresh joined old generation: %s %s %v", body, state, err)
	}
	close(release)
	<-finished
	body, state, err = cache.get(context.Background(), 1, false, newLoad)
	if err != nil || state != "HIT" || string(body) != "after-sign" {
		t.Fatal("old in-flight request poisoned cache after mutation")
	}
}

func TestActivityCacheExpiryAndFailures(t *testing.T) {
	cache := newActivityCache()
	var calls int
	load := func(context.Context) ([]byte, error) {
		calls++
		return nil, errors.New("upstream failed")
	}
	for i := 0; i < 2; i++ {
		if _, _, err := cache.get(context.Background(), 1, false, load); err == nil {
			t.Fatal("upstream error hidden")
		}
	}
	if calls != 2 || cache.bytes != 0 {
		t.Fatal("failed response was cached")
	}
	success := func(context.Context) ([]byte, error) { return []byte("ok"), nil }
	cache.get(context.Background(), 1, false, success)
	cache.mu.Lock()
	cache.entries[1].Value.(*activityEntry).expires = time.Now().Add(-time.Second)
	cache.mu.Unlock()
	_, state, err := cache.get(context.Background(), 1, false, success)
	if err != nil || state != "MISS" {
		t.Fatal("expired response served as current")
	}
}
