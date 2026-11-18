package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/TahaGemici/diszort/cli/ekran"
	"github.com/pion/webrtc/v4"
)

// Paylaşım (web'deki "yayın"): ekran (X11 ya da Wayland) ve/veya bilgisayarın sesi. Duyurulan durum:
// null ya da {goruntu, ses} (goruntu:false = ekransız). Ses herkese gider; görüntü yalnızca izleyene.
// Başkalarının paylaşımını CLI izlemez: onlara "izlemiyorum" denir (görüntü gönderilmez), sesi gelir.

type yayinDurumu struct {
	ses      bool
	sesAygit string
	ekran    *ekran.Paylasim
	ekranAc  bool // ekran açılıyor (portalın seçim penceresi bekleniyor)
	ekransiz bool // ekran gizli: yalnızca ses gidiyor
}

func (y *yayinDurumu) var_() bool { return y.ses || y.ekran != nil }

func (u *Uygulama) yayinBilgisi() any {
	if !u.yayin.var_() {
		return nil
	}
	return map[string]bool{"goruntu": u.yayin.ekran != nil && !u.yayin.ekransiz, "ses": u.yayin.ses}
}

func (u *Uygulama) yayinOzeti() string {
	var p []string
	if u.yayin.ekran != nil {
		if u.yayin.ekransiz {
			p = append(p, "ekran gizli")
		} else {
			n := 0
			for _, es := range u.esler {
				if es.izliyor && es.durum == webrtc.PeerConnectionStateConnected {
					n++
				}
			}
			p = append(p, fmt.Sprintf("ekran (%d izliyor)", n))
		}
	}
	if u.yayin.ses {
		p = append(p, "ses")
	}
	return "paylaşıyorsun: " + strings.Join(p, " + ")
}

func (u *Uygulama) yayinDegisti() {
	u.izleriKaydet()
	if u.sesKanal != "" {
		u.gonder(map[string]any{"type": "yayin", "yayin": u.yayinBilgisi()})
	}
	u.istemGuncelle()
}

// paylasSes: bilgisayarın sesini paylaş. aygit "" = uygulamaların sesi (Diszort'un kendi çaldıkları
// hariç); bir giriş = o aygıtın sesi.
func (u *Uygulama) paylasSes(aygit string) {
	if u.sesKanal == "" {
		u.durum("Önce bir sesli kanala gir: /ses <kanal>", true)
		return
	}
	u.yayin.ses = true
	u.yayin.sesAygit = aygit
	u.motor.Paylasim(true, aygit)
	u.bitHizlariniAyarla()
	u.yayinDegisti()
	if aygit == "" {
		u.durum("Bilgisayarının sesi paylaşılıyor (Diszort'un çaldıkları hariç: kanaldakiler kendi sesini duymaz).", false)
		u.sonra(1500*time.Millisecond, func() {
			if !u.yayin.ses || u.yayin.sesAygit != "" {
				return
			}
			if k := u.motor.PaylasimKaynaklari(); len(k) > 0 {
				u.durum("Şu an paylaşılan uygulamalar: "+strings.Join(k, ", "), false)
			} else {
				u.durum("Şu an ses çalan bir uygulama yok; çalmaya başlayınca kendiliğinden paylaşılır.", false)
			}
		})
	} else {
		u.durum("Ses aygıtı paylaşılıyor: "+aygit+" (hoparlörünün monitörüyse kanaldakiler kendi sesini duyabilir).", false)
	}
}

