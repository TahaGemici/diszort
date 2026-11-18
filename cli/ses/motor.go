// Package ses: Diszort'un ses motoru. Ses sunucusu (PulseAudio ya da PipeWire) ile konuşur:
// gelen sesleri karıştırıp çalar, mikrofonu işleyip (RNNoise → seviye → eşik) Opus'a kodlar,
// paylaşımda bilgisayarın sesini yakalayıp kodlar. Ağ (WebRTC) bu paketin dışındadır: paketler geri
// çağrılarla verilir, gelen paketler UzakSes'e konur.
//
// Paylaşımda "bilgisayarın sesi" uygulama uygulama yakalanır: ses sunucusundaki her çalma akışı
// (oyun, müzik, tarayıcı) ayrı kaydedilir ve karıştırılır; Diszort'un kendi çaldıkları (kanaldakilerin
// sesi, bildirim sesleri) bu listede olmadığı için paylaşıma hiç karışmaz. (Tarayıcı bunu bir
// "Monitor" aygıtından alıp kendi çaldığını sonradan süzgeçle çıkarmak zorunda; burada gerek yok.)
package ses

import (
	"errors"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TahaGemici/diszort/cli/gurultu"
	"github.com/TahaGemici/diszort/cli/pulse"
)

// Kaynak: karıştırıcıya giren bir gelen ses (bir eşin mikrofonu ya da paylaşımı).
type Kaynak struct {
	Ses    *UzakSes
	kazanc atomic.Uint64
}

// Kazanc: 0 = susturulmuş, 1 = olduğu gibi.
func (k *Kaynak) Kazanc(v float64)  { k.kazanc.Store(math.Float64bits(math.Max(0, v))) }
func (k *Kaynak) kazancAl() float64 { return math.Float64frombits(k.kazanc.Load()) }

// MikAyari: mikrofonun yolu.
type MikAyari struct {
	Aygit      string  // ses sunucusundaki adı ("" = varsayılan)
	Kazanc     float64 // 1 = %100
	EsikDb     float64 // NaN = eşik kapalı
	YankiEngel bool    // hoparlörden çalınanı mikrofondan çıkar
}

// Motor: ses motoru. Yöntemleri her goroutine'den çağrılabilir.
type Motor struct {
	mu        sync.Mutex
	pb        *pulse.Baglanti
	kaynaklar map[*Kaynak]bool
	tonlar    [][]float32
	sagir     atomic.Bool

	// İstenen durum (denetçi buna göre akışları açar, kapatır, yeniden açar).
	cikisIstendi bool
	cikisAygit   string
	mikIstendi   bool
	mikAyar      MikAyari
	payIstendi   bool
	payAygit     string

	calma        *pulse.Calma
	cikisHedefMs int
	sonBosalma   int64
	mik          *mikrofon
	pay          *paylasim
	uyandir      chan struct{}
	sonHata      map[string]string
	mikBps       atomic.Int64
	mikKay       atomic.Int64
	payBps       atomic.Int64
	payKay       atomic.Int64

	// MikPaketi: mikrofonun 20 ms'lik Opus çerçevesi. basla: sessizlikten sonraki ilk paket.
	MikPaketi func(veri []byte, sure int, basla bool)
	// PaylasimPaketi: paylaşılan sesin (stereo) Opus çerçevesi.
	PaylasimPaketi func(veri []byte, sure int, basla bool)
	// Bildir: kullanıcıya söylenecek (hata=true: sorun).
	Bildir func(metin string, hata bool)
	// Gunluk: teşhis.
	Gunluk func(string)
}

func YeniMotor() *Motor {
	m := &Motor{kaynaklar: map[*Kaynak]bool{}, cikisHedefMs: 50, uyandir: make(chan struct{}, 1), sonHata: map[string]string{}}
	m.mikAyar = MikAyari{Kazanc: 1, EsikDb: math.NaN()}
	go m.denetci()
	return m
}

func (m *Motor) bildir(anahtar, metin string, hata bool) {
	m.mu.Lock()
	ayni := m.sonHata[anahtar] == metin
	m.sonHata[anahtar] = metin
	m.mu.Unlock()
	if ayni || metin == "" {
		return
	}
	if m.Bildir != nil {
		m.Bildir(metin, hata)
	}
}

