// Package pulse: PulseAudio yerel protokolünün saf Go istemcisi.
//
// Linux masaüstlerinde ses sunucusu ya PulseAudio'dur ya da PipeWire'ın PulseAudio uyumluluk katmanı
// (pipewire-pulse); ikisi de aynı protokolü aynı Unix soketinde ($XDG_RUNTIME_DIR/pulse/native)
// konuşur. libpulse yerine protokolün kendisi konuşulur: yerel kitaplık gerekmez.
//
// Kapsam: kimlik doğrulama, aygıt listeleri (çıkışlar, girişler), uygulamaların çalma akışları,
// varsayılanlar, değişiklik olayları, çalma ve kayıt akışları (veri soketten akar), tek bir
// uygulamanın akışını kaydetme (paylaşım: Diszort'un kendi çaldığı karışmaz).
//
// Protokol: her paket 20 baytlık bir başlıkla başlar (uzunluk, kanal, konum ×2, bayraklar; büyük
// uçlu). Kanal 0xFFFFFFFF ise yük bir komuttur ("tagstruct": her değerin önünde bir tür baytı),
// değilse o akışın ham sesidir. Sürüm 32 konuşulur (PulseAudio 6+ ve pipewire-pulse).
package pulse

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	surum    = 32
	gecersiz = 0xffffffff
	sesNorm  = 0x10000

	kHata          = 0
	kYanit         = 2
	kCalmaAc       = 3
	kCalmaSil      = 4
	kKayitAc       = 5
	kKayitSil      = 6
	kKimlik        = 8
	kIstemciAdi    = 9
	kSunucuBilgisi = 20
	kCikisListesi  = 22
	kGirisListesi  = 24
	kCalmaListesi  = 30
	kAbone         = 35
	kIstek         = 61
	kTasma         = 62
	kBosalma       = 63
	kCalmaOldu     = 64
	kKayitOldu     = 65
	kAboneOlayi    = 66
	kCalmaAskida   = 76
	kKayitAskida   = 77
	kCalmaTasindi  = 78
	kKayitTasindi  = 79
	kBasladi       = 86

	bicimFloat32 = 5
)

// Abonelik maskesi (PA_SUBSCRIPTION_MASK_*).
const (
	MaskeCikis        = 0x01
	MaskeGiris        = 0x02
	MaskeCalmaAkisi   = 0x04
	MaskeSunucu       = 0x80
	MaskeKart         = 0x200
	MaskeHepsiBizimki = MaskeCikis | MaskeGiris | MaskeCalmaAkisi | MaskeSunucu | MaskeKart
)

// Olay tesisleri.
const (
	TesisCikis      = 0
	TesisGiris      = 1
	TesisCalmaAkisi = 2
	TesisSunucu     = 7
)

var hataAdlari = []string{"tamam", "erişim reddedildi", "bilinmeyen komut", "geçersiz değer", "zaten var", "böyle bir şey yok", "bağlantı reddedildi", "protokol hatası", "zaman aşımı", "kimlik anahtarı yok", "iç hata", "bağlantı kesildi", "öldürüldü", "geçersiz sunucu", "modül başlatılamadı", "kötü durum", "veri yok", "sürüm uyuşmuyor", "çok büyük", "desteklenmiyor", "bilinmiyor", "uzantı yok", "eskimiş", "gerçeklenmemiş", "istemci çatallandı", "giriş/çıkış hatası", "meşgul"}

// Hata: ses sunucusunun döndürdüğü hata.
type Hata struct{ Kod uint32 }

func (h *Hata) Error() string {
	if int(h.Kod) < len(hataAdlari) {
		return "ses sunucusu: " + hataAdlari[h.Kod]
	}
	return fmt.Sprintf("ses sunucusu: hata %d", h.Kod)
}

// YokMu: istenen şey (aygıt, akış) yok.
func YokMu(h error) bool {
	var p *Hata
	return errors.As(h, &p) && p.Kod == 5
}

// ---------------------------------------------------------------- tagstruct

type yazar struct{ b bytes.Buffer }

