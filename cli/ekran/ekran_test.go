package ekran

import (
	"fmt"
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

// Wayland masaüstü ve ekran paylaşım portalı gerekir (EKRAN_DENE=1, WAYLAND_DISPLAY): portal üzerinden
// PipeWire akışını yakalayıp VP8'e kodlar; ikinci açılış hatırlanan seçimle (sormadan) olmalı.
func TestWaylandYakala(t *testing.T) {
	if os.Getenv("EKRAN_DENE") != "1" || Oturum() != "wayland" {
		t.Skip("EKRAN_DENE=1 ve Wayland oturumu ile çalışır")
	}
	belirtec := ""
	for kez := 1; kez <= 2; kez++ {
		var kareler, bayt int
		p, err := Baslat(Secim{Kare: 30, IzinBelirteci: belirtec})
		if err != nil {
			t.Fatal(kez, err)
		}
		p.IzleyenVar = func() bool { return true }
		p.Gonder = func(k []byte, _ time.Duration) {
			kareler++
			bayt += len(k)
		}
		time.Sleep(2 * time.Second)
		p.Durdur()
		<-p.Bitti
		t.Logf("%d. açılış: %s: %d kare, %d KB, hatırlama belirteci %q", kez, p.Bilgi(), kareler, bayt/1024, p.IzinBelirteci)
		if p.Hata != nil {
			t.Fatal(p.Hata)
		}
		if kareler < 20 {
			t.Fatalf("yeterli kare yok: %d", kareler)
		}
		belirtec = p.IzinBelirteci
	}
}

// PipeWire okuyucusu (portalsız): PW_DUGUM'deki görüntü kaynağına bağlanıp kareleri kodlar.
func TestPipeWireOkuyucu(t *testing.T) {
	d := os.Getenv("PW_DUGUM")
	if d == "" {
		t.Skip("PW_DUGUM ile çalışır")
	}
	var dugum uint32
	fmt.Sscanf(d, "%d", &dugum)
	w, err := pipewireDogrudan(dugum, 30)
	if err != nil {
		t.Fatal(err)
	}
	var kareler, bayt int
	p := kaynaktan(w, Secim{Kare: 30}, "")
	p.IzleyenVar = func() bool { return true }
	p.Gonder = func(k []byte, _ time.Duration) {
		kareler++
		bayt += len(k)
	}
	time.Sleep(2 * time.Second)
	p.Durdur()
	<-p.Bitti
	t.Logf("%s: %d kare, %d KB", p.Bilgi(), kareler, bayt/1024)
	if p.Hata != nil {
		t.Fatal(p.Hata)
	}
	if kareler < 20 {
		t.Fatalf("yeterli kare yok: %d", kareler)
	}
}
