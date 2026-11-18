package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Önceki (web sayfasını çalıştıran) CLI'ın ayar dosyası: sayfanın localStorage'ı "depo"da.
func TestEskiAyarGecisi(t *testing.T) {
	yol := filepath.Join(t.TempDir(), "diszort.json")
	eski := `{"sunucu":"https://chat.ornek.com","depo":{"anahtar":"abc","ad":"taha","kanal":"muhabbet",` +
		`"ses-ayarlari":"{\"mikId\":\"alsa_input.usb\",\"cikisId\":\"alsa_output.hdmi\",\"mikSeviye\":120,\"esik\":20,\"kalite\":128,\"yayinSes\":256,\"mikRed\":false,\"sagir\":true}",` +
		`"ses-seviye-zeynep":"40","ses-sustur-mert":"1","yayin-seviye-zeynep":"70"},"istemciKodu":"program"}`
	if err := os.WriteFile(yol, []byte(eski), 0o600); err != nil {
		t.Fatal(err)
	}
	a, err := ayarOku(yol)
	if err != nil {
		t.Fatal(err)
	}
	s := a.Ses
	if a.Sunucu != "https://chat.ornek.com" || a.Anahtar != "abc" || a.Ad != "taha" || a.Kanal != "muhabbet" {
		t.Fatalf("kimlik taşınmadı: %+v", a)
	}
	if s.Mik != "alsa_input.usb" || s.Hoparlor != "alsa_output.hdmi" || s.MikSeviye != 120 || s.Esik != 20 || s.Kalite != 128 || s.YayinSes != 256 || s.MikRed || !s.Sagir || !s.Sesler {
		t.Fatalf("ses ayarları taşınmadı: %+v", s)
	}
	if k := a.Kisiler["zeynep"]; k == nil || k.Seviye != 40 || k.YayinSeviye != 70 {
		t.Fatalf("kişi seviyesi taşınmadı: %+v", a.Kisiler["zeynep"])
	}
	if k := a.Kisiler["mert"]; k == nil || !k.Sustur || k.Seviye != 100 {
		t.Fatalf("susturma taşınmadı: %+v", a.Kisiler["mert"])
	}
	// Yeni biçimde kaydedilip yeniden okunur.
	if err := a.Kaydet(); err != nil {
		t.Fatal(err)
	}
	b, err := ayarOku(yol)
	if err != nil || b.Anahtar != "abc" || b.Ses.MikSeviye != 120 || b.Kisiler["zeynep"].Seviye != 40 {
		t.Fatalf("yeniden okunamadı: %v %+v", err, b)
	}
	if bilgi, _ := os.Stat(yol); bilgi.Mode().Perm() != 0o600 {
		t.Fatalf("izin %v", bilgi.Mode().Perm())
	}
}

func TestAdresDuzelt(t *testing.T) {
	k, an, ok := adresDuzelt("chat.ornek.com/#anahtar=a%2Bb")
	if !ok || k != "https://chat.ornek.com" || an != "a+b" {
		t.Fatalf("%q %q %v", k, an, ok)
	}
	if _, _, ok := adresDuzelt("   "); ok {
		t.Fatal("boş adres kabul edildi")
	}
}