// paylasEkran: ekranı paylaş (monitor: X11'de monitör numarası, 0 = birincil).
func (u *Uygulama) paylasEkran(monitor int) {
	if u.sesKanal == "" {
		u.durum("Önce bir sesli kanala gir: /ses <kanal>", true)
		return
	}
	if u.yayin.ekran != nil {
		if u.yayin.ekransiz {
			u.ekranGizle(false)
			return
		}
		u.durum("Ekranın zaten paylaşılıyor ("+u.yayin.ekran.Bilgi()+"). Bitirmek için /paylaş dur ekran.", false)
		return
	}
	if u.yayin.ekranAc {
		return
	}
	oturum := ekran.Oturum()
	if oturum == "" {
		u.durum("Ekran paylaşılamıyor: masaüstü oturumu bulunamadı (DISPLAY ya da WAYLAND_DISPLAY yok).", true)
		return
	}
	u.yayin.ekranAc = true
	if oturum == "wayland" {
		if u.ayar.EkranIzni == "" {
			u.durum("Masaüstünün açtığı pencereden paylaşılacak ekranı (ya da pencereyi) seç…", false)
		}
	}
	secim := ekran.Secim{Monitor: monitor, Kare: u.ayar.Ses.Kare, IzinBelirteci: u.ayar.EkranIzni}
	go func() {
		p, err := ekran.Baslat(secim)
		u.calistir(func() {
			u.yayin.ekranAc = false
			if err != nil {
				u.durum("Ekran paylaşılamadı: "+err.Error(), true)
				return
			}
			if u.sesKanal == "" || u.yayin.ekran != nil {
				p.Durdur()
				return
			}
			if p.IzinBelirteci != "" && p.IzinBelirteci != u.ayar.EkranIzni {
				u.ayar.EkranIzni = p.IzinBelirteci
				u.ayarKaydet()
			}
			p.Gonder = goruntuGonder
			p.IzleyenVar = goruntuIzleyenVar
			izler.mu.Lock()
			izler.kareIste = p.AnahtarKare
			izler.mu.Unlock()
			u.yayin.ekran = p
			u.yayin.ekransiz = false
			for _, es := range u.esler {
				es.izliyor = true
			}
			u.yayinDegisti()
			u.durum("Ekranın paylaşılıyor: "+p.Bilgi()+(map[bool]string{true: "", false: " · bilgisayarın sesi için: /paylaş ses"}[u.yayin.ses]), false)
			go func() {
				<-p.Bitti
				u.calistir(func() { u.ekranBitti(p) })
			}()
		})
	}()
}

// ekranBitti: yakalama kendiliğinden bitti (pencere kapandı, sistemden durduruldu, hata).
func (u *Uygulama) ekranBitti(p *ekran.Paylasim) {
	if u.yayin.ekran != p {
		return
	}
	u.yayin.ekran = nil
	u.yayin.ekransiz = false
	izler.mu.Lock()
	izler.kareIste = nil
	izler.mu.Unlock()
	if p.Hata != nil {
		u.durum("Ekran paylaşımı bitti: "+p.Hata.Error(), true)
	}
	if u.yayin.ses {
		u.durum("Ses paylaşımı sürüyor.", false)
	}
	u.yayinDegisti()
}

// ekranGizle: ekranı gizle/göster (yakalama durur; ses paylaşımı sürer).
func (u *Uygulama) ekranGizle(gizli bool) {
	if u.yayin.ekran == nil {
		u.durum("Ekran paylaşılmıyor.", true)
		return
	}
	if gizli && !u.yayin.ses {
		u.durum("Ekranı gizlemek için önce sesi paylaş (/paylaş ses) ya da paylaşımı bitir (/paylaş dur).", true)
		return
	}
	u.yayin.ekransiz = gizli
	u.yayin.ekran.Gizle(gizli)
	u.yayinDegisti()
	if gizli {
		u.durum("Ekranın gizlendi; yalnızca ses gidiyor.", false)
	} else {
		u.durum("Ekranın yeniden görünüyor.", false)
	}
}

// yayinDurdur: paylaşımı bitir (bildir=false: kanaldan çıkılırken).
func (u *Uygulama) yayinDurdur(bildir bool) {
	vardi := u.yayin.var_()
	if u.yayin.ekran != nil {
		u.yayin.ekran.Durdur()
		u.yayin.ekran = nil
	}
	izler.mu.Lock()
	izler.kareIste = nil
	izler.mu.Unlock()
	if u.yayin.ses {
		u.motor.Paylasim(false, "")
	}
	u.yayin.ses = false
	u.yayin.ekransiz = false
	for _, es := range u.esler {
		es.izliyor = true
	}
	if bildir {
		u.yayinDegisti()
		if vardi {
			u.durum("Paylaşım bitti.", false)
		}
	} else {
		u.izleriKaydet()
	}
}

