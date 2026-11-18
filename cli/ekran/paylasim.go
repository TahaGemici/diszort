// Package ekran: ekran paylaşımı — yakalama (X11 doğrudan; Wayland'de masaüstü portalı ve PipeWire),
// ölçekleme ve VP8 kodlama. Kodlanmış kareler geri çağrıyla verilir (WebRTC bu paketin dışında).
// Kimse izlemiyorken (ya da ekran gizliyken) yakalama ve kodlama durur: işlemci harcanmaz.
package ekran

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// kaynak: bir yakalama yolu.
type kaynak interface {
	// kare: son kare (BGRx; rgb=true ise RGBx). Veri bir sonraki çağrıya kadar geçerli.
	kare() (veri []byte, adim, g, y int, rgb bool, err error)
	// birak: kare() verisiyle işi bitti (Wayland'de kare kilitlidir).
	birak()
	ad() string
	kapat()
}

// Secim: ne paylaşılacak.
type Secim struct {
	Monitor       int // X11: monitör numarası (0 = birincil, -1 = bütün ekran)
	Kare          int // kare/sn
	EnCokG        int // kodlanan en büyük boy (0 = 1920×1080)
	EnCokY        int
	IzinBelirteci string // Wayland: önceki seçimin hatırlanması (portal "restore token")
}

// Paylasim: süren bir ekran paylaşımı.
type Paylasim struct {
	k             kaynak
	secim         Secim
	anahtar       atomic.Bool
	hedefKbps     atomic.Int64
	gizli         atomic.Bool
	dur           chan struct{}
	durOnce       sync.Once
	Bitti         chan struct{}
	Hata          error
	IzinBelirteci string
	mu            sync.Mutex
	boyut         string
	gercekKare    float64
	// Gonder: kodlanmış kare (yakalama goroutine'inden).
	Gonder func(kare []byte, sure time.Duration)
	// IzleyenVar: gönderilecek biri var mı (yoksa yakalanmaz).
	IzleyenVar func() bool
}

// Oturum: masaüstünün türü.
func Oturum() string {
	if os.Getenv("WAYLAND_DISPLAY") != "" || strings.EqualFold(os.Getenv("XDG_SESSION_TYPE"), "wayland") {
		return "wayland"
	}
	if X11Var() {
		return "x11"
	}
	return ""
}

// Baslat: yakalamayı aç (Wayland'de portalın seçim penceresi açılabilir: kullanıcı ekranı seçer).
func Baslat(s Secim) (*Paylasim, error) {
	if s.Kare <= 0 {
		s.Kare = 30
	}
	if s.EnCokG <= 0 || s.EnCokY <= 0 {
		s.EnCokG, s.EnCokY = 1920, 1080
	}
	var k kaynak
	var err error
	belirtec := ""
	switch Oturum() {
	case "wayland":
		var w *wayland
		w, err = waylandAc(s)
		if err == nil {
			k, belirtec = w, w.belirtec
		}
	case "x11":
		k, err = x11Ac(s.Monitor)
	default:
		err = errors.New("masaüstü bulunamadı (ne Wayland ne X11): ekran paylaşımı ancak masaüstü oturumunda olur")
	}
	if err != nil {
		return nil, err
	}
	return kaynaktan(k, s, belirtec), nil
}

func kaynaktan(k kaynak, s Secim, belirtec string) *Paylasim {
	if s.Kare <= 0 {
		s.Kare = 30
	}
	if s.EnCokG <= 0 || s.EnCokY <= 0 {
		s.EnCokG, s.EnCokY = 1920, 1080
	}
	p := &Paylasim{k: k, secim: s, dur: make(chan struct{}), Bitti: make(chan struct{}), IzinBelirteci: belirtec}
	p.hedefKbps.Store(2500)
	p.anahtar.Store(true)
	go p.dongu()
	return p
}

func (p *Paylasim) AnahtarKare() { p.anahtar.Store(true) }

