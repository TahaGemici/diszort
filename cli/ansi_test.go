package main

import (
	"io"
	"strings"
	"testing"
	"time"
)

func TestSarGenislik(t *testing.T) {
	kirmizi := "\x1b[31m"
	metin := "15:04 " + kirmizi + "ali\x1b[0m: Türkçe harfler ığüşöç ve 中文字 ile 🙂 emojili, uzunca bir mesaj; sözcük arasından bölünmeli."
	for _, w := range []int{10, 17, 23, 40, 80} {
		satirlar := sar(metin, w, 6)
		toplam := 0
		for i, s := range satirlar {
			g := gorunur(s)
			if g > w {
				t.Fatalf("w=%d satır %d taşıyor (%d): %q", w, i, g, s)
			}
			if i > 0 && w >= 12 && !strings.HasPrefix(s, "      ") {
				t.Fatalf("w=%d satır %d girintisiz: %q", w, i, s)
			}
			toplam += g
		}
		if w >= 40 && len(satirlar) < 2 {
			t.Fatalf("w=%d bölünmedi: %q", w, satirlar)
		}
		// Hiçbir harf kaybolmasın (boşluklar dışında).
		duz := strings.ReplaceAll(renksiz(strings.Join(satirlar, "")), " ", "")
		if beklenen := strings.ReplaceAll(renksiz(metin), " ", ""); duz != beklenen {
			t.Fatalf("w=%d metin değişti:\n%q\n%q", w, duz, beklenen)
		}
	}
	// Renk bir sonraki satıra taşınır.
	s := sar("\x1b[32m"+strings.Repeat("yeşil ", 10)+"\x1b[0m son", 20, 0)
	if !strings.HasPrefix(s[1], "\x1b[32m") {
		t.Fatalf("renk taşınmadı: %q", s[1])
	}
	if strings.Contains(s[len(s)-1], "\x1b[32m") && !strings.Contains(s[len(s)-1], "\x1b[0m") {
		t.Fatalf("renk kapanmadı: %q", s[len(s)-1])
	}
	// Satır sonları korunur.
	if n := len(sar("bir\niki\nüç", 40, 2)); n != 3 {
		t.Fatalf("satır sonu: %d satır", n)
	}
	// Çok uzun sözcük harften bölünür.
	for _, s := range sar(strings.Repeat("x", 50), 12, 0) {
		if gorunur(s) > 12 {
			t.Fatalf("uzun sözcük taştı: %q", s)
		}
	}
}

func TestKesDoldurIki(t *testing.T) {
	if s := kes("merhaba dünya", 7); gorunur(s) != 7 || !strings.HasSuffix(s, "…") {
		t.Fatalf("kes: %q (%d)", s, gorunur(s))
	}
	if s := kes("tam", 3); s != "tam" {
		t.Fatalf("sığan kırpılmamalı: %q", s)
	}
	if s := kes("中文中文", 5); gorunur(s) > 5 {
		t.Fatalf("geniş harf taştı: %q", s)
	}
	if s := doldur("\x1b[1mab\x1b[0m", 6); gorunur(s) != 6 {
		t.Fatalf("doldur: %q", s)
	}
	if s := iki("sol taraf uzun bir yazı", "sağ", 15); gorunur(s) != 15 || !strings.HasSuffix(s, "sağ") {
		t.Fatalf("iki: %q (%d)", s, gorunur(s))
	}
	// Bağlantı (OSC 8) ve denetim karakterleri ekrana gitmez.
	if s := kes("\x1b]8;;https://x\x07bağ\x1b]8;;\x07\x07\x01", 10); renksiz(s) != "bağ" {
		t.Fatalf("temizlenmedi: %q", s)
	}
}

func TestKacisCoz(t *testing.T) {
	durumlar := map[string]string{
		"\x1b[A": "yukari", "\x1b[1;3A": "alt+yukari", "\x1b[1;5B": "ctrl+asagi", "\x1b\x1b[A": "alt+yukari",
		"\x1b[5~": "sayfa-yukari", "\x1b[6~": "sayfa-asagi", "\x1b[1;5H": "ctrl+bas", "\x1b[Z": "shift+tab",
		"\x1b[1;3C": "sozcuk-sag", "\x1bOA": "yukari", "\x1bm": "alt+m", "\x1b1": "alt+1", "\x1b\r": "alt+enter",
		"\x1b[3~": "sil", "\x1b[200~": "yapistir",
	}
	for dizi, beklenen := range durumlar {
		b := []byte(dizi)
		if !tamamMi(b) {
			t.Fatalf("%q bütün sayılmadı", dizi)
		}
		n, ad := kacisCoz(b)
		if ad != beklenen || n != len(b) {
			t.Fatalf("%q → %q (%d bayt), beklenen %q", dizi, ad, n, beklenen)
		}
	}
	if tamamMi([]byte("\x1b[1;")) || tamamMi([]byte("\x1b")) || tamamMi([]byte("\x1b\x1b[")) {
		t.Fatal("yarım dizi bütün sayıldı")
	}
}

// Tuş okuyucu: parça parça gelen baytlar (yarım UTF-8 harf, yarım kaçış dizisi), tek başına Esc,
// yapıştırma.
func TestTuslariOku(t *testing.T) {
	r, w := io.Pipe()
	olaylar := make(chan string, 64)
	go tuslariOku(r, tusAlici{
		Tus:      func(ad string) { olaylar <- "tus:" + ad },
		Harf:     func(h rune) { olaylar <- "harf:" + string(h) },
		Yapistir: func(s string) { olaylar <- "yap:" + s },
		Bitti:    func() { olaylar <- "bitti" },
	})
	yaz := func(s string) {
		w.Write([]byte(s))
		time.Sleep(5 * time.Millisecond)
	}
	yaz("a\xc4")      // "ı"nın ilk baytı
	yaz("\xb1\x1b[1") // ikinci baytı + yarım dizi
	yaz(";3A\r")
	yaz("\x1b") // tek başına Esc (40 ms sonra)
	time.Sleep(80 * time.Millisecond)
	yaz("\x1b[200~iki\nsatır\x1b[201~\x03")
	w.Close()
	beklenen := []string{"harf:a", "harf:ı", "tus:alt+yukari", "tus:enter", "tus:esc", "yap:iki\nsatır", "tus:ctrl+c", "bitti"}
	for _, b := range beklenen {
		select {
		case o := <-olaylar:
			if o != b {
				t.Fatalf("beklenen %q, gelen %q", b, o)
			}
		case <-time.After(time.Second):
			t.Fatalf("%q gelmedi", b)
		}
	}
}

func TestDuzenle(t *testing.T) {
	g, i := []rune("merhaba dünya"), 13
	g, i, _ = duzenle(g, i, "ctrl+w")
	if string(g) != "merhaba " || i != 8 {
		t.Fatalf("ctrl+w: %q %d", string(g), i)
	}
	g, i, _ = duzenle(g, i, "sozcuk-sol")
	if i != 0 {
		t.Fatalf("sozcuk-sol: %d", i)
	}
	if _, _, ok := duzenle(g, i, "tab"); ok {
		t.Fatal("tab düzenleme tuşu değil")
	}
}