func (w *yazar) u32(v uint32) *yazar {
	w.b.WriteByte('L')
	binary.Write(&w.b, binary.BigEndian, v)
	return w
}
func (w *yazar) u8(v uint8) *yazar { w.b.WriteByte('B'); w.b.WriteByte(v); return w }
func (w *yazar) metin(s string) *yazar {
	w.b.WriteByte('t')
	w.b.WriteString(s)
	w.b.WriteByte(0)
	return w
}
func (w *yazar) bos() *yazar { w.b.WriteByte('N'); return w }
func (w *yazar) metinYaDaBos(s string) *yazar {
	if s == "" {
		return w.bos()
	}
	return w.metin(s)
}
func (w *yazar) mantik(v bool) *yazar {
	if v {
		w.b.WriteByte('1')
	} else {
		w.b.WriteByte('0')
	}
	return w
}
func (w *yazar) bayt(v []byte) *yazar {
	w.b.WriteByte('x')
	binary.Write(&w.b, binary.BigEndian, uint32(len(v)))
	w.b.Write(v)
	return w
}
func (w *yazar) ornekBicimi(kanal uint8, hiz uint32) *yazar {
	w.b.WriteByte('a')
	w.b.WriteByte(bicimFloat32)
	w.b.WriteByte(kanal)
	binary.Write(&w.b, binary.BigEndian, hiz)
	return w
}
func (w *yazar) kanalHaritasi(kanal uint8) *yazar {
	w.b.WriteByte('m')
	w.b.WriteByte(kanal)
	if kanal == 1 {
		w.b.WriteByte(0)
	} else {
		w.b.WriteByte(1)
		w.b.WriteByte(2)
	}
	return w
}
func (w *yazar) sesDuzeyleri(kanal uint8) *yazar {
	w.b.WriteByte('v')
	w.b.WriteByte(kanal)
	for i := 0; i < int(kanal); i++ {
		binary.Write(&w.b, binary.BigEndian, uint32(sesNorm))
	}
	return w
}
func (w *yazar) ozellikler(o map[string]string) *yazar {
	w.b.WriteByte('P')
	for k, v := range o {
		d := append([]byte(v), 0)
		w.metin(k).u32(uint32(len(d))).bayt(d)
	}
	w.b.WriteByte('N')
	return w
}

type okur struct {
	b []byte
	i int
	h error
}

func (r *okur) bitti() bool { return r.h != nil || r.i >= len(r.b) }
func (r *okur) hata(f string, a ...any) {
	if r.h == nil {
		r.h = fmt.Errorf("ses sunucusu yanıtı: "+f, a...)
	}
}
func (r *okur) bekle(t byte) bool {
	if r.h != nil {
		return false
	}
	if r.i >= len(r.b) || r.b[r.i] != t {
		got := byte(0)
		if r.i < len(r.b) {
			got = r.b[r.i]
		}
		r.hata("beklenmedik tür 0x%x (beklenen 0x%x, konum %d)", got, t, r.i)
		return false
	}
	r.i++
	return true
}
func (r *okur) yeter(n int) bool {
	if r.h == nil && r.i+n > len(r.b) {
		r.hata("yarım")
	}
	return r.h == nil
}
func (r *okur) u32() uint32 {
	if !r.bekle('L') || !r.yeter(4) {
		return 0
	}
	v := binary.BigEndian.Uint32(r.b[r.i:])
	r.i += 4
	return v
}
func (r *okur) metin() string {
	if r.h != nil {
		return ""
	}
	if r.i < len(r.b) && r.b[r.i] == 'N' {
		r.i++
		return ""
	}
	if !r.bekle('t') {
		return ""
	}
	son := bytes.IndexByte(r.b[r.i:], 0)
	if son < 0 {
		r.hata("yarım metin")
		return ""
	}
	s := string(r.b[r.i : r.i+son])
	r.i += son + 1
	return s
}
func (r *okur) mantik() bool {
	if r.h != nil || r.i >= len(r.b) {
		r.hata("yarım")
		return false
	}
	t := r.b[r.i]
	r.i++
	if t != '1' && t != '0' {
		r.hata("mantık değil")
	}
	return t == '1'
}
func (r *okur) usec() uint64 {
	if !r.bekle('U') || !r.yeter(8) {
		return 0
	}
	v := binary.BigEndian.Uint64(r.b[r.i:])
	r.i += 8
	return v
}
func (r *okur) ornekBicimi() (kanal uint8, hiz uint32) {
	if !r.bekle('a') || !r.yeter(6) {
		return
	}
	kanal = r.b[r.i+1]
	hiz = binary.BigEndian.Uint32(r.b[r.i+2:])
	r.i += 6
	return
}
func (r *okur) ozellikler() map[string]string {
	o := map[string]string{}
	if !r.bekle('P') {
		return o
	}
	for r.h == nil {
		k := r.metin()
		if k == "" {
			return o
		}
		r.u32()
		if !r.bekle('x') || !r.yeter(4) {
			return o
		}
		n := int(binary.BigEndian.Uint32(r.b[r.i:]))
		r.i += 4
		if !r.yeter(n) {
			return o
		}
		o[k] = strings.TrimRight(string(r.b[r.i:r.i+n]), "\x00")
		r.i += n
	}
	return o
}

