package ses

import "math"

// Saat farkını ve titreşimi gideren yeniden örnekleyici.
//
// Gönderenin saati, bizim ses kartımızın saati ve ağın titreşimi aynı hızda akmaz: alıcı tamponu ya
// birikir ya boşalır. Ses çok az hızlandırılıp yavaşlatılarak (oran 1'e çok yakın) tampon hedefte
// tutulur. Ses çoğu zaman olduğu gibi kopyalanır; istenen oranın biriktirdiği fark bir örneği
// bulunca kısa bir "kayma" yapılır: pencereli sinc ile (32 dokunuş, 64 evre) yeniden örneklenerek bir
// örnek kazanılır ya da bırakılır. Fark yokken ses bit bit aynı geçer.

const (
	dokunus   = 32
	evre      = 64
	yari      = dokunus / 2
	kayma     = 2048
	kaymaEnaz = 20 // en hızlı kayma: %5 (titreşim sıçramasından sonra tamponu çabuk eritmek için)
)

var sincTablosu = func() []float32 {
	bessel := func(x float64) float64 {
		toplam, terim := 1.0, 1.0
		for k := 1; k < 30; k++ {
			terim *= (x / float64(2*k)) * (x / float64(2*k))
			toplam += terim
			if terim < 1e-12*toplam {
				break
			}
		}
		return toplam
	}
	t := make([]float32, (evre+1)*dokunus)
	const kesim = 0.94
	const beta = 9.0
	i0 := bessel(beta)
	for e := 0; e <= evre; e++ {
		kesir := float64(e) / evre
		toplam := 0.0
		for j := 0; j < dokunus; j++ {
			x := float64(j) - (yari - 1) - kesir
			s := kesim
			if x != 0 {
				s = math.Sin(math.Pi*kesim*x) / (math.Pi * x)
			}
			u := x / yari
			p := 0.0
			if math.Abs(u) < 1 {
				p = bessel(beta*math.Sqrt(1-u*u)) / i0
			}
			t[e*dokunus+j] = float32(s * p)
			toplam += s * p
		}
		for j := 0; j < dokunus; j++ {
			t[e*dokunus+j] /= float32(toplam)
		}
	}
	return t
}()

// Ornekleyici: kanalları iç içe (L R L R) ses.
type Ornekleyici struct {
	kanal                int
	giris                []float32
	dolu                 int     // giris'teki çerçeve
	konum                float64 // bir sonraki çıkış örneğinin giris'teki yeri
	borc                 float64
	kayma                int
	kaymaBoyu, kaymaAdim int
	kaymaBasi            float64
	KaymaSayisi          int
}

func YeniOrnekleyici(kanal int) *Ornekleyici {
	o := &Ornekleyici{kanal: kanal, giris: make([]float32, kanal*8192)}
	o.Sifirla()
	return o
}

func (o *Ornekleyici) Sifirla() {
	clear(o.giris)
	o.dolu = yari - 1
	o.konum = yari - 1
	o.borc = 0
	o.kayma = 0
}

// Bekleyen: henüz çıkışa dönüşmemiş giriş (çerçeve).
func (o *Ornekleyici) Bekleyen() float64 {
	return math.Max(0, float64(o.dolu-yari-1)-o.konum)
}

func (o *Ornekleyici) Besle(veri []float32) {
	k := o.kanal
	cerceve := len(veri) / k
	if (o.dolu+cerceve)*k > len(o.giris) {
		o.sikistir()
		if (o.dolu+cerceve)*k > len(o.giris) {
			yeni := make([]float32, max(len(o.giris)*2, (o.dolu+cerceve)*k*2))
			copy(yeni, o.giris[:o.dolu*k])
			o.giris = yeni
		}
	}
	copy(o.giris[o.dolu*k:], veri[:cerceve*k])
	o.dolu += cerceve
}

func (o *Ornekleyici) sikistir() {
	bas := o.konum
	if o.kayma != 0 {
		bas = o.kaymaBasi
	}
	at := int(math.Floor(bas)) - (yari - 1)
	if at <= 0 {
		return
	}
	k := o.kanal
	copy(o.giris, o.giris[at*k:o.dolu*k])
	o.dolu -= at
	o.konum -= float64(at)
	o.kaymaBasi -= float64(at)
}

// At: en eski bekleyen girişten cerceve kadarını at (gecikme birikmesin).
func (o *Ornekleyici) At(cerceve int) {
	c := math.Floor(math.Min(float64(cerceve), o.Bekleyen()))
	if c <= 0 {
		return
	}
	o.konum += c
	o.kaymaBasi += c
}