func (m *Motor) gunluk(f string, a ...any) {
	if m.Gunluk != nil {
		m.Gunluk(fmt.Sprintf(f, a...))
	}
}

func (m *Motor) durt() {
	select {
	case m.uyandir <- struct{}{}:
	default:
	}
}

// pulseAl: ses sunucusu bağlantısı (yoksa kurar).
func (m *Motor) pulseAl() (*pulse.Baglanti, error) {
	m.mu.Lock()
	pb := m.pb
	m.mu.Unlock()
	if pb != nil && !pb.Kapali() {
		return pb, nil
	}
	pb, err := pulse.Baglan("Diszort")
	if err != nil {
		return nil, err
	}
	pb.OlayGeldi = func(o pulse.Olay) {
		if o.Tesis == pulse.TesisCalmaAkisi || o.Tesis == pulse.TesisSunucu || o.Tesis == pulse.TesisCikis {
			m.mu.Lock()
			p := m.pay
			m.mu.Unlock()
			if p != nil {
				p.durt()
			}
		}
		if o.Tesis == pulse.TesisSunucu || o.Tur == "silindi" {
			m.durt()
		}
	}
	pb.Kapandi = func(error) { m.durt() }
	if err := pb.AboneOl(pulse.MaskeHepsiBizimki); err != nil {
		m.gunluk("ses olaylarına abone olunamadı: %v", err)
	}
	m.mu.Lock()
	m.pb = pb
	m.mu.Unlock()
	return pb, nil
}

// ---------------------------------------------------------------- istenen durum

// Cikis: hoparlöre çalmayı aç/kapat (sesli kanaldayken açık). aygit: "" = varsayılan.
func (m *Motor) Cikis(acik bool, aygit string) {
	m.mu.Lock()
	degisti := m.cikisAygit != aygit
	m.cikisIstendi, m.cikisAygit = acik, aygit
	c := m.calma
	m.mu.Unlock()
	if degisti && c != nil {
		c.Kapat()
	}
	m.durt()
}

// Mikrofon: mikrofonu aç/kapat ya da ayarını değiştir (seviye ve eşik konuşurken de geçerli).
func (m *Motor) Mikrofon(acik bool, a MikAyari) {
	m.mu.Lock()
	aygitDegisti := m.mikAyar.Aygit != a.Aygit || m.mikAyar.YankiEngel != a.YankiEngel
	m.mikIstendi, m.mikAyar = acik, a
	mk := m.mik
	m.mu.Unlock()
	if mk != nil {
		if aygitDegisti || !acik {
			mk.kapat()
		} else {
			mk.yol.Ayarla(a.Kazanc, a.EsikDb)
		}
	}
	m.durt()
}

// Paylasim: bilgisayarın sesini paylaşmayı aç/kapat. aygit "" = uygulamaların sesi (Diszort hariç);
// bir giriş adı = o aygıtın sesi.
func (m *Motor) Paylasim(acik bool, aygit string) {
	m.mu.Lock()
	degisti := m.payAygit != aygit
	m.payIstendi, m.payAygit = acik, aygit
	p := m.pay
	if p != nil && (degisti || !acik) {
		m.pay = nil
	}
	m.mu.Unlock()
	if p != nil && (degisti || !acik) {
		p.kapat()
	}
	m.durt()
}

// Sagir: gelen sesleri kapat.
func (m *Motor) Sagir(v bool) { m.sagir.Store(v) }

func (m *Motor) KaynakEkle(k *Kaynak) {
	m.mu.Lock()
	m.kaynaklar[k] = true
	m.mu.Unlock()
}

func (m *Motor) KaynakCikar(k *Kaynak) {
	m.mu.Lock()
	delete(m.kaynaklar, k)
	m.mu.Unlock()
}

// denetci: istenen durumla gerçek durumu eşitler (yarım saniyede bir ya da dürtülünce).
func (m *Motor) denetci() {
	tik := time.NewTicker(500 * time.Millisecond)
	defer tik.Stop()
	for {
		select {
		case <-tik.C:
		case <-m.uyandir:
		}
		m.esitle()
	}
}

