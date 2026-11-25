package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// denemeUygulamasi: terminalsiz, sunucusuz bir tam ekran uygulaması (çizim denemeleri için).
func denemeUygulamasi(t *testing.T) *Uygulama {
	t.Helper()
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm-256color")
	u := yeniUygulama(&Ayar{Sunucu: "https://sohbet.ornek.com", yol: filepath.Join(t.TempDir(), "diszort.json")}, false, true, nil)
	u.ben = "taha"
	u.bagli, u.oturumVardi = true, true
	u.kanallar = []Kanal{
		{ID: "k1", Ad: "genel", Tur: "yazi"},
		{ID: "k2", Ad: "oyun", Tur: "yazi"},
		{ID: "s1", Ad: "Sesli Sohbet", Tur: "ses", Kisiler: []SesKisi{{Ad: "zeynep"}, {Ad: "ali", Sessiz: true, Yayin: &YayinBilgi{Goruntu: true}}}},
	}
	u.kimler = []Kim{{Ad: "taha"}, {Ad: "zeynep"}, {Ad: "ali"}}
	u.aktifKanal = "k1"
	u.okunmamis["k2"] = 3
	simdi := time.Now().UnixMilli()
	for i := 0; i < 60; i++ {
		u.mesajlar = append(u.mesajlar, Mesaj{ID: int64(i + 1), Ad: []string{"zeynep", "ali", "taha"}[i%3], Metin: fmt.Sprintf("mesaj %d: biraz uzunca bir yazı ki satırlar bölünsün ve çizimin taşmadığı görülsün", i), Zaman: simdi - int64(60-i)*60000})
	}
	return u
}

func TestTamEkranDuzen(t *testing.T) {
	u := denemeUygulamasi(t)
	e := u.ekran
	for _, boy := range [][2]int{{120, 30}, {80, 24}, {60, 20}, {31, 9}} {
		e.gen, e.yuk = boy[0], boy[1]
		satirlar := e.olustur()
		if len(satirlar) != e.yuk {
			t.Fatalf("%v: %d satır", boy, len(satirlar))
		}
		for i, s := range satirlar {
			if g := gorunur(s); g > e.gen {
				t.Fatalf("%v: satır %d taşıyor (%d): %q", boy, i, g, renksiz(s))
			}
		}
		ekran := renksiz(strings.Join(satirlar, "\n"))
		if !strings.Contains(ekran, "mesaj 59") {
			t.Fatalf("%v: son mesaj görünmüyor:\n%s", boy, ekran)
		}
		if !strings.Contains(renksiz(satirlar[e.yuk-1]), "#genel ›") {
			t.Fatalf("%v: yazma satırı: %q", boy, renksiz(satirlar[e.yuk-1]))
		}
		kenar := strings.Contains(ekran, "# oyun")
		if kenar != (boy[0] >= 72) {
			t.Fatalf("%v: kenar çubuğu görünürlüğü yanlış:\n%s", boy, ekran)
		}
		if kenar && (!strings.Contains(ekran, "♪ Sesli Sohbet") || !strings.Contains(ekran, "sessiz ekran") || !strings.Contains(ekran, "ÇEVRİMİÇİ · 3")) {
			t.Fatalf("%v: kenar çubuğu eksik:\n%s", boy, ekran)
		}
	}
	e.gen, e.yuk = 20, 5
	if s := renksiz(e.olustur()[0]); !strings.Contains(s, "küçük") {
		t.Fatalf("küçük pencere: %q", s)
	}
}

func TestTamEkranKaydirma(t *testing.T) {
	u := denemeUygulamasi(t)
	u.gecmisBitti = true
	e := u.ekran
	e.gen, e.yuk = 100, 20
	e.tus("sayfa-yukari")
	ekran := renksiz(strings.Join(e.olustur(), "\n"))
	if strings.Contains(ekran, "mesaj 59") || !strings.Contains(ekran, "geçmişe bakıyorsun") {
		t.Fatalf("yukarı kaymadı:\n%s", ekran)
	}
	// Yukarıdayken gelen mesaj görüneni kaydırmaz, sayılır.
	once := e.kaydirma
	u.mesajGeldi("k1", Mesaj{ID: 1000, Ad: "zeynep", Metin: "yeni gelen", Zaman: time.Now().UnixMilli()})
	if e.kaydirma <= once || e.yeniAltta != 1 {
		t.Fatalf("kaydırma %d→%d, yeni %d", once, e.kaydirma, e.yeniAltta)
	}
	// En başa kadar: kanalın başı yazar, daha yukarı gidilmez.
	e.tus("ctrl+bas")
	ekran = renksiz(strings.Join(e.olustur(), "\n"))
	if !strings.Contains(ekran, "kanalının başı") || !strings.Contains(ekran, "mesaj 0:") {
		t.Fatalf("başa gelinmedi:\n%s", ekran)
	}
	e.tus("esc")
	ekran = renksiz(strings.Join(e.olustur(), "\n"))
	if !strings.Contains(ekran, "yeni gelen") || e.kaydirma != 0 {
		t.Fatalf("Esc en alta indirmedi:\n%s", ekran)
	}
}

func TestTamEkranYazma(t *testing.T) {
	u := denemeUygulamasi(t)
	e := u.ekran
	e.gen, e.yuk = 100, 20
	for _, r := range "@zey" {
		e.harf(r)
	}
	e.tus("tab")
	if string(e.girdi) != "@zeynep " {
		t.Fatalf("ad tamamlama: %q", string(e.girdi))
	}
	// Komut gibi yazılan ilk Enter'da gitmez, uyarılır.
	e.girdi, e.imlec = []rune("/kanallar"), 9
	e.gonder()
	if string(e.girdi) != "/kanallar" || !strings.Contains(e.bildirim, "komut") {
		t.Fatalf("komut uyarısı yok: %q %q", string(e.girdi), e.bildirim)
	}
	// Kanallar arasında gezinme.
	e.tus("alt+asagi")
	if u.aktifKanal != "k2" {
		t.Fatalf("Alt+↓: %s", u.aktifKanal)
	}
	e.tus("alt+1")
	if u.aktifKanal != "k1" {
		t.Fatalf("Alt+1: %s", u.aktifKanal)
	}
	// Ctrl+C (satırda yazı olsa da) hemen hepsini kapatır.
	e.girdi, e.imlec = []rune("yarım mesaj"), 11
	e.tus("ctrl+c")
	if !u.durduruldu {
		t.Fatal("Ctrl+C kapatmadı")
	}
}