// atla: türü ne olursa olsun n değeri atla.
func (r *okur) atla(n int) {
	for k := 0; k < n && r.h == nil; k++ {
		if r.i >= len(r.b) {
			r.hata("yarım")
			return
		}
		t := r.b[r.i]
		switch t {
		case 'L', 'V':
			r.i += 5
		case 'B':
			r.i += 2
		case 't', 'N':
			r.metin()
		case '1', '0':
			r.i++
		case 'T', 'U', 'R', 'r':
			r.i += 9
		case 'a':
			r.i += 7
		case 'm':
			if !r.yeter(2) {
				return
			}
			r.i += 2 + int(r.b[r.i+1])
		case 'v':
			if !r.yeter(2) {
				return
			}
			r.i += 2 + 4*int(r.b[r.i+1])
		case 'x':
			if !r.yeter(5) {
				return
			}
			r.i += 5 + int(binary.BigEndian.Uint32(r.b[r.i+1:]))
		case 'P':
			r.ozellikler()
		case 'f':
			r.i++
			r.atla(2)
		default:
			r.hata("bilinmeyen tür 0x%x (konum %d)", t, r.i)
			return
		}
	}
	if r.i > len(r.b) {
		r.hata("yarım")
	}
}

// ---------------------------------------------------------------- bağlantı

func soketYollari() []string {
	var yollar []string
	if s := os.Getenv("PULSE_SERVER"); s != "" {
		for _, p := range strings.Fields(s) {
			if i := strings.Index(p, "}"); strings.HasPrefix(p, "{") && i > 0 {
				p = p[i+1:]
			}
			if strings.HasPrefix(p, "unix:") {
				yollar = append(yollar, p[5:])
			} else if strings.HasPrefix(p, "/") {
				yollar = append(yollar, p)
			}
		}
	}
	if p := os.Getenv("PULSE_RUNTIME_PATH"); p != "" {
		yollar = append(yollar, filepath.Join(p, "native"))
	}
	if p := os.Getenv("XDG_RUNTIME_DIR"); p != "" {
		yollar = append(yollar, filepath.Join(p, "pulse", "native"))
	}
	yollar = append(yollar, fmt.Sprintf("/run/user/%d/pulse/native", os.Getuid()), "/var/run/pulse/native")
	gorulen := map[string]bool{}
	var tekil []string
	for _, y := range yollar {
		if !gorulen[y] {
			gorulen[y] = true
			tekil = append(tekil, y)
		}
	}
	return tekil
}

func kimlikAnahtari() []byte {
	ev, _ := os.UserHomeDir()
	ayar := os.Getenv("XDG_CONFIG_HOME")
	if ayar == "" {
		ayar = filepath.Join(ev, ".config")
	}
	for _, y := range []string{os.Getenv("PULSE_COOKIE"), filepath.Join(ayar, "pulse", "cookie"), filepath.Join(ev, ".pulse-cookie")} {
		if y == "" {
			continue
		}
		if b, err := os.ReadFile(y); err == nil && len(b) == 256 {
			return b
		}
	}
	// Anahtar yoksa da denenir: aynı kullanıcının soketine bağlanan istemciyi sunucu zaten tanır.
	return make([]byte, 256)
}

type yanit struct {
	r *okur
	h error
}

// Olay: abonelik olayı (aygıt/akış eklendi, değişti, silindi).
type Olay struct {
	Tesis  int    // TesisCikis, TesisGiris, TesisCalmaAkisi, TesisSunucu...
	Tur    string // "yeni", "degisti", "silindi"
	Indeks uint32
}

