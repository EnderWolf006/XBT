package xxt

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
)

func encryptXXTByAES(message, key string) string {
	messageBytes := []byte(message)
	keyBytes := []byte(key)
	if len(keyBytes) < 16 {
		pad := make([]byte, 16-len(keyBytes))
		keyBytes = append(keyBytes, pad...)
	}
	if len(keyBytes) > 16 {
		keyBytes = keyBytes[:16]
	}
	block, _ := aes.NewCipher(keyBytes)
	iv := keyBytes
	padded := pkcs7Pad(messageBytes, aes.BlockSize)
	cipherText := make([]byte, len(padded))
	mode := cipher.NewCBCEncrypter(block, iv)
	mode.CryptBlocks(cipherText, padded)
	return base64.StdEncoding.EncodeToString(cipherText)
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	padding := blockSize - (len(data) % blockSize)
	p := bytes.Repeat([]byte{byte(padding)}, padding)
	return append(data, p...)
}
