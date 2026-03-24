package xxt

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

func extractBetween(s, left, right string) string {
	i := strings.Index(s, left)
	if i < 0 {
		return ""
	}
	s = s[i+len(left):]
	j := strings.Index(s, right)
	if j < 0 {
		return ""
	}
	return strings.TrimSpace(s[:j])
}

func strVal(v interface{}) string {
	s, ok := v.(string)
	if ok {
		return s
	}
	s2, ok := v.(fmt.Stringer)
	if ok {
		return s2.String()
	}
	if v == nil {
		return ""
	}
	return fmt.Sprintf("%v", v)
}

func int64FromAny(v interface{}) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	default:
		return 0
	}
}

func firstNonNil(values ...interface{}) interface{} {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func findActiveList(payload interface{}) []map[string]interface{} {
	switch p := payload.(type) {
	case map[string]interface{}:
		if arr, ok := p["activeList"].([]interface{}); ok {
			return normalizeActiveList(arr)
		}
		for _, v := range p {
			if out := findActiveList(v); len(out) > 0 {
				return out
			}
		}
	case []interface{}:
		for _, v := range p {
			if out := findActiveList(v); len(out) > 0 {
				return out
			}
		}
	}
	return nil
}

func normalizeActiveList(arr []interface{}) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(arr))
	for _, item := range arr {
		if m, ok := item.(map[string]interface{}); ok {
			out = append(out, m)
		}
	}
	return out
}

func findBestActivityArray(payload interface{}) []map[string]interface{} {
	var best []map[string]interface{}
	var walk func(v interface{})
	walk = func(v interface{}) {
		switch x := v.(type) {
		case map[string]interface{}:
			for _, child := range x {
				walk(child)
			}
		case []interface{}:
			candidate := normalizeActiveList(x)
			if len(candidate) > 0 {
				score := scoreActivityArray(candidate)
				bestScore := scoreActivityArray(best)
				if score > bestScore {
					best = candidate
				}
			}
			for _, child := range x {
				walk(child)
			}
		}
	}
	walk(payload)
	return best
}

func scoreActivityArray(arr []map[string]interface{}) int {
	if len(arr) == 0 {
		return 0
	}
	score := 0
	for _, m := range arr {
		if int64FromAny(firstNonNil(m["id"], m["activeId"], m["active_id"])) > 0 {
			score += 2
		}
		if strVal(firstNonNil(m["nameOne"], m["name"], m["activeName"], m["title"])) != "" {
			score += 2
		}
		if int64FromAny(firstNonNil(m["activeType"], m["type"], m["atype"])) > 0 {
			score += 1
		}
	}
	return score
}

func deepFindFirst(v interface{}, keys ...string) interface{} {
	for _, k := range keys {
		if val, ok := deepFindKey(v, k); ok {
			return val
		}
	}
	return nil
}

func deepFindKey(v interface{}, target string) (interface{}, bool) {
	switch x := v.(type) {
	case map[string]interface{}:
		if val, ok := x[target]; ok {
			return val, true
		}
		for _, child := range x {
			if val, ok := deepFindKey(child, target); ok {
				return val, true
			}
		}
	case []interface{}:
		for _, child := range x {
			if val, ok := deepFindKey(child, target); ok {
				return val, true
			}
		}
	}
	return nil, false
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func parseTimeMillis(v interface{}) int64 {
	if v == nil {
		return 0
	}
	if m, ok := v.(map[string]interface{}); ok {
		return int64FromAny(m["time"])
	}
	return int64FromAny(v)
}

func boolFromAny(v interface{}) bool {
	switch b := v.(type) {
	case bool:
		return b
	case float64:
		return b != 0
	case int:
		return b != 0
	case int64:
		return b != 0
	case string:
		return b == "1" || strings.EqualFold(b, "true")
	default:
		return false
	}
}
