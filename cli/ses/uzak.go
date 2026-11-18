package ses

import (
	"math"
	"sort"
	"sync"
	"time"
)

// UzakSes: bir eşten gelen bir ses akışı (mikrofonu ya da paylaşımı): titreşim tamponu, Opus çözücü,
// kayıpta önce Opus'un kendi yedeği (FEC), yoksa uydurma (PLC), saat farkı ve titreşim için oran
// denetimi. Paketler ağ goroutine'inden (PaketGeldi), ses karıştırıcıdan (Oku) gelir/gider.
//
// Tampon hedefi titreşime göre ayarlanır: son ~3 saniyede paketlerin geliş gecikmesinin
// dağılımından (en hızlı paketle %95'lik dilim arası) + bir çerçeve; en az 40, en çok 400 ms.
// Tampon hedefin çok üstüne çıkarsa (ör. ağ takıldı, sonra her şey birden geldi) eski ses atılır.
type UzakSes struct {
	mu        sync.Mutex
	coz       *Cozucu
	paket     map[uint32][]byte
	oynat     uint32
	basladi   bool
	cerceve   int
	enYeni    uint32
	enYeniVar bool
	sonGelis  float64
	ilkGelis  float64
	ardisik   int
	ornek     *Ornekleyici
	oran      *OranDenetimi
	tampon    []float32
	gecis     []float64
	gecisI    int
	HedefMs   float64
	t0        time.Time
	// Saat: ms cinsinden şimdiki zaman (denemelerde değiştirilir).
	Saat func() float64
	// İstatistik (Durum ile okunur).
	alinan, gec, uydurulan, kurtarilan, cozulen, red uint64
	sonSesMs                                         float64
	seviye                                           float64
}

// Durum: akışın durumu.
type UzakDurum struct {
	Aliniyor   bool // son 1 sn'de paket geldi
	Caliyor    bool
	Konusuyor  bool // son 350 ms'de -48 dBFS'in üstünde
	Seviye     float64
	TamponMs   float64
	HedefMs    float64
	Alinan     uint64
	Gec        uint64
	Uydurulan  uint64
	Kurtarilan uint64
	Red        uint64 // RED'li gelen paket
}

func YeniUzakSes() (*UzakSes, error) {
	c, err := YeniCozucu()
	if err != nil {
		return nil, err
	}
	u := &UzakSes{coz: c, paket: map[uint32][]byte{}, cerceve: 960, ornek: YeniOrnekleyici(2), tampon: make([]float32, 5760*2), gecis: make([]float64, 150), HedefMs: 60, t0: time.Now(), sonSesMs: -1e9}
	for i := range u.gecis {
		u.gecis[i] = math.NaN()
	}
	u.oran = YeniOranDenetimi(u.HedefMs, 4, 0.05, 1e-3)
	return u, nil
}

func (u *UzakSes) simdi() float64 {
	if u.Saat != nil {
		return u.Saat()
	}
	return float64(time.Since(u.t0).Microseconds()) / 1000
}

func once(a, b uint32) bool { return int32(a-b) < 0 }

// PaketGeldi: RTP paketi. red: yük RED'dir (opusPT: içindeki Opus'un yük türü).
func (u *UzakSes) PaketGeldi(ts uint32, yuk []byte, red bool, opusPT uint8) {
	u.mu.Lock()
	defer u.mu.Unlock()
	simdi := u.simdi()
	if red {
		u.red++
		bloklar, tamam := RedCoz(yuk)
		if !tamam {
			return
		}
		for _, b := range bloklar {
			if b.PT != opusPT || len(b.Veri) == 0 {
				continue
			}
			if b.Birincil {
				u.ekle(ts, b.Veri, simdi, true)
			} else {
				u.ekle(ts-b.Geri, b.Veri, simdi, false)
			}
		}
		return
	}
	u.ekle(ts, yuk, simdi, true)
}

