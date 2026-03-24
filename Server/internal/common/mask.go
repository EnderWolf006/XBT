package common

import "unicode/utf8"

func MaskMobile(mobile string) string {
	if utf8.RuneCountInString(mobile) < 7 {
		return mobile
	}
	r := []rune(mobile)
	if len(r) >= 11 {
		return string(r[:3]) + "****" + string(r[7:])
	}
	mid := len(r) / 2
	left := mid - 2
	if left < 1 {
		left = 1
	}
	right := left + 4
	if right > len(r)-1 {
		right = len(r) - 1
	}
	return string(r[:left]) + "****" + string(r[right:])
}
