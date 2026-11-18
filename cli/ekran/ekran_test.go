package ekran

import (
	"os"
	"testing"
	"time"
)

// X sunucusu gerekir (EKRAN_DENE=1, DISPLAY): bütün ekranı yakalayıp VP8'e kodlar.
func TestX11Yakala(t *testing.T) {
	if os.Getenv("EKRAN_DENE") != "1" || !X11Var() {
		t.Skip("EKRAN_DENE=1 ve DISPLAY ile çalışır")
	}
	ml, err := X11Monitorler()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("monitörler: %v", ml)
	var kareler, anahtar, bayt int
	p, err := Baslat(Secim{Kare: 30})
	if err != nil {
		t.Fatal(err)
	}
	p.IzleyenVar = func() bool { return true }
	p.Gonder = func(k []byte, _ time.Duration) {
		kareler++
		bayt += len(k)
		if len(k) > 0 && k[0]&1 == 0 {
			anahtar++
		}
	}
	time.Sleep(2 * time.Second)
	p.Durdur()
	<-p.Bitti
	t.Logf("%s: %d kare, %d anahtar, %d KB", p.Bilgi(), kareler, anahtar, bayt/1024)
	if p.Hata != nil {
		t.Fatal(p.Hata)
	}
	if kareler < 30 || anahtar < 1 {
		t.Fatalf("yeterli kare yok: %d (anahtar %d)", kareler, anahtar)
	}
}