func (u *UzakSes) ekle(ts uint32, veri []byte, simdi float64, birincil bool) {
	if birincil {
		u.alinan++
		u.sonGelis = simdi
		// Geliş gecikmesi (göreli): titreşim ölçümü.
		u.gecis[u.gecisI] = simdi - float64(ts)/48
		u.gecisI = (u.gecisI + 1) % len(u.gecis)
		if !u.basladi && len(u.paket) == 0 {
			u.ilkGelis = simdi
		}
	}
	if u.basladi && once(ts, u.oynat) {
		if birincil {
			u.gec++
		}
		return
	}
	if _, var_ := u.paket[ts]; var_ {
		return
	}
	if len(u.paket) > 600 {
		return
	}
	u.paket[ts] = append([]byte(nil), veri...)
	sure := PaketSuresi(veri)
	if sure <= 0 {
		sure = u.cerceve
	}
	son := ts + uint32(sure)
	if !u.enYeniVar || once(u.enYeni, son) {
		u.enYeni = son
		u.enYeniVar = true
	}
	if birincil && u.alinan%5 == 0 {
		u.hedefGuncelle()
	}
}

// hedefGuncelle: titreşimden tampon hedefi; artış hemen, azalış yavaş.
func (u *UzakSes) hedefGuncelle() {
	var v []float64
	for _, x := range u.gecis {
		if !math.IsNaN(x) {
			v = append(v, x)
		}
	}
	if len(v) < 10 {
		return
	}
	sort.Float64s(v)
	titresim := v[len(v)*95/100] - v[0]
	hedef := math.Max(40, math.Min(400, titresim+float64(u.cerceve)/48+10))
	if hedef > u.HedefMs {
		u.HedefMs = hedef
	} else {
		u.HedefMs += (hedef - u.HedefMs) * 0.01
	}
	u.oran.HedefMs = u.HedefMs
}

// doluMs: çalınmayı bekleyen ses (ms).
func (u *UzakSes) doluMs() float64 {
	d := u.ornek.Bekleyen() / 48
	if u.enYeniVar && once(u.oynat, u.enYeni) {
		d += float64(int32(u.enYeni-u.oynat)) / 48
	}
	return d
}

// Oku: karıştırıcı için 10 ms (ya da len(cikis)/2 çerçeve) iki kanallı ses.
func (u *UzakSes) Oku(cikis []float32) {
	u.mu.Lock()
	defer u.mu.Unlock()
	n := len(cikis) / 2
	simdi := u.simdi()
	if !u.basladi && !u.baslat(simdi) {
		clear(cikis)
		u.seviye = 0
		return
	}
	dolu := u.doluMs()
	if dolu > u.HedefMs+300 {
		u.eskiyiAt()
	}
	r := u.oran.Guncelle(u.doluMs(), simdi)
	gerek := float64(n)*r + yari + 2
	for u.ornek.Bekleyen() < gerek {
		if !u.cozSonraki(simdi) {
			break
		}
	}
	got := u.ornek.Uret(cikis, n, r)
	if got < n {
		clear(cikis[got*2:])
	}
	var e float64
	for _, x := range cikis {
		e += float64(x) * float64(x)
	}
	db := 10 * math.Log10(e/float64(len(cikis))+1e-12)
	u.seviye = math.Max(0, math.Min(1, (db+60)/50))
	if db > -48 {
		u.sonSesMs = simdi
	}
}

func (u *UzakSes) baslat(simdi float64) bool {
	if len(u.paket) == 0 {
		return false
	}
	enEski := uint32(0)
	ilk := true
	for ts := range u.paket {
		if ilk || once(ts, enEski) {
			enEski, ilk = ts, false
		}
	}
	dolu := float64(int32(u.enYeni-enEski)) / 48
	if dolu < u.HedefMs && simdi-u.ilkGelis < u.HedefMs {
		return false
	}
	u.oynat = enEski
	u.basladi = true
	u.ardisik = 0
	u.ornek.Sifirla()
	u.oran.Sifirla()
	u.coz.Sifirla()
	return true
}

