package media

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	MaxDiskBytes = 200 << 20
	MaxFileBytes = 2 << 20
	maxEntries   = 1024
	cacheTTL     = 24 * time.Hour
	fillTimeout  = 8 * time.Second
	imageReferer = "https://i.chaoxing.com/"
)

var (
	ErrSource = errors.New("图片来源不受支持")
	ErrBusy   = errors.New("图片加载繁忙，请稍后重试")
	ErrFetch  = errors.New("图片暂时无法加载")
	cacheName = regexp.MustCompile(`^[0-9a-f]{64}\.(jpg|png|gif|webp)$`)
)

var imageTypes = map[string]string{
	".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
}

type entry struct {
	key, name string
	size      int64
	modified  time.Time
	readers   int
}

type Cache struct {
	dir                 string
	http                *http.Client
	mu                  sync.Mutex
	entries             map[string]*list.Element
	order               *list.List
	bytes, reserved     int64
	maxBytes, fileBytes int64
	ttl                 time.Duration
	fills               chan struct{}
	waiters             chan struct{}
	jobs                chan struct{}
	group               singleflight.Group
}

type Image struct {
	*os.File
	ContentType string
	Modified    time.Time
	Size        int64
	cache       *Cache
	entry       *entry
}

func (i *Image) Close() error {
	err := i.File.Close()
	i.cache.mu.Lock()
	i.entry.readers--
	i.cache.mu.Unlock()
	return err
}

func NormalizeSource(raw string) (string, error) {
	return normalizeSource(raw, false)
}

func normalizeSource(raw string, redirect bool) (string, error) {
	if len(raw) > 2048 {
		return "", ErrSource
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User != nil || u.Opaque != "" || u.Port() != "" ||
		(u.Scheme != "https" && u.Scheme != "http") {
		return "", ErrSource
	}
	switch strings.ToLower(u.Host) {
	case "photo.chaoxing.com", "p.ananas.chaoxing.com":
	case "p.cldisk.com":
		if !redirect {
			return "", ErrSource
		}
	default:
		return "", ErrSource
	}
	u.Scheme, u.Host, u.Fragment = "https", strings.ToLower(u.Host), ""
	return u.String(), nil
}

func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	for _, block := range nonPublicNetworks {
		if block.Contains(address) {
			return false
		}
	}
	return true
}

var nonPublicNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func newHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil, MaxIdleConns: 4, MaxIdleConnsPerHost: 2, MaxConnsPerHost: 2,
		IdleConnTimeout: 30 * time.Second, TLSHandshakeTimeout: 3 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second, MaxResponseHeaderBytes: 16 << 10,
		DisableCompression: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil || port != "443" {
				return nil, ErrSource
			}
			if _, err := normalizeSource("https://"+host+"/", true); err != nil {
				return nil, err
			}
			addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, ErrFetch
			}
			for _, address := range addresses {
				if !publicIP(address.IP) {
					return nil, ErrSource
				}
			}
			for _, address := range addresses {
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(address.IP.String(), port))
				if err == nil {
					return conn, nil
				}
			}
			return nil, ErrFetch
		},
	}
	return &http.Client{
		Transport: transport, Timeout: fillTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 3 || req.URL.Scheme != "https" {
				return ErrSource
			}
			_, err := normalizeSource(req.URL.String(), true)
			if err == nil {
				req.Header.Set("Referer", imageReferer)
			}
			return err
		},
	}
}

func New(dir string) (*Cache, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	c := &Cache{
		dir: dir, http: newHTTPClient(), entries: make(map[string]*list.Element), order: list.New(),
		maxBytes: MaxDiskBytes, fileBytes: MaxFileBytes, ttl: cacheTTL,
		fills: make(chan struct{}, 2), waiters: make(chan struct{}, 16), jobs: make(chan struct{}, 16),
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		name := file.Name()
		if !file.IsDir() && strings.HasPrefix(name, "fill-") && strings.HasSuffix(name, ".tmp") {
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				return nil, err
			}
			continue
		}
		if !cacheName.MatchString(name) || file.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := file.Info()
		if err != nil {
			return nil, err
		}
		if info.Size() > c.fileBytes || time.Since(info.ModTime()) >= c.ttl {
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				return nil, err
			}
			continue
		}
		key := strings.TrimSuffix(name, filepath.Ext(name))
		e := &entry{key: key, name: name, size: info.Size(), modified: info.ModTime()}
		c.entries[key] = c.order.PushBack(e)
		c.bytes += e.size
		if err := c.makeRoom(0); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Called with the cache lock held, except during construction.
