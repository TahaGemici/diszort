package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// Güncelleme: sürüm bilgisi, dosyanın indirilmesi, özetin denetlenmesi ve yerine konması; özet
// tutmazsa eski dosya yerinde kalır; aynı commit'te güncellenmez.
func TestGuncelleme(t *testing.T) {
	yeniIcerik := []byte("#!/bin/sh\necho yeni surum\n")
	ozet := sha256.Sum256(yeniIcerik)
	bilgi := surumBilgisi{Surum: "v99.1.1", Commit: "bbbbbbb", Sha256: map[string]string{varlikAdi(): hex.EncodeToString(ozet[:])}}
	sunucu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch filepath.Base(r.URL.Path) {
		case "surum.json":
			json.NewEncoder(w).Encode(bilgi)
		case varlikAdi():
			w.Write(yeniIcerik)
		default:
			http.NotFound(w, r)
		}
	}))
	defer sunucu.Close()
	t.Setenv("DISZORT_INDIRME", sunucu.URL)
	eskiSurum, eskiCommit, eskiDepo := surum, commit, depo
	surum, commit, depo = "v1.1.1", "aaaaaaa", "deneme/diszort"
	defer func() { surum, commit, depo = eskiSurum, eskiCommit, eskiDepo }()

	s, err := sonSurumSureli(5e9)
	if err != nil || !yeniMi(s) || s.Surum != "v99.1.1" {
		t.Fatalf("sürüm bilgisi: %+v %v", s, err)
	}
	program := filepath.Join(t.TempDir(), "diszort")
	os.WriteFile(program, []byte("eski"), 0o755)
	if err := dosyayiGuncelle(s, program, func(string) {}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(program); string(b) != string(yeniIcerik) {
		t.Fatalf("dosya değişmedi: %q", b)
	}
	if fi, _ := os.Stat(program); fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("çalıştırılabilir değil: %v", fi.Mode())
	}
	// Özet tutmazsa: eski dosya kalır, geçici dosya silinir.
	os.WriteFile(program, []byte("eski"), 0o755)
	bilgi.Sha256[varlikAdi()] = "00"
	s, _ = sonSurumSureli(5e9)
	if err := dosyayiGuncelle(s, program, func(string) {}); err == nil {
		t.Fatal("özet tutmadığı hâlde güncellendi")
	}
	if b, _ := os.ReadFile(program); string(b) != "eski" {
		t.Fatalf("eski dosya bozuldu: %q", b)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(program), ".diszort.yeni")); !os.IsNotExist(err) {
		t.Fatal("geçici dosya kaldı")
	}
	// Aynı commit: güncellenecek bir şey yok.
	commit = "bbbbbbb"
	if s, _ := sonSurumSureli(5e9); yeniMi(s) {
		t.Fatal("aynı commit yeni sayıldı")
	}
}
