package ses

import (
	"math"
	"math/rand"
	"testing"
)

// Çalınan ses 70 ms gecikip yarı şiddetle mikrofona dönüyor (hoparlör yankısı); mikrofonda başka ses
// yok. Süzgeç oturunca yankı en az 15 dB bastırılmalı.
func TestYankiEngeli(t *testing.T) {
	e, err := yeniYankiEngeli()
	if err != nil {
		t.Fatal(err)
	}
	defer e.kapat()
	r := rand.New(rand.NewSource(3))
	const blok = 480
	gecikme := 70 * 48 // örnek
	var gecmis []float32
	faz := 0.0
	var giris, cikis float64
	for k := 0; k < 800; k++ { // 8 sn
		calinan := make([]float32, 2*blok)
		for i := 0; i < blok; i++ {
			// Konuşmaya benzer: hece zarflı, perdesi oynayan ton + biraz gürültü.
			tt := float64(k*blok+i) / 48000
			faz += 2 * math.Pi * (150 + 40*math.Sin(2*math.Pi*0.5*tt)) / 48000
			zarf := math.Max(0, math.Sin(2*math.Pi*3*tt))
			v := float32(0.3*zarf*(math.Sin(faz)+0.5*math.Sin(2*faz)+0.3*math.Sin(3*faz)) + 0.02*r.NormFloat64())
			calinan[2*i], calinan[2*i+1] = v, v
			gecmis = append(gecmis, v)
		}
		e.calindi(calinan, 80)
		mik := make([]float32, blok)
		for i := range mik {
			j := len(gecmis) - blok + i - gecikme
			if j >= 0 {
				mik[i] = 0.5 * gecmis[j]
			}
		}
		var g float64
		for _, x := range mik {
			g += float64(x * x)
		}
		e.isle(mik)
		if k > 400 {
			giris += g
			for _, x := range mik {
				cikis += float64(x * x)
			}
		}
	}
	bastirma := 10 * math.Log10(giris/(cikis+1e-12))
	t.Logf("yankı %.1f dB bastırıldı", bastirma)
	if bastirma < 15 {
		t.Fatalf("yankı yeterince bastırılmadı: %.1f dB", bastirma)
	}
}
