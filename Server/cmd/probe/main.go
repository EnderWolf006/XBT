package main

import (
	"fmt"
	"os"

	"xbt2/server/internal/service"
)

func main() {
	cc := service.NewCredentialCrypto(os.Getenv("XBT_SEC"))
	plain, err := cc.Decrypt(os.Getenv("XBT_CIPH"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "decrypt failed")
		os.Exit(1)
	}
	fmt.Print(plain)
}