// Baglanti: ses sunucusuyla bir bağlantı. Komutlar her goroutine'den güvenle çağrılır.
type Baglanti struct {
	soket       net.Conn
	yazMu       sync.Mutex
	mu          sync.Mutex
	etiket      uint32
	bekleyen    map[uint32]chan yanit
	calmalar    map[uint32]*Calma
	kayitlar    map[uint32]*Kayit
	esleme      uint32
	surum       uint32
	IstemciNo   uint32
	Yol         string
	kapali      atomic.Bool
	kapandi     chan struct{}
	kimlikGitti bool
	// OlayGeldi: abonelik olayları (okuma goroutine'inden çağrılır; bekletmemeli).
	OlayGeldi func(Olay)
	// Kapandi: bağlantı koptuğunda bir kez.
	Kapandi func(error)
}

// Baglan: bağlan, kimliği doğrula, adını bildir.
func Baglan(ad string) (*Baglanti, error) {
	var son error
	var hatalar []string
	for _, yol := range soketYollari() {
		s, err := net.DialTimeout("unix", yol, 2*time.Second)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) && !strings.Contains(err.Error(), "no such file") {
				hatalar = append(hatalar, yol+": "+err.Error())
			}
			son = err
			continue
		}
		b := &Baglanti{soket: s, bekleyen: map[uint32]chan yanit{}, calmalar: map[uint32]*Calma{}, kayitlar: map[uint32]*Kayit{}, esleme: 1, surum: surum, kapandi: make(chan struct{}), Yol: yol}
		go b.okumaDongusu()
		r, err := b.komut(kKimlik, func(w *yazar) { w.u32(surum).bayt(kimlikAnahtari()) })
		if err == nil {
			b.surum = min(uint32(surum), r.u32()&0xffff)
			if b.surum < 13 {
				err = fmt.Errorf("ses sunucusu çok eski (protokol %d)", b.surum)
			}
		}
		if err == nil {
			r, err = b.komut(kIstemciAdi, func(w *yazar) {
				w.ozellikler(map[string]string{"application.name": ad, "application.icon_name": "audio-headset", "application.process.id": fmt.Sprint(os.Getpid()), "application.process.binary": "diszort"})
			})
			if err == nil {
				b.IstemciNo = r.u32()
			}
		}
		if err == nil {
			return b, nil
		}
		son = err
		hatalar = append(hatalar, yol+": "+err.Error())
		b.Kapat()
	}
	if len(hatalar) > 0 {
		son = errors.New(strings.Join(hatalar, "; "))
	} else if son == nil || strings.Contains(son.Error(), "no such file") {
		son = errors.New("soket bulunamadı")
	}
	return nil, fmt.Errorf("ses sunucusuna bağlanılamadı (PulseAudio ya da PipeWire çalışıyor mu?): %w", son)
}

func (b *Baglanti) Kapali() bool { return b.kapali.Load() }

func (b *Baglanti) Kapat() { b.koptu(nil) }

func (b *Baglanti) koptu(h error) {
	if !b.kapali.CompareAndSwap(false, true) {
		return
	}
	b.soket.Close()
	b.mu.Lock()
	for _, c := range b.bekleyen {
		c <- yanit{h: errors.New("ses sunucusu bağlantısı kapandı")}
	}
	b.bekleyen = map[uint32]chan yanit{}
	calmalar, kayitlar := b.calmalar, b.kayitlar
	b.calmalar, b.kayitlar = map[uint32]*Calma{}, map[uint32]*Kayit{}
	b.mu.Unlock()
	for _, a := range calmalar {
		a.olduruldu()
	}
	for _, a := range kayitlar {
		a.olduruldu()
	}
	close(b.kapandi)
	if b.Kapandi != nil {
		b.Kapandi(h)
	}
}

func (b *Baglanti) paket(kanal uint32, yuk []byte) error {
	bas := make([]byte, 20, 20+len(yuk))
	binary.BigEndian.PutUint32(bas[0:], uint32(len(yuk)))
	binary.BigEndian.PutUint32(bas[4:], kanal)
	b.yazMu.Lock()
	defer b.yazMu.Unlock()
	b.soket.SetWriteDeadline(time.Now().Add(5 * time.Second))
	var err error
	if uc, ok := b.soket.(*net.UnixConn); ok && !b.kimlikGitti {
		// İlk pakette kimlik bilgisi (SCM_CREDENTIALS) açıkça gider: PulseAudio aynı kullanıcıyı buradan
		// tanır (çerez dosyası gerekmez). Kendiliğinden eklenmesine güvenilmez: sunucu bunu bağlantıyı
		// kabul ettikten sonra açar, ilk paket daha önce varabilir (libpulse de böyle yapar).
		b.kimlikGitti = true
		oob := unix.UnixCredentials(&unix.Ucred{Pid: int32(os.Getpid()), Uid: uint32(os.Getuid()), Gid: uint32(os.Getgid())})
		_, _, err = uc.WriteMsgUnix(append(bas, yuk...), oob, nil)
	} else {
		_, err = b.soket.Write(append(bas, yuk...))
	}
	if err != nil {
		go b.koptu(err)
	}
	return err
}