// eskiyiAt: tampon hedefin çok üstünde: hedefe kadar olan eski sesi at.
func (u *UzakSes) eskiyiAt() {
	hedef := u.enYeni - uint32(u.HedefMs*48)
	var yeni uint32
	bulundu := false
	for ts := range u.paket {
		if once(ts, hedef) {
			delete(u.paket, ts)
			continue
		}
		if !bulundu || once(ts, yeni) {
			yeni, bulundu = ts, true
		}
	}
	if !bulundu {
		u.basladi = false
		return
	}
	u.oynat = yeni
	u.ornek.Sifirla()
	u.coz.Sifirla()
}

// cozSonraki: bir çerçeve çöz (ya da uydur) ve örnekleyiciye ver. Yapacak bir şey yoksa false.
func (u *UzakSes) cozSonraki(simdi float64) bool {
	if p, var_ := u.paket[u.oynat]; var_ {
		delete(u.paket, u.oynat)
		n, err := u.coz.Coz(p, u.tampon, 5760, false)
		if err == nil && n > 0 {
			u.ornek.Besle(u.tampon[:2*n])
			u.oynat += uint32(n)
			u.cerceve = n
			u.ardisik = 0
			u.cozulen++
			return true
		}
	}
	// Paket yok: sonraki paket varsa kayıp (yedekten kurtar ya da uydur).
	var sonraki uint32
	var_ := false
	for ts := range u.paket {
		if once(u.oynat, ts) && (!var_ || once(ts, sonraki)) {
			sonraki, var_ = ts, true
		}
	}
	if !var_ {
		// Hiç paket yok: gönderen durdu (sustu, paylaşımı bitti) ya da ağ takıldı. Kısa bir süre uydur
		// (ses yumuşakça söner), sonra dur ve yeniden tampon doldurmayı bekle.
		if simdi-u.sonGelis < 120 && u.ardisik < 6 {
			n, err := u.coz.Coz(nil, u.tampon, u.cerceve, false)
			if err == nil && n > 0 {
				u.ornek.Besle(u.tampon[:2*n])
				u.oynat += uint32(n)
				u.ardisik++
				u.uydurulan++
				return true
			}
		}
		u.basladi = false
		return false
	}
	bosluk := int(int32(sonraki - u.oynat))
	sure := min(bosluk, u.cerceve)
	sure -= sure % 120 // Opus 2,5 ms'nin katı ister
	if sure <= 0 {
		u.oynat = sonraki
		return true
	}
	fec := bosluk <= u.cerceve
	var n int
	var err error
	if fec {
		// Sonraki paketin içindeki önceki çerçevenin yedeği (yoksa çözücü kendisi uydurur).
		n, err = u.coz.Coz(u.paket[sonraki], u.tampon, sure, true)
		if err == nil {
			u.kurtarilan++
		}
	} else {
		n, err = u.coz.Coz(nil, u.tampon, sure, false)
		u.uydurulan++
	}
	if err != nil || n <= 0 {
		u.oynat = sonraki
		return true
	}
	u.ornek.Besle(u.tampon[:2*n])
	u.oynat += uint32(n)
	u.ardisik++
	return true
}

// Durum: akışın durumu ve sayaçları.
func (u *UzakSes) Durum() UzakDurum {
	u.mu.Lock()
	defer u.mu.Unlock()
	simdi := u.simdi()
	return UzakDurum{Aliniyor: simdi-u.sonGelis < 1000, Caliyor: u.basladi, Konusuyor: simdi-u.sonSesMs < 350, Seviye: u.seviye, TamponMs: u.doluMs(), HedefMs: u.HedefMs,
		Alinan: u.alinan, Gec: u.gec, Uydurulan: u.uydurulan, Kurtarilan: u.kurtarilan, Red: u.red}
}

func (u *UzakSes) Kapat() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.coz.Kapat()
	u.paket = map[uint32][]byte{}
	u.basladi = false
}
