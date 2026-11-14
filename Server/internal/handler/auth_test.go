package handler

import "testing"

func TestPublicAccessAllowsUnlistedLoginWithConfiguredPermission(t *testing.T) {
	handler := &AuthHandler{publicAccess: true, publicAdmin: true}
	permission, allowed, err := handler.loginPermission("unlisted")
	if err != nil {
		t.Fatalf("unexpected public login policy error: %v", err)
	}
	if !allowed || permission != 2 {
		t.Fatalf("public admin login must allow an unlisted account with administrator permission; allowed=%v permission=%d", allowed, permission)
	}

	regularHandler := &AuthHandler{publicAccess: true}
	permission, allowed, err = regularHandler.loginPermission("unlisted")
	if err != nil {
		t.Fatalf("unexpected public login policy error: %v", err)
	}
	if !allowed || permission != 1 {
		t.Fatalf("public login without public_admin must allow ordinary unlisted accounts; allowed=%v permission=%d", allowed, permission)
	}

}
