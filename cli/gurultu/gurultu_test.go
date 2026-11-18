package gurultu

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

// Beyaz gürültü bastırılmalı; ton (konuşmaya benzemez ama) kesilse de yol çalışmalı, ölçüm gelmeli.
func TestGurultuBastirilir(t *testing.T) {
	y, err := Yeni(1, math.NaN())
	if err != nil {
		t.Fatal(err)
	}
	defer y.Kapat()
	r := rand.New(rand.NewSource(1))
	var giris, cikis float64
	x := make([]float32, Cerceve)
	t0 := time.Now()
	const n = 300
	for k := 0; k < n; k++ {
		for i := range x {
			x[i] = float32(r.NormFloat64() * 0.05)
			giris += float64(x[i]) * float64(x[i])
		}
		y.Isle(x)
		if k > 50 {
			for _, v := range x {
				cikis += float64(v) * float64(v)
			}
		}
	}
	sure := time.Since(t0)
	gDb := 10 * math.Log10(giris/float64(n*Cerceve))
	cDb := 10 * math.Log10(cikis/float64((n-51)*Cerceve)+1e-12)
	o := y.SonOlcum()
	t.Logf("giriş %.1f dB, çıkış %.1f dB; ölçüm %+v; %d çerçeve %v (çerçeve başı %v)", gDb, cDb, o, n, sure, sure/n)
	if cDb > gDb-8 {
		t.Fatalf("gürültü bastırılmadı: %.1f → %.1f dB", gDb, cDb)
	}
}

// Eşik: sessizlikte kapı kapanır (çıkış sıfır), yüksek seste açılır.
func TestKapi(t *testing.T) {
	y, err := Yeni(1, -40)
	if err != nil {
		t.Fatal(err)
	}
	defer y.Kapat()
	x := make([]float32, Cerceve)
	for k := 0; k < 60; k++ {
		for i := range x {
			x[i] = 0.0001
		}
		y.Isle(x)
	}
	if o := y.SonOlcum(); o.Acik {
		t.Fatalf("sessizlikte kapı açık: %+v", o)
	}
}