func (b *Baglanti) komut(kod uint32, doldur func(*yazar)) (*okur, error) {
	if b.kapali.Load() {
		return nil, errors.New("ses sunucusu bağlantısı kapalı")
	}
	c := make(chan yanit, 1)
	b.mu.Lock()
	etiket := b.etiket
	b.etiket++
	b.bekleyen[etiket] = c
	b.mu.Unlock()
	w := &yazar{}
	w.u32(kod).u32(etiket)
	if doldur != nil {
		doldur(w)
	}
	if err := b.paket(gecersiz, w.b.Bytes()); err != nil {
		b.mu.Lock()
		delete(b.bekleyen, etiket)
		b.mu.Unlock()
		return nil, err
	}
	select {
	case y := <-c:
		return y.r, y.h
	case <-time.After(8 * time.Second):
		b.mu.Lock()
		delete(b.bekleyen, etiket)
		b.mu.Unlock()
		return nil, errors.New("ses sunucusu yanıt vermedi")
	}
}

func (b *Baglanti) okumaDongusu() {
	bas := make([]byte, 20)
	for {
		if _, err := io.ReadFull(b.soket, bas); err != nil {
			b.koptu(err)
			return
		}
		boy := binary.BigEndian.Uint32(bas[0:])
		kanal := binary.BigEndian.Uint32(bas[4:])
		if boy > 16<<20 {
			b.koptu(errors.New("ses sunucusu: paket çok büyük"))
			return
		}
		yuk := make([]byte, boy)
		if _, err := io.ReadFull(b.soket, yuk); err != nil {
			b.koptu(err)
			return
		}
		if kanal == gecersiz {
			b.komutGeldi(&okur{b: yuk})
			continue
		}
		b.mu.Lock()
		a := b.kayitlar[kanal]
		b.mu.Unlock()
		if a != nil && a.Veri != nil {
			a.Veri(baytlardanOrnek(yuk))
		}
	}
}

func (b *Baglanti) komutGeldi(r *okur) {
	kod := r.u32()
	etiket := r.u32()
	if r.h != nil {
		return
	}
	switch kod {
	case kYanit, kHata:
		b.mu.Lock()
		c := b.bekleyen[etiket]
		delete(b.bekleyen, etiket)
		b.mu.Unlock()
		if c == nil {
			return
		}
		if kod == kHata {
			c <- yanit{h: &Hata{Kod: r.u32()}}
		} else {
			c <- yanit{r: r}
		}
		return
	case kAboneOlayi:
		olay := r.u32()
		indeks := r.u32()
		tur := []string{"yeni", "degisti", "silindi", ""}[(olay&0x30)>>4]
		if b.OlayGeldi != nil && r.h == nil {
			b.OlayGeldi(Olay{Tesis: int(olay & 0x0f), Tur: tur, Indeks: indeks})
		}
		return
	}
	no := r.u32()
	kayit := kod == kKayitOldu || kod == kKayitAskida || kod == kKayitTasindi
	b.mu.Lock()
	var calma *Calma
	var kayitA *Kayit
	if kayit {
		kayitA = b.kayitlar[no]
	} else {
		calma = b.calmalar[no]
	}
	b.mu.Unlock()
	switch kod {
	case kIstek:
		if calma != nil {
			calma.kredi.Add(int64(r.u32()))
		}
	case kBosalma:
		if calma != nil {
			calma.Bosalma.Add(1)
		}
	case kCalmaOldu:
		if calma != nil {
			b.mu.Lock()
			delete(b.calmalar, no)
			b.mu.Unlock()
			calma.olduruldu()
		}
	case kKayitOldu:
		if kayitA != nil {
			b.mu.Lock()
			delete(b.kayitlar, no)
			b.mu.Unlock()
			kayitA.olduruldu()
		}
	case kCalmaTasindi:
		if calma != nil {
			r.u32()
			calma.Aygit = r.metin()
		}
	case kKayitTasindi:
		if kayitA != nil {
			r.u32()
			kayitA.Aygit = r.metin()
		}
	}
}

// ---------------------------------------------------------------- bilgi