func (m *Motor) esitle() {
	m.mu.Lock()
	cikisIstendi, cikisAygit := m.cikisIstendi, m.cikisAygit
	mikIstendi, mikAyar := m.mikIstendi, m.mikAyar
	payIstendi, payAygit := m.payIstendi, m.payAygit
	calma, mk, p := m.calma, m.mik, m.pay
	m.mu.Unlock()

	if !cikisIstendi && !mikIstendi && !payIstendi {
		if calma != nil {
			calma.Kapat()
			m.mu.Lock()
			m.calma = nil
			m.mu.Unlock()
		}
		return
	}
	pb, err := m.pulseAl()
	if err != nil {
		m.bildir("pulse", "Ses sunucusuna ulaşılamıyor (PulseAudio/PipeWire): "+err.Error(), true)
		return
	}
	m.bildir("pulse", "", false)

	// Çıkış
	if cikisIstendi && (calma == nil || calma.Kapali()) {
		m.cikisAc(pb, cikisAygit)
	} else if !cikisIstendi && calma != nil {
		calma.Kapat()
		m.mu.Lock()
		m.calma = nil
		m.mu.Unlock()
	} else if calma != nil {
		// Boşalma (alt taşma) olduysa tampon büyütülür (en çok 150 ms) ve akış yeniden açılır.
		b := calma.Bosalma.Load()
		if b > m.sonBosalma && m.cikisHedefMs < 150 && m.calanVar() {
			m.sonBosalma = b
			m.cikisHedefMs += 20
			m.gunluk("çıkış boşaldı: tampon %d ms", m.cikisHedefMs)
			calma.Kapat()
			m.cikisAc(pb, cikisAygit)
		} else {
			m.sonBosalma = b
		}
	}

	// Mikrofon
	if mikIstendi && (mk == nil || mk.bitti()) {
		m.mikAc(pb, mikAyar)
	} else if !mikIstendi && mk != nil {
		mk.kapat()
		m.mu.Lock()
		m.mik = nil
		m.mu.Unlock()
	}

	// Paylaşım
	if payIstendi && p == nil {
		p = &paylasim{m: m, aygit: payAygit, kaynaklar: map[uint32]*payKaynak{}, durtme: make(chan struct{}, 1), dur: make(chan struct{})}
		kod, err := YeniKodlayici(2, true)
		if err != nil {
			m.bildir("pay", "Paylaşım kodlayıcısı kurulamadı: "+err.Error(), true)
			return
		}
		p.kod = kod
		m.mu.Lock()
		m.pay = p
		m.mu.Unlock()
		go p.dongu()
	}
	if p != nil {
		p.durt()
	}
}

