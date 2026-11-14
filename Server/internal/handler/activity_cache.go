package handler

import (
	"container/list"
	"context"
	"errors"
	"sync"
	"time"
)

const (
	activityCacheBytes = 1 << 20
	activityCacheTTL   = 2 * time.Second
)

var errActivityBusy = errors.New("活动刷新繁忙，请稍后重试")

type activityEntry struct {
	uid     int64
	body    []byte
	expires time.Time
}

type activityFlight struct {
	done chan struct{}
	body []byte
	err  error
}

type activityFlightKey struct {
	uid        int64
	generation uint64
}

type activityCache struct {
	mu         sync.Mutex
	entries    map[int64]*list.Element
	order      *list.List
	bytes      int
	maxBytes   int
	ttl        time.Duration
	generation uint64
	flights    map[activityFlightKey]*activityFlight
}

func newActivityCache() *activityCache {
	return &activityCache{
		entries: make(map[int64]*list.Element), order: list.New(),
		maxBytes: activityCacheBytes, ttl: activityCacheTTL,
		flights: make(map[activityFlightKey]*activityFlight),
	}
}

func (c *activityCache) remove(element *list.Element) {
	entry := element.Value.(*activityEntry)
	delete(c.entries, entry.uid)
	c.bytes -= len(entry.body)
	c.order.Remove(element)
}

func (c *activityCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.entries)
	c.order.Init()
	c.bytes = 0
	c.generation++
}

func (c *activityCache) get(ctx context.Context, uid int64, refresh bool, load func(context.Context) ([]byte, error)) ([]byte, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	c.mu.Lock()
	for element := c.order.Back(); element != nil; {
		previous := element.Prev()
		if !time.Now().Before(element.Value.(*activityEntry).expires) {
			c.remove(element)
		}
		element = previous
	}
	if element := c.entries[uid]; element != nil && !refresh {
		c.order.MoveToFront(element)
		body := element.Value.(*activityEntry).body
		c.mu.Unlock()
		return body, "HIT", nil
	}
	key := activityFlightKey{uid: uid, generation: c.generation}
	flight := c.flights[key]
	state := "SHARED"
	if flight == nil {
		if len(c.flights) >= 16 {
			c.mu.Unlock()
			return nil, "", errActivityBusy
		}
		state = "MISS"
		flight = &activityFlight{done: make(chan struct{})}
		c.flights[key] = flight
		go func() {
			loadCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			body, err := load(loadCtx)
			c.mu.Lock()
			defer c.mu.Unlock()
			flight.body, flight.err = body, err
			// A mutation may have happened while the upstream request was running.
			if err == nil && key.generation == c.generation && len(body) <= c.maxBytes {
				if element := c.entries[uid]; element != nil {
					c.remove(element)
				}
				for c.order.Len() > 0 && (c.bytes+len(body) > c.maxBytes || len(c.entries) >= 64) {
					c.remove(c.order.Back())
				}
				c.entries[uid] = c.order.PushFront(&activityEntry{uid: uid, body: body, expires: time.Now().Add(c.ttl)})
				c.bytes += len(body)
			}
			delete(c.flights, key)
			close(flight.done)
		}()
	}
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, state, ctx.Err()
	case <-flight.done:
		return flight.body, state, flight.err
	}
}