// SunucuBilgisi: sunucunun adı ve varsayılan aygıtlar.
type SunucuBilgisi struct {
	Ad, Surum                        string
	Hiz                              uint32
	VarsayilanCikis, VarsayilanGiris string
}

func (b *Baglanti) SunucuBilgisi() (SunucuBilgisi, error) {
	r, err := b.komut(kSunucuBilgisi, nil)
	if err != nil {
		return SunucuBilgisi{}, err
	}
	s := SunucuBilgisi{Ad: r.metin(), Surum: r.metin()}
	r.atla(2)
	_, s.Hiz = r.ornekBicimi()
	s.VarsayilanCikis = r.metin()
	s.VarsayilanGiris = r.metin()
	return s, r.h
}

// Aygit: bir çıkış (hoparlör) ya da giriş (mikrofon, monitör).
type Aygit struct {
	Indeks     uint32
	Ad         string // sunucudaki adı (kimlik)
	Aciklama   string // görünen adı
	Kanal      uint8
	Hiz        uint32
	Monitor    string // çıkışta: monitör girişinin adı
	MonitorMu  bool   // girişte: bir çıkışın monitörü mü
	Ozellikler map[string]string
}

func (b *Baglanti) aygitOku(r *okur) Aygit {
	a := Aygit{Indeks: r.u32(), Ad: r.metin(), Aciklama: r.metin()}
	a.Kanal, a.Hiz = r.ornekBicimi()
	r.atla(4)
	es := r.u32()
	esAd := r.metin()
	r.atla(3)
	a.Ozellikler = r.ozellikler()
	r.atla(1)
	if b.surum >= 15 {
		r.atla(4)
	}
	if b.surum >= 16 {
		kapi := r.u32()
		for i := uint32(0); i < kapi && r.h == nil; i++ {
			r.atla(3)
			if b.surum >= 24 {
				r.atla(1)
			}
			if b.surum >= 34 {
				r.atla(2)
			}
		}
		r.atla(1)
	}
	a.Monitor = esAd
	a.MonitorMu = es != gecersiz
	if a.Aciklama == "" {
		a.Aciklama = a.Ad
	}
	return a
}

func (r *okur) bicimleriAtla() {
	if !r.bekle('B') || !r.yeter(1) {
		return
	}
	n := int(r.b[r.i])
	r.i++
	r.atla(n)
}

// Cikislar: hoparlörler (Monitor: o çıkışta çalanı veren girişin adı).
func (b *Baglanti) Cikislar() ([]Aygit, error) {
	r, err := b.komut(kCikisListesi, nil)
	if err != nil {
		return nil, err
	}
	var liste []Aygit
	for !r.bitti() {
		a := b.aygitOku(r)
		if b.surum >= 21 {
			r.bicimleriAtla()
		}
		if r.h == nil {
			liste = append(liste, a)
		}
	}
	return liste, r.h
}

// Girisler: mikrofonlar ve çıkışların monitörleri.
func (b *Baglanti) Girisler() ([]Aygit, error) {
	r, err := b.komut(kGirisListesi, nil)
	if err != nil {
		return nil, err
	}
	var liste []Aygit
	for !r.bitti() {
		a := b.aygitOku(r)
		if b.surum >= 22 {
			r.bicimleriAtla()
		}
		if r.h == nil {
			a.Monitor = ""
			if a.MonitorMu {
				// girişte eş ad: monitörü olduğu çıkış
			}
			liste = append(liste, a)
		}
	}
	return liste, r.h
}

// CalmaAkisi: bir uygulamanın çalma akışı (sink input).
type CalmaAkisi struct {
	Indeks     uint32
	Ad         string
	Istemci    uint32
	Cikis      uint32 // çaldığı çıkışın dizini
	Durdu      bool   // duraklatılmış (corked)
	Ozellikler map[string]string
}

// Uygulama: akışın uygulama adı.
func (c CalmaAkisi) Uygulama() string {
	for _, k := range []string{"application.name", "application.process.binary", "media.name"} {
		if v := c.Ozellikler[k]; v != "" {
			return v
		}
	}
	if c.Ad != "" {
		return c.Ad
	}
	return "uygulama"
}