func (u *Uygulama) ekranDurdur() {
	if u.yayin.ekran == nil {
		u.durum("Ekran paylaşılmıyor.", true)
		return
	}
	if !u.yayin.ses {
		u.yayinDurdur(true)
		return
	}
	u.yayin.ekran.Durdur()
	u.yayin.ekran = nil
	u.yayin.ekransiz = false
	u.yayinDegisti()
	u.durum("Ekran paylaşımı bitti; ses paylaşımı sürüyor.", false)
}

func (u *Uygulama) sesPaylasimiDurdur() {
	if !u.yayin.ses {
		u.durum("Ses paylaşılmıyor.", true)
		return
	}
	if u.yayin.ekran == nil || u.yayin.ekransiz {
		u.yayinDurdur(true)
		return
	}
	u.motor.Paylasim(false, "")
	u.yayin.ses = false
	u.yayinDegisti()
	u.durum("Ses paylaşımı bitti; ekranın paylaşılıyor.", false)
}

// izleGeldi: o, ekranımı izliyor mu (izlemiyorsa görüntü gönderilmez).
func (u *Uygulama) izleGeldi(ad string, izle bool) {
	es := u.esler[ad]
	if es == nil {
		return
	}
	es.izliyor = izle
	u.izleriKaydet()
}

// izleGerekiyorsa: eş ekranını paylaşıyorsa ona "izlemiyorum" de (CLI görüntü göstermez).
func (u *Uygulama) izleGerekiyorsa(es *Es) {
	if d := u.sesDurumlari[es.ad]; d.Yayin != nil && d.Yayin.Goruntu {
		u.gonder(map[string]any{"type": "izle", "to": es.ad, "izle": false})
	}
}

// yayinDurumlariDegisti: kanaldakilerin paylaşımı değişti (sunucudan).
func (u *Uygulama) yayinDurumlariDegisti(onceki map[string]SesKisi) {
	if u.sesKanal == "" {
		return
	}
	for ad, es := range u.esler {
		o := onceki[ad].Yayin
		s := u.sesDurumlari[ad].Yayin
		switch {
		case o != nil && s == nil:
			u.ui.Yaz(u.ui.Soluk("· ") + u.ui.Ad(ad) + u.ui.Soluk(" paylaşımı bitirdi"))
			u.ton("kisi-cikti")
		case o == nil && s != nil:
			if s.Goruntu {
				u.izleGerekiyorsa(es)
				u.ui.Yaz(u.ui.Soluk("· ") + u.ui.Ad(ad) + u.ui.Soluk(" ekranını paylaşıyor (görüntüsü burada gösterilmez; sesi geliyor)"))
			} else {
				u.ui.Yaz(u.ui.Soluk("· ") + u.ui.Ad(ad) + u.ui.Soluk(" ekransız paylaşıyor (yalnızca ses)"))
			}
			u.ton("kisi-girdi")
		case o != nil && s != nil && o.Goruntu != s.Goruntu:
			if s.Goruntu {
				u.izleGerekiyorsa(es)
			}
		}
	}
}

// goruntuHiziAyarla: ekranın bit hızı: izleyenlerin bant tahminlerinin (REMB) en küçüğü; sunucu
// üzerinden (TURN) giden bağlantıda en çok 3 Mbit/s (sunucu fazlasını atar).
func (u *Uygulama) goruntuHiziAyarla() {
	if u.yayin.ekran == nil || u.yayin.ekransiz {
		return
	}
	hiz := 0
	for _, es := range u.esler {
		if !es.izliyor || es.durum != webrtc.PeerConnectionStateConnected {
			continue
		}
		r := int(es.remb.Load() / 1000)
		if r == 0 {
			r = 2500
		}
		r = r * 85 / 100
		if es.sonTip == "TURN" {
			r = min(r, 3000)
		}
		if hiz == 0 || r < hiz {
			hiz = r
		}
	}
	if hiz > 0 {
		u.yayin.ekran.BitHizi(min(20000, max(300, hiz)))
	}
}
