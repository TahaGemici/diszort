package main

import (
	"encoding/json"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Sunucuyla bağlantı (/rtc WebSocket'i). Bağlantı koparsa ses bağlantıları KAPATILMAZ (ses P2P akar);
// yeniden bağlanınca sesli kanala "devam" denir.

type soket struct {
	c       *websocket.Conn
	mu      sync.Mutex
	kapandi atomic.Bool
	gid     chan any
	bitti   chan struct{}
}

// yeniSoket: giden iletiler tek bir goroutine'den, sırayla yazılır (mesajlar da SDP/ICE de art arda
// gönderildiği sırayla gitsin).
func yeniSoket(c *websocket.Conn) *soket {
	s := &soket{c: c, gid: make(chan any, 1024), bitti: make(chan struct{})}
	go func() {
		for {
			select {
			case v := <-s.gid:
				if err := s.yaz(v); err != nil {
					s.kapat()
					return
				}
			case <-s.bitti:
				return
			}
		}
	}()
	return s
}

// sirala: sıraya koy; kuyruk dolduysa (bağlantı tıkandı) bağlantı kapanır, yeniden bağlanılır.
func (s *soket) sirala(v any) {
	if s.kapandi.Load() {
		return
	}
	select {
	case s.gid <- v:
	default:
		s.kapat()
	}
}

func (s *soket) yaz(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return s.c.WriteJSON(v)
}

func (s *soket) kapat() {
	if s.kapandi.CompareAndSwap(false, true) {
		close(s.bitti)
		s.c.Close()
	}
}

func (u *Uygulama) wsAdresi() string {
	a := u.ayar.Sunucu
	if strings.HasPrefix(a, "https://") {
		return "wss://" + strings.TrimPrefix(a, "https://") + "/rtc"
	}
	return "ws://" + strings.TrimPrefix(a, "http://") + "/rtc"
}

func (u *Uygulama) baglan() {
	if u.yenidenZaman != nil {
		u.yenidenZaman.Stop()
		u.yenidenZaman = nil
	}
	if u.ws != nil {
		u.ws.kapat()
		u.ws = nil
	}
	u.durduruldu = false
	adres := u.wsAdresi()
	koken := u.ayar.Sunucu
	go func() {
		d := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 10 * time.Second}
		baslik := http.Header{}
		baslik.Set("Origin", koken)
		baslik.Set("User-Agent", "Diszort-CLI/"+surum)
		c, _, err := d.Dial(adres, baslik)
		u.calistir(func() {
			if err != nil {
				u.gunluk("bağlanılamadı: " + err.Error())
				u.baglantiKoptu()
				return
			}
			if u.durduruldu {
				c.Close()
				return
			}
			c.SetReadLimit(1 << 20)
			s := yeniSoket(c)
			u.ws = s
			u.sonSunucu = time.Now()
			ses := u.sesKanal
			s.yaz(map[string]any{"type": "giris", "ad": u.girisAdi, "id": u.sekme, "anahtar": u.ayar.Anahtar, "ses": ses})
			go u.oku(s)
		})
	}()
}

func (u *Uygulama) oku(s *soket) {
	for {
		_, veri, err := s.c.ReadMessage()
		if err != nil {
			u.calistir(func() {
				if u.ws == s {
					u.ws = nil
					u.baglantiKoptu()
				}
			})
			return
		}
		var m Gelen
		if json.Unmarshal(veri, &m) != nil || m.Type == "" {
			continue
		}
		u.calistir(func() {
			if u.ws == s {
				u.iletiGeldi(m)
			}
		})
	}
}

// gonder: sunucuya ileti (bağlı değilse düşer).
func (u *Uygulama) gonder(v map[string]any) {
	if u.ws == nil || !u.bagli {
		return
	}
	u.ws.sirala(v)
}

func (u *Uygulama) baglantiKoptu() {
	onceki := u.bagli
	u.bagli = false
	u.istemGuncelle()
	if u.durduruldu {
		return
	}
	if u.bekleyenIstek {
		u.bekleyenIstek = false
		u.adSor("Bağlantı koptu; istek düştü. Tekrar dene.")
		return
	}
	if onceki {
		ek := ""
		if u.sesKanal != "" {
			ek = " (ses sürüyor)"
		}
		u.durum("Sunucu bağlantısı koptu; yeniden bağlanılıyor…"+ek, true)
	}
	u.yenidenBaglanmayiPlanla(0)
}

var yenidenTakvim = []int{500, 1000, 1000, 2000, 2000, 4000, 8000, 15000}

func (u *Uygulama) yenidenBaglanmayiPlanla(bekle time.Duration) {
	if u.yenidenZaman != nil {
		u.yenidenZaman.Stop()
	}
	if bekle == 0 {
		ms := yenidenTakvim[min(u.yenidenDene, len(yenidenTakvim)-1)]
		u.yenidenDene++
		bekle = time.Duration(float64(ms)*(0.8+rand.Float64()*0.4)) * time.Millisecond
	}
	if !u.oturumVardi && u.yenidenDene > 3 {
		u.durum("Sunucuya ulaşılamıyor; yeniden deneniyor…", true)
	}
	u.yenidenZaman = u.sonra(bekle, func() {
		if !u.durduruldu {
			u.baglan()
		}
	})
}

// canlilikDenetle: sunucudan uzun süre ses çıkmadıysa yokla; yanıt gelmezse bağlantı ölüdür.
func (u *Uygulama) canlilikDenetle() {
	if !u.bagli || u.ws == nil || u.canlilik != nil || time.Since(u.sonSunucu) < 25*time.Second {
		return
	}
	s := u.ws
	bas := time.Now()
	u.gonder(map[string]any{"type": "ping"})
	u.canlilik = u.sonra(10*time.Second, func() {
		u.canlilik = nil
		if u.ws != s || u.sonSunucu.After(bas) {
			return
		}
		s.kapat()
		u.ws = nil
		u.baglantiKoptu()
	})
}