// CalmaAkislari: uygulamaların çalma akışları.
func (b *Baglanti) CalmaAkislari() ([]CalmaAkisi, error) {
	r, err := b.komut(kCalmaListesi, nil)
	if err != nil {
		return nil, err
	}
	var liste []CalmaAkisi
	for !r.bitti() {
		c := CalmaAkisi{Indeks: r.u32(), Ad: r.metin()}
		r.atla(1) // modül
		c.Istemci = r.u32()
		c.Cikis = r.u32()
		r.atla(3) // biçim, kanal haritası, ses düzeyleri
		r.atla(4) // tampon gecikmesi, çıkış gecikmesi, örnekleme yöntemi, sürücü
		if b.surum >= 11 {
			r.atla(1) // sessiz
		}
		if b.surum >= 13 {
			c.Ozellikler = r.ozellikler()
		}
		if b.surum >= 19 {
			c.Durdu = r.mantik()
		}
		if b.surum >= 20 {
			r.atla(2)
		}
		if b.surum >= 21 {
			r.atla(1) // biçim bilgisi
		}
		if r.h == nil {
			liste = append(liste, c)
		}
	}
	return liste, r.h
}

// AboneOl: maske'deki değişiklikleri OlayGeldi'ye bildir.
func (b *Baglanti) AboneOl(maske uint32) error {
	_, err := b.komut(kAbone, func(w *yazar) { w.u32(maske) })
	return err
}

// ---------------------------------------------------------------- akışlar

func akisBasi(w *yazar, kanal uint8, hiz uint32, aygit string) {
	w.ornekBicimi(kanal, hiz).kanalHaritasi(kanal).u32(gecersiz).metinYaDaBos(aygit)
}

func akisBayraklari(w *yazar) {
	// yeniden eşleme yok, karıştırma yok, biçim/hız/kanal sabitleme, taşınmasın, değişken hız: kapalı
	for i := 0; i < 7; i++ {
		w.mantik(false)
	}
}

// Calma: çalma akışı (float32, 48 kHz).
type Calma struct {
	b       *Baglanti
	no      uint32
	Indeks  uint32
	Kanal   int
	Hiz     int
	Aygit   string
	Hedef   int64 // sunucunun kabul ettiği hedef uzunluk (bayt)
	kredi   atomic.Int64
	Bosalma atomic.Int64 // sunucu sesin bittiğini kaç kez bildirdi
	kapali  atomic.Bool
	Bitti   chan struct{}
}

// CalmaAc: çalma akışı aç. hedefMs: sunucuda tutulacak ses. Akış hemen çalar (ön tampon yok).
func (b *Baglanti) CalmaAc(aygit string, kanal int, hedefMs int, ad string, ozellik map[string]string) (*Calma, error) {
	const hiz = 48000
	cerceve := kanal * 4
	bayt := func(ms int) uint32 { return uint32(max(cerceve, hiz*ms/1000*cerceve)) }
	o := map[string]string{"media.name": ad, "media.role": "phone"}
	for k, v := range ozellik {
		o[k] = v
	}
	b.mu.Lock()
	esleme := b.esleme
	b.esleme++
	b.mu.Unlock()
	r, err := b.komut(kCalmaAc, func(w *yazar) {
		akisBasi(w, uint8(kanal), hiz, aygit)
		w.u32(gecersiz).mantik(false).u32(bayt(hedefMs)).u32(0).u32(bayt(min(10, max(1, hedefMs/2)))).u32(esleme).sesDuzeyleri(uint8(kanal))
		akisBayraklari(w)
		w.mantik(false).mantik(true).ozellikler(o)
		w.mantik(false).mantik(false).mantik(false).mantik(false).mantik(false).mantik(false).mantik(false).u8(0)
	})
	if err != nil {
		return nil, err
	}
	a := &Calma{b: b, Kanal: kanal, Hiz: hiz, Bitti: make(chan struct{})}
	a.no = r.u32()
	a.Indeks = r.u32()
	a.kredi.Store(int64(r.u32()))
	r.atla(1)
	a.Hedef = int64(r.u32())
	r.atla(4)
	r.atla(1)
	a.Aygit = r.metin()
	if r.h != nil {
		return nil, r.h
	}
	b.mu.Lock()
	b.calmalar[a.no] = a
	b.mu.Unlock()
	return a, nil
}

// Kredi: sunucunun istediği, henüz yazılmamış ses (örnek çerçevesi).
func (a *Calma) Kredi() int { return int(a.kredi.Load()) / (a.Kanal * 4) }

// HedefCerceve: sunucudaki hedef tampon (örnek çerçevesi).
func (a *Calma) HedefCerceve() int { return int(a.Hedef) / (a.Kanal * 4) }

