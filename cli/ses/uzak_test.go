package ses

import (
	"math"
	"math/rand"
	"testing"
)

// Ton kodlanır, paketler titreşimli ve kayıplı (RED'li ve RED'siz) gelir; çıkan ses sürekli olmalı
// (uydurma az, tampon hedefin yakınında).
func denemeAkisi(t *testing.T, kayip float64, red bool, titresimMs float64) (uydurulan, kurtarilan uint64, sessizBlok int, tampon float64) {
	k, err := YeniKodlayici(1, false)
	if err != nil {
		t.Fatal(err)
	}
	defer k.Kapat()
	k.BitHizi(64000)
	u, err := YeniUzakSes()
	if err != nil {
		t.Fatal(err)
	}
	defer u.Kapat()
	saat := 0.0
	u.Saat = func() float64 { return saat }
	r := rand.New(rand.NewSource(7))
	type gelen struct {
		zaman float64
		ts    uint32
		yuk   []byte
	}
	var yolda []gelen
	var onceki []byte
	faz := 0.0
	cikis := make([]float32, 960)
	const sure = 20000.0 // ms
	sonrakiPaket := 0.0
	var ts uint32 = 12345
	for adim := 0; float64(adim)*10 < sure; adim++ {
		saat = float64(adim) * 10
		for saat >= sonrakiPaket {
			o := make([]float32, 960)
			for i := range o {
				o[i] = float32(0.3 * math.Sin(faz))
				faz += 2 * math.Pi * 440 / 48000
			}
			p, err := k.Kodla(o)
			if err != nil {
				t.Fatal(err)
			}
			yuk := p
			if red {
				yuk = RedKur(111, p, onceki, 960)
			}
			onceki = p
			if r.Float64() >= kayip {
				yolda = append(yolda, gelen{zaman: sonrakiPaket + 20 + r.Float64()*titresimMs, ts: ts, yuk: yuk})
			}
			ts += 960
			sonrakiPaket += 20
		}
		kalan := yolda[:0]
		for _, g := range yolda {
			if g.zaman <= saat {
				u.PaketGeldi(g.ts, g.yuk, red, 111)
			} else {
				kalan = append(kalan, g)
			}
		}
		yolda = kalan
		u.Oku(cikis)
		if saat > 1000 {
			var e float64
			for _, x := range cikis {
				e += float64(x * x)
			}
			if e/float64(len(cikis)) < 1e-4 {
				sessizBlok++
			}
		}
	}
	d := u.Durum()
	return d.Uydurulan, d.Kurtarilan, sessizBlok, d.TamponMs
}

func TestUzakSesTemiz(t *testing.T) {
	uy, ku, ses, tm := denemeAkisi(t, 0, false, 5)
	t.Logf("kayıpsız: uydurulan %d, kurtarılan %d, sessiz blok %d, tampon %.0f ms", uy, ku, ses, tm)
	if uy > 2 || ses > 2 {
		t.Fatal("kayıpsız akışta kesinti")
	}
}

func TestUzakSesKayipRed(t *testing.T) {
	uy, ku, ses, tm := denemeAkisi(t, 0.1, true, 30)
	t.Logf("%%10 kayıp, RED, 30 ms titreşim: uydurulan %d, kurtarılan %d, sessiz blok %d, tampon %.0f ms", uy, ku, ses, tm)
	if ses > 10 {
		t.Fatal("çok sessiz blok")
	}
	uy2, ku2, ses2, tm2 := denemeAkisi(t, 0.1, false, 30)
	t.Logf("%%10 kayıp, RED yok: uydurulan %d, kurtarılan %d, sessiz blok %d, tampon %.0f ms", uy2, ku2, ses2, tm2)
	// Yedeksiz kayıpta çözücü ya Opus'un kendi yedeğiyle (FEC) ya da uydurarak doldurur; RED'de kaybolan
	// çerçevenin kendisi sonraki pakette gelir.
	if (uy+ku)*3 > uy2+ku2 {
		t.Fatalf("RED kayıpları azaltmadı (%d, RED'siz %d)", uy+ku, uy2+ku2)
	}
}

func TestRedCozKur(t *testing.T) {
	y := RedKur(111, []byte{1, 2, 3}, []byte{9, 8}, 960)
	b, ok := RedCoz(y)
	if !ok || len(b) != 2 || b[0].Geri != 960 || string(b[0].Veri) != "\x09\x08" || !b[1].Birincil || string(b[1].Veri) != "\x01\x02\x03" {
		t.Fatalf("%v %+v", ok, b)
	}
}