// Uret: hedef'e en çok enCok çerçeve üret; oran: çıkış örneği başına tüketilmek istenen giriş.
func (o *Ornekleyici) Uret(hedef []float32, enCok int, oran float64) int {
	k := o.kanal
	son := float64(o.dolu - yari - 1)
	fark := oran - 1
	n := 0
	for n < enCok {
		if o.kayma == 0 && (o.borc >= 1 || o.borc <= -1) {
			if o.borc > 0 {
				o.kayma = 1
			} else {
				o.kayma = -1
			}
			o.borc -= float64(o.kayma)
			o.kaymaBoyu = max(kaymaEnaz, min(kayma, int(kayma/math.Max(1, math.Abs(o.borc)*8))))
			if math.Abs(fark) > 0 {
				o.kaymaBoyu = max(kaymaEnaz, min(o.kaymaBoyu, int(1/math.Abs(fark))))
			}
			o.kaymaAdim = 0
			o.kaymaBasi = o.konum
			o.KaymaSayisi++
		}
		if o.kayma == 0 {
			i := int(o.konum)
			adet := min(enCok-n, int(son)-i+1, 128)
			if adet <= 0 {
				break
			}
			copy(hedef[n*k:(n+adet)*k], o.giris[i*k:(i+adet)*k])
			o.konum = float64(i + adet)
			o.borc += fark * float64(adet)
			n += adet
			continue
		}
		g := o.giris
		adim := 1 + float64(o.kayma)/float64(o.kaymaBoyu)
		for n < enCok && o.kaymaAdim < o.kaymaBoyu {
			konum := o.kaymaBasi + float64(o.kaymaAdim)*adim
			i := int(math.Floor(konum))
			if float64(i) > son {
				o.konum = konum
				return n
			}
			ev := (konum - float64(i)) * evre
			e0 := int(ev)
			a := float32(ev - float64(e0))
			t0 := e0 * dokunus
			t1 := t0 + dokunus
			bas := (i - (yari - 1)) * k
			if k == 1 {
				var s float32
				for j := 0; j < dokunus; j++ {
					s += g[bas+j] * (sincTablosu[t0+j] + a*(sincTablosu[t1+j]-sincTablosu[t0+j]))
				}
				hedef[n] = s
			} else {
				var sl, sr float32
				for j := 0; j < dokunus; j++ {
					c := sincTablosu[t0+j] + a*(sincTablosu[t1+j]-sincTablosu[t0+j])
					sl += g[bas+2*j] * c
					sr += g[bas+2*j+1] * c
				}
				hedef[2*n] = sl
				hedef[2*n+1] = sr
			}
			o.kaymaAdim++
			o.borc += fark
			n++
		}
		if o.kaymaAdim >= o.kaymaBoyu {
			o.konum = o.kaymaBasi + float64(o.kaymaBoyu+o.kayma)
			o.kayma = 0
		} else {
			o.konum = o.kaymaBasi + float64(o.kaymaAdim)*adim
		}
	}
	if o.konum > 4096 {
		o.sikistir()
	}
	return n
}

// OranDenetimi: tampon doluluğundan oran. Doluluk önce yumuşatılır (~0,5 sn); ±olu ms'lik sapmaya
// dokunulmaz, ötesi orantılı düzeltilir (en çok ±enCok).
type OranDenetimi struct {
	HedefMs float64
	olu     float64
	enCok   float64
	katsayi float64
	sapma   float64
	son     float64
	Oran    float64
}

func YeniOranDenetimi(hedefMs, oluMs, enCok, katsayi float64) *OranDenetimi {
	return &OranDenetimi{HedefMs: hedefMs, olu: oluMs, enCok: enCok, katsayi: katsayi, Oran: 1}
}

func (d *OranDenetimi) Sifirla() { d.sapma, d.son, d.Oran = 0, 0, 1 }

// Guncelle: doluMs şu anki doluluk, simdiMs zaman.
func (d *OranDenetimi) Guncelle(doluMs, simdiMs float64) float64 {
	dt := 0.0
	if d.son > 0 {
		dt = math.Min(100, math.Max(0, simdiMs-d.son))
	} else {
		d.sapma = doluMs - d.HedefMs
	}
	d.son = simdiMs
	alfa := 1 - math.Exp(-dt/500)
	d.sapma += (doluMs - d.HedefMs - d.sapma) * alfa
	s := d.sapma
	fazla := 0.0
	if s > d.olu {
		fazla = s - d.olu
	} else if s < -d.olu {
		fazla = s + d.olu
	}
	d.Oran = 1 + math.Max(-d.enCok, math.Min(d.enCok, fazla*d.katsayi))
	return d.Oran
}