// BitHizi: hedef (kbps).
func (p *Paylasim) BitHizi(kbps int) { p.hedefKbps.Store(int64(kbps)) }

// Gizle: ekran gizli (görüntü gitmez, yakalama durur); açılınca anahtar kareyle sürer.
func (p *Paylasim) Gizle(v bool) {
	if p.gizli.Swap(v) && !v {
		p.anahtar.Store(true)
	}
}

func (p *Paylasim) Durdur() {
	p.durOnce.Do(func() { close(p.dur) })
}

// Bilgi: "X11 · eDP-1 1920×1080 → 1920×1080 · 30 kare/sn".
func (p *Paylasim) Bilgi() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.k.ad()
	if p.boyut != "" {
		b += " → " + p.boyut
	}
	b += fmt.Sprintf(" · %d kare/sn", p.secim.Kare)
	if p.gercekKare > 0 && p.gercekKare < float64(p.secim.Kare)*0.8 {
		b += fmt.Sprintf(" (gerçekte %.0f)", p.gercekKare)
	}
	return b
}

// hedefBoyut: en büyük boya sığacak, en-boy oranı korunmuş, çift sayılı boy.
func hedefBoyut(g, y, enCokG, enCokY int) (int, int) {
	if g <= enCokG && y <= enCokY {
		return g &^ 1, y &^ 1
	}
	o := min(float64(enCokG)/float64(g), float64(enCokY)/float64(y))
	return int(float64(g)*o) &^ 1, int(float64(y)*o) &^ 1
}

func (p *Paylasim) dongu() {
	defer close(p.Bitti)
	defer p.k.kapat()
	var kod *Kodlayici
	defer func() {
		if kod != nil {
			kod.Kapat()
		}
	}()
	aralik := time.Second / time.Duration(p.secim.Kare)
	tik := time.NewTicker(aralik)
	defer tik.Stop()
	bas := time.Now()
	sayac, sayacBas := 0, time.Now()
	for {
		select {
		case <-p.dur:
			return
		case <-tik.C:
		}
		if p.gizli.Load() || (p.IzleyenVar != nil && !p.IzleyenVar()) {
			continue
		}
		veri, adim, g, y, rgb, err := p.k.kare()
		if err != nil {
			if errors.Is(err, errKareYok) {
				continue
			}
			p.Hata = err
			return
		}
		hg, hy := hedefBoyut(g, y, p.secim.EnCokG, p.secim.EnCokY)
		if hg < 16 || hy < 16 {
			p.k.birak()
			continue
		}
		if kod == nil || kod.G != hg || kod.Y != hy {
			if kod != nil {
				kod.Kapat()
			}
			is := min(4, max(1, runtime.NumCPU()/2))
			kod, err = YeniKodlayici(hg, hy, int(p.hedefKbps.Load()), p.secim.Kare, is)
			if err != nil {
				p.k.birak()
				p.Hata = err
				return
			}
			p.mu.Lock()
			p.boyut = fmt.Sprintf("%d×%d", hg, hy)
			p.mu.Unlock()
			p.anahtar.Store(true)
		}
		kod.BitHizi(int(p.hedefKbps.Load()))
		pts := int64(time.Since(bas) / (time.Second / 90000))
		kare, _, err := kod.Kodla(veri, adim, g, y, rgb, pts, p.anahtar.Swap(false))
		p.k.birak()
		if err != nil {
			p.Hata = err
			return
		}
		if kare != nil && p.Gonder != nil {
			p.Gonder(kare, aralik)
		}
		sayac++
		if gecen := time.Since(sayacBas); gecen > 3*time.Second {
			p.mu.Lock()
			p.gercekKare = float64(sayac) / gecen.Seconds()
			p.mu.Unlock()
			sayac, sayacBas = 0, time.Now()
		}
	}
}

var errKareYok = errors.New("henüz kare yok")

func closeFd(fd int) { unix.Close(fd) }