func (c *Cache) remove(element *list.Element) error {
	e := element.Value.(*entry)
	if err := os.Remove(filepath.Join(c.dir, e.name)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	delete(c.entries, e.key)
	c.order.Remove(element)
	c.bytes -= e.size
	return nil
}

func (c *Cache) makeRoom(reserve int64) error {
	for c.bytes+c.reserved+reserve > c.maxBytes ||
		len(c.entries)+int((c.reserved+reserve)/c.fileBytes) > maxEntries {
		var victim *list.Element
		for candidate := c.order.Back(); candidate != nil; candidate = candidate.Prev() {
			if candidate.Value.(*entry).readers == 0 {
				victim = candidate
				break
			}
		}
		if victim == nil {
			return ErrBusy
		}
		if err := c.remove(victim); err != nil {
			return err
		}
	}
	return nil
}

func (c *Cache) open(key string) (*Image, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	element := c.entries[key]
	if element == nil {
		return nil, nil
	}
	e := element.Value.(*entry)
	if time.Since(e.modified) >= c.ttl {
		if e.readers == 0 {
			return nil, c.remove(element)
		}
		return nil, ErrBusy
	}
	file, err := os.Open(filepath.Join(c.dir, e.name))
	if errors.Is(err, os.ErrNotExist) {
		delete(c.entries, key)
		c.order.Remove(element)
		c.bytes -= e.size
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	e.readers++
	c.order.MoveToFront(element)
	return &Image{File: file, ContentType: imageTypes[filepath.Ext(e.name)], Modified: e.modified, Size: e.size, cache: c, entry: e}, nil
}

func (c *Cache) Open(ctx context.Context, uid int64, source string) (*Image, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if uid <= 0 {
		return nil, false, ErrSource
	}
	normalized, err := NormalizeSource(source)
	if err != nil {
		return nil, false, err
	}
	digest := sha256.Sum256([]byte(strconv.FormatInt(uid, 10) + "\x00" + normalized))
	key := hex.EncodeToString(digest[:])
	if image, err := c.open(key); image != nil || err != nil {
		return image, image != nil, err
	}
	select {
	case c.waiters <- struct{}{}:
		defer func() { <-c.waiters }()
	default:
		return nil, false, ErrBusy
	}
	result := c.group.DoChan(key, func() (interface{}, error) {
		if image, err := c.open(key); image != nil || err != nil {
			if image != nil {
				err = image.Close()
			}
			return nil, err
		}
		return nil, c.fill(key, normalized)
	})
	select {
	case <-ctx.Done():
		return nil, false, ctx.Err()
	case completed := <-result:
		if completed.Err != nil {
			return nil, false, completed.Err
		}
	}
	image, err := c.open(key)
	if image == nil && err == nil {
		err = ErrBusy
	}
	return image, false, err
}

func (c *Cache) fill(key, source string) error {
	select {
	case c.jobs <- struct{}{}:
		defer func() { <-c.jobs }()
	default:
		return ErrBusy
	}
	ctx, cancel := context.WithTimeout(context.Background(), fillTimeout)
	defer cancel()
	select {
	case c.fills <- struct{}{}:
		defer func() { <-c.fills }()
	case <-ctx.Done():
		return ErrBusy
	}
	c.mu.Lock()
	err := c.makeRoom(c.fileBytes)
	if err == nil {
		c.reserved += c.fileBytes
	}
	c.mu.Unlock()
	if err != nil {
		return err
	}
	reservationHeld := true
	defer func() {
		c.mu.Lock()
		if reservationHeld {
			c.reserved -= c.fileBytes
		}
		c.mu.Unlock()
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return ErrSource
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")
	req.Header.Set("Referer", imageReferer)
	resp, err := c.http.Do(req)
	if err != nil {
		return ErrFetch
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.ContentLength > c.fileBytes {
		return ErrFetch
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(resp.Body, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return ErrFetch
	}
	head = head[:n]
	contentType := http.DetectContentType(head)
	extension := ""
	for ext, mime := range imageTypes {
		if contentType == mime {
			extension = ext
		}
	}
	if extension == "" {
		return ErrFetch
	}
	temp, err := os.CreateTemp(c.dir, "fill-*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	size, copyErr := io.CopyBuffer(temp,
		io.MultiReader(bytes.NewReader(head), io.LimitReader(resp.Body, c.fileBytes+1-int64(n))), make([]byte, 32<<10))
	closeErr := temp.Close()
	if copyErr != nil || closeErr != nil || size > c.fileBytes {
		return ErrFetch
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	name := key + extension
	if err := os.Rename(tempName, filepath.Join(c.dir, name)); err != nil {
		return err
	}
	e := &entry{key: key, name: name, size: size, modified: time.Now()}
	c.reserved -= c.fileBytes
	reservationHeld = false
	c.entries[key] = c.order.PushFront(e)
	c.bytes += size
	return nil
}