func (m *Motor) calanVar() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.tonlar) > 0 {
		return true
	}
	for k := range m.kaynaklar {
		if k.Ses.Durum().Caliyor {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- çıkış: karıştırıcı

func (m *Motor) cikisAc(pb *pulse.Baglanti, aygit string) {
	c, err := pb.CalmaAc(aygit, 2, m.cikisHedefMs, "Diszort", nil)
	if err != nil && aygit != "" {
		m.bildir("cikis", fmt.Sprintf("Hoparlör (%s) açılamadı: %v; varsayılan kullanılıyor.", aygit, err), true)
		c, err = pb.CalmaAc("", 2, m.cikisHedefMs, "Diszort", nil)
	}
	if err != nil {
		m.bildir("cikis", "Hoparlör açılamadı: "+err.Error(), true)
		return
	}
	m.bildir("cikis", "", false)
	m.mu.Lock()
	m.calma = c
	m.mu.Unlock()
	go m.cikisDongusu(c)
}

func (m *Motor) cikisDongusu(c *pulse.Calma) {
	tik := time.NewTicker(10 * time.Millisecond)
	defer tik.Stop()
	blok := make([]float32, 960)
	gecici := make([]float32, 960)
	for {
		select {
		case <-c.Bitti:
			return
		case <-tik.C:
		}
		// Uzun bir duraklamadan sonra (makine uyudu) birikmiş isteği bir anda doldurmak yerine en çok
		// 6 blok yaz: ses sunucusu kaçanı zaten sessizlikle geçti.
		for i := 0; i < 6 && c.Kredi() >= 480; i++ {
			m.karistir(blok, gecici)
			if err := c.Yaz(blok); err != nil {
				return
			}
		}
	}
}

// karistir: 10 ms (480 çerçeve, iki kanal).
func (m *Motor) karistir(cikis, gecici []float32) {
	clear(cikis)
	m.mu.Lock()
	kaynaklar := make([]*Kaynak, 0, len(m.kaynaklar))
	for k := range m.kaynaklar {
		kaynaklar = append(kaynaklar, k)
	}
	var tonlar [][]float32
	if len(m.tonlar) > 0 {
		tonlar = m.tonlar
		m.tonlar = nil
		for _, t := range tonlar {
			if len(t) > len(cikis) {
				m.tonlar = append(m.tonlar, t[len(cikis):])
			}
		}
	}
	m.mu.Unlock()
	sagir := m.sagir.Load()
	for _, k := range kaynaklar {
		k.Ses.Oku(gecici)
		g := float32(k.kazancAl())
		if sagir || g == 0 {
			continue
		}
		for i, x := range gecici {
			cikis[i] += x * g
		}
	}
	for _, t := range tonlar {
		n := min(len(t), len(cikis))
		for i := 0; i < n; i++ {
			cikis[i] += t[i]
		}
	}
	// Yumuşak sınırlayıcı: taşma cızırtısı olmasın (döngü aşağıda); sonra çalınan yankı engelleyiciye.
	defer func() {
		m.mu.Lock()
		mk := m.mik
		hedef := m.cikisHedefMs
		m.mu.Unlock()
		if mk != nil && mk.yanki != nil {
			mk.yanki.calindi(cikis, hedef+10)
		}
	}()
	for i, x := range cikis {
		if x > 0.95 || x < -0.95 {
			cikis[i] = float32(math.Tanh(float64(x)))
		}
	}
}

// ---------------------------------------------------------------- bildirim sesleri

var sesler = map[string][][2]float64{
	"giris":      {{523.25, 0}, {783.99, 0.09}},
	"cikis":      {{783.99, 0}, {523.25, 0.09}},
	"kisi-girdi": {{659.25, 0}, {880, 0.08}},
	"kisi-cikti": {{880, 0}, {659.25, 0.08}},
	"sessiz":     {{392, 0}},
	"acik":       {{587.33, 0}},
	"kapi":       {{740, 0}, {740, 0.16}},
}

// Ton: bildirim sesi (web'dekiyle aynı notalar: sinüs, 15 ms'de 0,06'ya çıkıp 170 ms'de söner).
// Hoparlör açık değilse çalınmaz.
func (m *Motor) Ton(tur string) {
	notalar := sesler[tur]
	if notalar == nil {
		return
	}
	m.mu.Lock()
	acik := m.calma != nil && !m.calma.Kapali()
	m.mu.Unlock()
	if !acik {
		return
	}
	son := 0.0
	for _, n := range notalar {
		son = math.Max(son, n[1]+0.2)
	}
	t := make([]float32, int(son*48000)*2)
	for _, n := range notalar {
		bas := int(n[1] * 48000)
		for i := 0; i < int(0.2*48000) && bas+i < len(t)/2; i++ {
			s := float64(i) / 48000
			var g float64
			if s < 0.015 {
				g = 0.06 * s / 0.015
			} else {
				g = 0.06 * math.Pow(0.0001/0.06, (s-0.015)/(0.17-0.015))
			}
			v := float32(g * math.Sin(2*math.Pi*n[0]*s))
			t[2*(bas+i)] += v
			t[2*(bas+i)+1] += v
		}
	}
	m.mu.Lock()
	m.tonlar = append(m.tonlar, t)
	m.mu.Unlock()
}

// ---------------------------------------------------------------- mikrofon

type mikrofon struct {
	yanki    *yankiEngeli
	m        *Motor
	kayit    *pulse.Kayit
	yol      *gurultu.Yol
	kod      *Kodlayici
	bittiMi  atomic.Bool
	kapandi  sync.Once
	sonSes   atomic.Int64
	Aygit    string
	islemMu  sync.Mutex // işleme (ses sunucusunun okuma goroutine'inde) ve kapatma arasında
	kapali   bool
	bekleyen []float32
	cerceve  []float32
	basla    bool
}

func (m *Motor) mikAc(pb *pulse.Baglanti, a MikAyari) {
	yol, err := gurultu.Yeni(a.Kazanc, a.EsikDb)
	if err != nil {
		m.bildir("mik", "Gürültü bastırma kurulamadı: "+err.Error(), true)
		return
	}
	kod, err := YeniKodlayici(1, false)
	if err != nil {
		yol.Kapat()
		m.bildir("mik", "Opus kodlayıcısı kurulamadı: "+err.Error(), true)
		return
	}
	mk := &mikrofon{m: m, yol: yol, kod: kod, cerceve: make([]float32, 0, 960), basla: true}
	if a.YankiEngel {
		if y, err := yeniYankiEngeli(); err == nil {
			mk.yanki = y
		} else {
			m.bildir("yanki", "Yankı engelleme kurulamadı: "+err.Error(), true)
		}
	}
	// Mikrofonun sesi gelir gelmez işlenir (ayrı bir goroutine'e aktarmak her 10 ms'de bir uyandırma
	// demek): RNNoise + Opus bir çerçevede ~0,3 ms.
	k, err := pb.KayitAc(a.Aygit, 1, 10, pulse.TumAkislar, "Diszort mikrofon", mk.isle)
	if err != nil && a.Aygit != "" {
		m.bildir("mik", fmt.Sprintf("Seçili mikrofon (%s) açılamadı: %v; varsayılan kullanılıyor.", a.Aygit, err), true)
		k, err = pb.KayitAc("", 1, 10, pulse.TumAkislar, "Diszort mikrofon", mk.isle)
	}
	if err != nil {
		mk.serbest()
		m.bildir("mik", "Mikrofon açılamadı: "+err.Error(), true)
		return
	}
	m.bildir("mik", "", false)
	mk.kayit = k
	mk.Aygit = k.Aygit
	mk.sonSes.Store(-1)
	m.mu.Lock()
	m.mik = mk
	m.mu.Unlock()
	go func() {
		// Aygıt çıkarıldı / ses sunucusu kapandı: denetçi yeniden açsın.
		<-k.Bitti
		mk.bittiMi.Store(true)
		mk.serbest()
		m.durt()
	}()
}

func (mk *mikrofon) bitti() bool { return mk.bittiMi.Load() || mk.kayit.Kapali() }

func (mk *mikrofon) kapat() {
	mk.kapandi.Do(func() {
		mk.bittiMi.Store(true)
		mk.kayit.Kapat()
		mk.serbest()
	})
}

// serbest: C durumlarını bırak (işlem sürüyorsa bitmesini bekler).
func (mk *mikrofon) serbest() {
	mk.islemMu.Lock()
	defer mk.islemMu.Unlock()
	if mk.kapali {
		return
	}
	mk.kapali = true
	mk.yol.Kapat()
	if mk.yanki != nil {
		mk.yanki.kapat()
	}
	mk.kod.Kapat()
}

// isle: ses sunucusundan gelen mikrofon sesi (okuma goroutine'inde).
func (mk *mikrofon) isle(o []float32) {
	mk.islemMu.Lock()
	defer mk.islemMu.Unlock()
	if mk.kapali {
		return
	}
	mk.bekleyen = append(mk.bekleyen, o...)
	for len(mk.bekleyen) >= gurultu.Cerceve {
		c := mk.bekleyen[:gurultu.Cerceve]
		if mk.yanki != nil {
			mk.yanki.isle(c)
		}
		mk.yol.Isle(c)
		var e float64
		for _, x := range c {
			e += float64(x) * float64(x)
		}
		if 10*math.Log10(e/gurultu.Cerceve+1e-12) > -48 {
			mk.sonSes.Store(time.Now().UnixMilli())
		}
		mk.cerceve = append(mk.cerceve, c...)
		mk.bekleyen = mk.bekleyen[gurultu.Cerceve:]
		if len(mk.cerceve) >= 960 {
			if b := mk.m.mikBps.Load(); b > 0 {
				mk.kod.BitHizi(int(b))
			}
			mk.kod.Kayip(int(mk.m.mikKay.Load()))
			p, err := mk.kod.Kodla(mk.cerceve[:960])
			mk.cerceve = mk.cerceve[:0]
			if err == nil && mk.m.MikPaketi != nil {
				mk.m.MikPaketi(p, 960, mk.basla)
				mk.basla = false
			}
		}
	}
	if len(mk.bekleyen) == 0 {
		mk.bekleyen = mk.bekleyen[:0]
	} else if cap(mk.bekleyen) > 8*gurultu.Cerceve {
		mk.bekleyen = append([]float32(nil), mk.bekleyen...)
	}
}

// MikDurumu: mikrofon açık mı, konuşuyor mu, RNNoise'un son ölçümü.
type MikDurumu struct {
	Acik      bool
	Aygit     string
	Konusuyor bool
	Olcum     gurultu.Olcum
}

func (m *Motor) MikDurumu() MikDurumu {
	m.mu.Lock()
	mk := m.mik
	m.mu.Unlock()
	if mk == nil || mk.bitti() {
		return MikDurumu{}
	}
	son := mk.sonSes.Load()
	return MikDurumu{Acik: true, Aygit: mk.Aygit, Konusuyor: son > 0 && time.Now().UnixMilli()-son < 350, Olcum: mk.yol.SonOlcum()}
}

// MikBitHizi: mikrofonun Opus bit hızı (bit/sn) ve ağdaki kayıp yüzdesi.
func (m *Motor) MikBitHizi(bps, kayip int) {
	// Kodlayıcı mikrofonun goroutine'inde kullanılıyor: ayar orada, bir sonraki çerçeveden önce uygulanır.
	m.mikBps.Store(int64(bps))
	m.mikKay.Store(int64(kayip))
}

// ---------------------------------------------------------------- paylaşım (bilgisayarın sesi)

type payKaynak struct {
	ad      string
	kayit   *pulse.Kayit
	mu      sync.Mutex
	halka   []float32
	basladi bool
}

type paylasim struct {
	m         *Motor
	aygit     string
	mu        sync.Mutex
	kaynaklar map[uint32]*payKaynak
	kod       *Kodlayici
	durtme    chan struct{}
	dur       chan struct{}
	kapandi   sync.Once
}

const payTek = 0xfffffffe // aygıt kipinde tek kaynağın anahtarı

func (p *paylasim) durt() {
	select {
	case p.durtme <- struct{}{}:
	default:
	}
}

func (p *paylasim) kapat() {
	p.kapandi.Do(func() { close(p.dur) })
}

// esitle: uygulama kipinde ses sunucusundaki çalma akışlarını (Diszort'unkiler hariç) kaydet.
func (p *paylasim) esitle() {
	pb, err := p.m.pulseAl()
	if err != nil {
		return
	}
	istenen := map[uint32]string{}
	if p.aygit != "" {
		istenen[payTek] = p.aygit
	} else {
		cikis := p.m.cikisIndeksi(pb)
		akislar, err := pb.CalmaAkislari()
		if err != nil {
			p.m.gunluk("çalma akışları okunamadı: %v", err)
			return
		}
		pid := fmt.Sprint(os.Getpid())
		for _, c := range akislar {
			if c.Istemci == pb.IstemciNo || c.Ozellikler["application.process.id"] == pid {
				continue
			}
			if cikis != pulse.TumAkislar && c.Cikis != cikis {
				continue
			}
			istenen[c.Indeks] = c.Uygulama()
		}
	}
	p.mu.Lock()
	var kapatilacak []*payKaynak
	for no, k := range p.kaynaklar {
		if _, var_ := istenen[no]; !var_ || k.kayit.Kapali() {
			kapatilacak = append(kapatilacak, k)
			delete(p.kaynaklar, no)
		}
	}
	var acilacak []uint32
	for no := range istenen {
		if p.kaynaklar[no] == nil {
			acilacak = append(acilacak, no)
		}
	}
	p.mu.Unlock()
	for _, k := range kapatilacak {
		k.kayit.Kapat()
	}
	for _, no := range acilacak {
		k := &payKaynak{ad: istenen[no]}
		veri := func(o []float32) {
			k.mu.Lock()
			k.halka = append(k.halka, o...)
			// Çok birikirse (kodlayıcı takıldı) eskisi atılır: en çok 300 ms.
			if fazla := len(k.halka) - 2*48000*300/1000; fazla > 0 {
				k.halka = k.halka[fazla:]
			}
			k.mu.Unlock()
		}
		var kayit *pulse.Kayit
		var err error
		if no == payTek {
			kayit, err = pb.KayitAc(p.aygit, 2, 10, pulse.TumAkislar, "Diszort paylaşım", veri)
		} else {
			kayit, err = pb.KayitAc("", 2, 10, no, "Diszort paylaşım: "+k.ad, veri)
		}
		if err != nil {
			if no == payTek {
				p.m.bildir("pay", "Ses aygıtı açılamadı: "+err.Error(), true)
			} else if !pulse.YokMu(err) {
				p.m.gunluk("%s yakalanamadı: %v", k.ad, err)
			}
			continue
		}
		k.kayit = kayit
		p.mu.Lock()
		p.kaynaklar[no] = k
		p.mu.Unlock()
	}
}

// Kaynaklar: şu an paylaşılan uygulamalar (ya da aygıt).
func (m *Motor) PaylasimKaynaklari() []string {
	m.mu.Lock()
	p := m.pay
	m.mu.Unlock()
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var adlar []string
	for _, k := range p.kaynaklar {
		adlar = append(adlar, k.ad)
	}
	sort.Strings(adlar)
	return adlar
}

// PaylasimBitHizi: paylaşılan sesin Opus bit hızı (bit/sn) ve kayıp yüzdesi.
func (m *Motor) PaylasimBitHizi(bps, kayip int) {
	m.payBps.Store(int64(bps))
	m.payKay.Store(int64(kayip))
}

func (p *paylasim) dongu() {
	defer func() {
		p.mu.Lock()
		for no, k := range p.kaynaklar {
			k.kayit.Kapat()
			delete(p.kaynaklar, no)
		}
		p.mu.Unlock()
		p.kod.Kapat()
	}()
	p.esitle()
	tik := time.NewTicker(20 * time.Millisecond)
	defer tik.Stop()
	karisim := make([]float32, 1920)
	basla := true
	sonraki := time.Now()
	for {
		select {
		case <-p.dur:
			return
		case <-p.durtme:
			p.esitle()
			continue
		case <-tik.C:
		}
		// Saat kaymasın: her 20 ms için bir çerçeve (geciken tik telafi edilir, en çok 3).
		for k := 0; k < 3 && !time.Now().Before(sonraki); k++ {
			sonraki = sonraki.Add(20 * time.Millisecond)
			clear(karisim)
			p.mu.Lock()
			kaynaklar := make([]*payKaynak, 0, len(p.kaynaklar))
			for _, s := range p.kaynaklar {
				kaynaklar = append(kaynaklar, s)
			}
			p.mu.Unlock()
			for _, s := range kaynaklar {
				s.mu.Lock()
				// Her kaynak 30 ms birikince okunmaya başlar (parça parça gelir); boşalırsa yeniden bekler.
				if !s.basladi && len(s.halka) >= 2*48000*30/1000 {
					s.basladi = true
				}
				if s.basladi {
					n := min(len(s.halka), len(karisim))
					for i := 0; i < n; i++ {
						karisim[i] += s.halka[i]
					}
					s.halka = s.halka[n:]
					if n < len(karisim) {
						s.basladi = false
					}
					// Saat farkı: 120 ms'yi geçerse 40 ms'ye indir.
					if len(s.halka) > 2*48000*120/1000 {
						s.halka = s.halka[len(s.halka)-2*48000*40/1000:]
					}
				}
				s.mu.Unlock()
			}
			for i, x := range karisim {
				if x > 0.98 || x < -0.98 {
					karisim[i] = float32(math.Tanh(float64(x)))
				}
			}
			if b := p.m.payBps.Load(); b > 0 {
				p.kod.BitHizi(int(b))
			}
			p.kod.Kayip(int(p.m.payKay.Load()))
			paket, err := p.kod.Kodla(karisim)
			if err == nil && p.m.PaylasimPaketi != nil {
				p.m.PaylasimPaketi(paket, 960, basla)
				basla = false
			}
		}
		if time.Since(sonraki) > 200*time.Millisecond {
			sonraki = time.Now()
		}
	}
}

// cikisIndeksi: Diszort'un çaldığı çıkışın dizini (paylaşılacak uygulamalar o çıkıştakiler).
func (m *Motor) cikisIndeksi(pb *pulse.Baglanti) uint32 {
	m.mu.Lock()
	c := m.calma
	m.mu.Unlock()
	ad := ""
	if c != nil && !c.Kapali() {
		ad = c.Aygit
	}
	if ad == "" {
		bilgi, err := pb.SunucuBilgisi()
		if err != nil {
			return pulse.TumAkislar
		}
		ad = bilgi.VarsayilanCikis
	}
	cikislar, err := pb.Cikislar()
	if err != nil {
		return pulse.TumAkislar
	}
	for _, a := range cikislar {
		if a.Ad == ad {
			return a.Indeks
		}
	}
	return pulse.TumAkislar
}

// ---------------------------------------------------------------- aygıtlar

// AygitBilgisi: listede gösterilen aygıt.
type AygitBilgisi struct {
	Ad         string
	Aciklama   string
	Varsayilan bool
	Monitor    bool
}

// Aygitlar: mikrofonlar (monitörler dahil, en sonda) ve hoparlörler.
func (m *Motor) Aygitlar() (girisler, cikislar []AygitBilgisi, err error) {
	pb, err := m.pulseAl()
	if err != nil {
		return nil, nil, err
	}
	bilgi, err := pb.SunucuBilgisi()
	if err != nil {
		return nil, nil, err
	}
	g, err := pb.Girisler()
	if err != nil {
		return nil, nil, err
	}
	c, err := pb.Cikislar()
	if err != nil {
		return nil, nil, err
	}
	for _, a := range g {
		girisler = append(girisler, AygitBilgisi{Ad: a.Ad, Aciklama: a.Aciklama, Varsayilan: a.Ad == bilgi.VarsayilanGiris, Monitor: a.MonitorMu})
	}
	sort.SliceStable(girisler, func(i, j int) bool { return !girisler[i].Monitor && girisler[j].Monitor })
	for _, a := range c {
		cikislar = append(cikislar, AygitBilgisi{Ad: a.Ad, Aciklama: a.Aciklama, Varsayilan: a.Ad == bilgi.VarsayilanCikis})
	}
	return girisler, cikislar, nil
}

// AygitBul: ad, açıklama ya da sıra numarasıyla (1'den) bir aygıt bul.
func AygitBul(liste []AygitBilgisi, ara string) (AygitBilgisi, error) {
	ara = strings.TrimSpace(ara)
	var n int
	if _, err := fmt.Sscanf(ara, "%d", &n); err == nil && fmt.Sprint(n) == ara {
		if n >= 1 && n <= len(liste) {
			return liste[n-1], nil
		}
		return AygitBilgisi{}, fmt.Errorf("%d numaralı aygıt yok", n)
	}
	kucuk := strings.ToLower(ara)
	var adaylar []AygitBilgisi
	for _, a := range liste {
		if a.Ad == ara || strings.EqualFold(a.Aciklama, ara) {
			return a, nil
		}
		if strings.Contains(strings.ToLower(a.Aciklama), kucuk) || strings.Contains(strings.ToLower(a.Ad), kucuk) {
			adaylar = append(adaylar, a)
		}
	}
	if len(adaylar) == 1 {
		return adaylar[0], nil
	}
	if len(adaylar) > 1 {
		return AygitBilgisi{}, errors.New("birden çok aygıt uyuyor; numarasını yaz")
	}
	return AygitBilgisi{}, errors.New("böyle bir aygıt yok")
}

// Kapat: her şeyi kapat (program çıkarken).
func (m *Motor) Kapat() {
	m.Paylasim(false, "")
	m.Mikrofon(false, m.mikAyar)
	m.mu.Lock()
	m.cikisIstendi = false
	c := m.calma
	m.calma = nil
	pb := m.pb
	m.mu.Unlock()
	if c != nil {
		c.Kapat()
	}
	if pb != nil {
		time.Sleep(50 * time.Millisecond)
		pb.Kapat()
	}
}
