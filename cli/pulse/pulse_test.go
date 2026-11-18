package pulse

import (
	"math"
	"os"
	"os/exec"
	"testing"
	"time"
)

// Gerçek bir ses sunucusu gerekir (PULSE_DENE=1): aygıtları listeler, bir uygulama gibi ton çalar ve
// yalnızca o uygulamanın akışını kaydeder; Diszort'un kendi çaldığı karışmamalı.
func TestGercekSunucu(t *testing.T) {
	if os.Getenv("PULSE_DENE") != "1" {
		t.Skip("PULSE_DENE=1 ile çalışır")
	}
	b, err := Baglan("Diszort deneme")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Kapat()
	bilgi, err := b.SunucuBilgisi()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("sunucu %s %s, varsayılan çıkış %s, giriş %s, istemci %d", bilgi.Ad, bilgi.Surum, bilgi.VarsayilanCikis, bilgi.VarsayilanGiris, b.IstemciNo)
	cik, err := b.Cikislar()
	if err != nil || len(cik) == 0 {
		t.Fatal("çıkış yok", err)
	}
	gir, err := b.Girisler()
	if err != nil || len(gir) == 0 {
		t.Fatal("giriş yok", err)
	}
	for _, a := range gir {
		t.Logf("giriş %q (%s) monitör=%v", a.Ad, a.Aciklama, a.MonitorMu)
	}
	// Kendi çalmamız: 1000 Hz.
	calma, err := b.CalmaAc("", 2, 60, "Diszort deneme", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer calma.Kapat()
	durdur := make(chan struct{})
	go func() {
		faz := 0.0
		tik := time.NewTicker(5 * time.Millisecond)
		defer tik.Stop()
		for {
			select {
			case <-durdur:
				return
			case <-tik.C:
			}
			for calma.Kredi() >= 480 {
				o := make([]float32, 960)
				for i := 0; i < 480; i++ {
					v := float32(0.3 * math.Sin(faz))
					faz += 2 * math.Pi * 1000 / 48000
					o[2*i], o[2*i+1] = v, v
				}
				calma.Yaz(o)
			}
		}
	}()
	defer close(durdur)
	// Başka bir uygulama: 440 Hz (paplay).
	uyg := exec.Command("paplay", "--client-name=uygulama", os.Getenv("TON_440"))
	if err := uyg.Start(); err != nil {
		t.Skip("paplay yok:", err)
	}
	defer uyg.Process.Kill()
	time.Sleep(800 * time.Millisecond)
	akislar, err := b.CalmaAkislari()
	if err != nil {
		t.Fatal(err)
	}
	var hedef uint32 = TumAkislar
	for _, c := range akislar {
		t.Logf("akış %d %q istemci %d (biz %d)", c.Indeks, c.Uygulama(), c.Istemci, b.IstemciNo)
		if c.Uygulama() == "uygulama" {
			hedef = c.Indeks
		}
	}
	if hedef == TumAkislar {
		t.Fatal("uygulamanın akışı bulunamadı")
	}
	gelen := make(chan []float32, 400)
	k, err := b.KayitAc("", 2, 10, hedef, "Diszort paylaşım deneme", func(o []float32) {
		select {
		case gelen <- o:
		default:
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer k.Kapat()
	var x []float32
	son := time.After(1500 * time.Millisecond)
topla:
	for {
		select {
		case o := <-gelen:
			x = append(x, o...)
		case <-son:
			break topla
		}
	}
	g := func(f float64) float64 {
		var re, im float64
		n := len(x) / 2
		for i := 0; i < n; i++ {
			w := 2 * math.Pi * f * float64(i) / 48000
			re += float64(x[2*i]) * math.Cos(w)
			im -= float64(x[2*i]) * math.Sin(w)
		}
		return 2 * math.Hypot(re, im) / float64(max(1, n))
	}
	a440, a1000 := g(440), g(1000)
	t.Logf("%d örnek; 440 Hz %.4f, 1000 Hz %.4f", len(x)/2, a440, a1000)
	if a440 < 0.1 || a1000 > 0.01 {
		t.Fatalf("uygulamanın sesi temiz değil: 440 %.4f, 1000 %.4f", a440, a1000)
	}
}