// Yaz: araya geçmiş (interleaved) örnekleri yaz.
func (a *Calma) Yaz(ornek []float32) error {
	if a.kapali.Load() {
		return errors.New("çalma akışı kapalı")
	}
	if len(ornek) == 0 {
		return nil
	}
	v := ornekBaytlari(ornek)
	a.kredi.Add(-int64(len(v)))
	return a.b.paket(a.no, v)
}

func (a *Calma) olduruldu() {
	if a.kapali.CompareAndSwap(false, true) {
		close(a.Bitti)
	}
}

func (a *Calma) Kapali() bool { return a.kapali.Load() }

func (a *Calma) Kapat() {
	if !a.kapali.CompareAndSwap(false, true) {
		return
	}
	close(a.Bitti)
	a.b.mu.Lock()
	delete(a.b.calmalar, a.no)
	a.b.mu.Unlock()
	if !a.b.kapali.Load() {
		go a.b.komut(kCalmaSil, func(w *yazar) { w.u32(a.no) })
	}
}

// Kayit: kayıt akışı. Veri: gelen örnekler (okuma goroutine'inden; bekletmemeli, dilimi saklarsa kopyalamalı değil — dilim yeni ayrılır).
type Kayit struct {
	b      *Baglanti
	no     uint32
	Indeks uint32
	Kanal  int
	Aygit  string
	Veri   func([]float32)
	kapali atomic.Bool
	Bitti  chan struct{}
}

// KayitAc: kayıt akışı aç. aygit: giriş adı ("" = varsayılan). calmaAkisi: gecersiz değilse yalnızca o
// uygulama akışının sesi kaydedilir (aygit yok sayılır). parcaMs: verinin geleceği parça boyu.
func (b *Baglanti) KayitAc(aygit string, kanal int, parcaMs int, calmaAkisi uint32, ad string, veri func([]float32)) (*Kayit, error) {
	const hiz = 48000
	cerceve := kanal * 4
	a := &Kayit{b: b, Kanal: kanal, Veri: veri, Bitti: make(chan struct{})}
	r, err := b.komut(kKayitAc, func(w *yazar) {
		akisBasi(w, uint8(kanal), hiz, aygit)
		w.u32(gecersiz).mantik(false).u32(uint32(max(cerceve, hiz*parcaMs/1000*cerceve)))
		akisBayraklari(w)
		w.mantik(false).mantik(true).ozellikler(map[string]string{"media.name": ad, "media.role": "phone"}).u32(calmaAkisi)
		w.mantik(false).mantik(false).mantik(false)
		if b.surum >= 22 {
			w.u8(0).sesDuzeyleri(uint8(kanal))
			for i := 0; i < 5; i++ {
				w.mantik(false)
			}
		}
	})
	if err != nil {
		return nil, err
	}
	a.no = r.u32()
	a.Indeks = r.u32()
	r.atla(2)
	r.atla(2)
	r.atla(1)
	a.Aygit = r.metin()
	if r.h != nil {
		return nil, r.h
	}
	b.mu.Lock()
	b.kayitlar[a.no] = a
	b.mu.Unlock()
	return a, nil
}

// TumAkislar: hepsi için gecersiz.
const TumAkislar = gecersiz

func (a *Kayit) olduruldu() {
	if a.kapali.CompareAndSwap(false, true) {
		close(a.Bitti)
	}
}

func (a *Kayit) Kapali() bool { return a.kapali.Load() }

func (a *Kayit) Kapat() {
	if !a.kapali.CompareAndSwap(false, true) {
		return
	}
	close(a.Bitti)
	a.b.mu.Lock()
	delete(a.b.kayitlar, a.no)
	a.b.mu.Unlock()
	if !a.b.kapali.Load() {
		go a.b.komut(kKayitSil, func(w *yazar) { w.u32(a.no) })
	}
}

// ---------------------------------------------------------------- örnek dönüşümü

func baytlardanOrnek(b []byte) []float32 {
	n := len(b) / 4
	o := make([]float32, n)
	for i := 0; i < n; i++ {
		o[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return o
}

func ornekBaytlari(o []float32) []byte {
	// Küçük uçlu makinede (x86, ARM) bellek zaten float32le: kopyala.
	b := make([]byte, len(o)*4)
	copy(b, unsafe.Slice((*byte)(unsafe.Pointer(&o[0])), len(o)*4))
	return b
}
