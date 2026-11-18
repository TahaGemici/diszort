package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/TahaGemici/diszort/cli/ses"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// Sesli kanal: giriş/çıkış, mikrofon, sağırlık, eşler, kurtarma döngüsü, bit hızları.
// Bkz. web/ana.js "sesli kanal".

func getenvBool(ad string) bool { v := os.Getenv(ad); return v == "1" || v == "true" }

// mikSessizMi: kanaldakilere ses gitmiyor (kapalı, sağır ya da mikrofon yok).
func (u *Uygulama) mikSessizMi() bool {
	return u.ayar.Ses.MikKapali || u.ayar.Ses.Sagir || !u.mikVar
}

func (u *Uygulama) esSayisi() int {
	n := 0
	for _, es := range u.esler {
		if es.bekleniyor.IsZero() {
			n++
		}
	}
	return n
}

func esikDb(esik int) float64 {
	if esik <= 0 {
		return math.NaN()
	}
	return -60 + float64(esik)/2
}

func (u *Uygulama) mikAyari() ses.MikAyari {
	return ses.MikAyari{Aygit: u.ayar.Ses.Mik, Kazanc: float64(u.ayar.Ses.MikSeviye) / 100, EsikDb: esikDb(u.ayar.Ses.Esik)}
}

// mikUygula: mikrofon açık olmalı mı? Sesli kanaldayken (ya da denemede), susturulmamış ve sağır
// değilken. Susturulunca mikrofon bırakılır (ses sunucusunda "kullanılıyor" görünmez).
func (u *Uygulama) mikUygula() {
	acik := (u.sesKanal != "" || u.sesGiriliyor) && !u.ayar.Ses.MikKapali && !u.ayar.Ses.Sagir
	u.motor.Mikrofon(acik || u.denemede, u.mikAyari())
}

func (u *Uygulama) sesAc(kanal string) {
	if u.sesKanal == kanal {
		u.durum("Zaten bu kanaldasın.", false)
		return
	}
	if u.sesGiriliyor {
		return
	}
	if !u.bagli {
		u.durum("Sunucuya bağlanmadan sesli kanala girilmez.", true)
		return
	}
	u.sesGiriliyor = true
	u.sesHedef = kanal
	u.motor.Cikis(true, u.ayar.Ses.Hoparlor)
	u.motor.Sagir(u.ayar.Ses.Sagir)
	u.mikUygula()
	u.iceTazeMi()
	u.gonder(map[string]any{"type": "ses-gir", "kanal": kanal, "sessiz": u.mikSessizMi(), "sagir": u.ayar.Ses.Sagir, "yayin": u.yayinBilgisi()})
	u.sonra(10*time.Second, func() {
		if u.sesGiriliyor && u.sesHedef == kanal {
			u.sesGiriliyor = false
			u.sesHedef = ""
			if u.sesKanal == "" {
				u.motor.Cikis(false, "")
				u.mikUygula()
			}
			u.istemGuncelle()
		}
	})
	u.istemGuncelle()
}

func (u *Uygulama) sesGirisiBasarisiz() {
	if !u.sesGiriliyor && u.sesKanal != "" {
		return
	}
	u.sesGiriliyor = false
	u.sesHedef = ""
	if u.sesKanal == "" {
		u.sesKapat(false)
	}
	u.istemGuncelle()
}

func (u *Uygulama) sesKatil(m Gelen) {
	kanal := m.Kanal
	devam := m.Devam && u.sesKanal == kanal
	if len(m.Ice) > 0 {
		u.iceAyarla(m.Ice)
	}
	yeniGiris := !devam && u.sesKanal != kanal
	u.sesGiriliyor = false
	u.sesHedef = ""
	if !devam {
		for ad := range u.esler {
			u.esKapat(ad)
		}
	}
	u.sesKanal = kanal
	var kisiler []string
	json.Unmarshal(m.Kisiler, &kisiler)
	liste := map[string]bool{}
	for _, a := range kisiler {
		if a != "" && a != u.ben {
			liste[a] = true
		}
	}
	if devam {
		for _, es := range u.esler {
			if !liste[es.ad] && es.bekleniyor.IsZero() {
				es.bekleniyor = time.Now()
			}
		}
	}
	for ad := range liste {
		u.esGirdi(ad, devam, false)
	}
	u.motor.Cikis(true, u.ayar.Ses.Hoparlor)
	u.mikUygula()
	u.bitHizlariniAyarla()
	if yeniGiris {
		ek := ""
		if !u.ayar.Ses.MikKapali && !u.ayar.Ses.Sagir && !u.motor.MikDurumu().Acik {
			ek = u.ui.Soluk(" (mikrofon açılıyor…)")
		}
		u.ui.Yaz(u.ui.Yesil("♪ "+u.kanalAdi(kanal)+" kanalına girdin") + ek + u.ui.Soluk(" · /mik · /sağır · /ayrıl · /paylaş"))
		if len(liste) > 0 {
			var adlar []string
			for a := range liste {
				adlar = append(adlar, a)
			}
			sort.Strings(adlar)
			u.ui.Yaz(u.ui.Soluk("  kanalda: " + strings.Join(adlar, ", ")))
		}
		u.ton("giris")
		u.taniGonder(map[string]any{"olay": "kanala-girdi", "istemci": "cli " + surum})
	}
	u.istemGuncelle()
}

func (u *Uygulama) sesKapat(bildir bool) {
	if bildir && u.bagli && (u.sesKanal != "" || u.sesHedef != "") {
		u.gonder(map[string]any{"type": "ses-cik"})
	}
	vardi := u.sesKanal != ""
	if vardi {
		u.ton("cikis")
	}
	u.sesKanal = ""
	u.sesHedef = ""
	u.sesGiriliyor = false
	for ad := range u.esler {
		u.esKapat(ad)
	}
	u.yayinDurdur(false)
	u.mikUygula()
	// Çıkış sesi çalsın diye hoparlör biraz sonra kapanır.
	u.sonra(400*time.Millisecond, func() {
		if u.sesKanal == "" && !u.sesGiriliyor {
			u.motor.Cikis(false, "")
		}
	})
	if vardi && bildir {
		u.durum("Sesli kanaldan ayrıldın.", false)
	}
	u.istemGuncelle()
}

func (u *Uygulama) mikDegistir() {
	s := &u.ayar.Ses
	if s.Sagir {
		s.Sagir = false
		s.MikKapali = false
	} else {
		s.MikKapali = !s.MikKapali
	}
	u.ayarKaydet()
	u.sesDurumunuUygula()
	if s.MikKapali {
		u.ton("sessiz")
		u.durum("Mikrofon kapalı.", false)
	} else {
		u.ton("acik")
		u.durum("Mikrofon açık.", false)
	}
}

func (u *Uygulama) sagirDegistir() {
	s := &u.ayar.Ses
	s.Sagir = !s.Sagir
	u.ayarKaydet()
	u.sesDurumunuUygula()
	if s.Sagir {
		u.ton("sessiz")
		u.durum("Sağırlaştırıldın: gelen sesler ve mikrofonun kapalı.", false)
	} else {
		u.ton("acik")
		u.durum("Sesler açık.", false)
	}
}

func (u *Uygulama) sesDurumunuUygula() {
	u.motor.Sagir(u.ayar.Ses.Sagir)
	u.mikUygula()
	if u.sesKanal != "" {
		u.gonder(map[string]any{"type": "sessiz", "sessiz": u.mikSessizMi(), "sagir": u.ayar.Ses.Sagir})
	}
	u.istemGuncelle()
}

// ---------------------------------------------------------------- eşler

func (u *Uygulama) esOlustur(ad string) *Es {
	es := u.esYap(ad)
	u.esler[ad] = es
	return es
}

func (u *Uygulama) esGirdi(ad string, devam, bildir bool) {
	if ad == "" || ad == u.ben || u.sesKanal == "" {
		return
	}
	es := u.esler[ad]
	if es != nil {
		es.bekleniyor = time.Time{}
	}
	if es != nil && devam && es.pc != nil {
		if esSaglikli(es) || es.turnYenile {
			u.esGeriDondu(es)
			return
		}
		if !es.teklifci {
			u.yenileIste(es, true)
		} else if es.pc.RemoteDescription() != nil && es.pc.SignalingState() == webrtc.SignalingStateStable {
			u.iceYenile(es)
		} else {
			u.esYenidenKur(es)
		}
		return
	}
	if es != nil && !devam {
		u.esKapat(ad)
		es = nil
	}
	if es == nil {
		es = u.esOlustur(ad)
	}
	if es.pc == nil && es.teklifci {
		u.pcKur(es, "")
	}
	if !es.teklifci && devam {
		u.yenileIste(es, true)
	}
	if bildir && !devam {
		u.ui.Yaz(u.ui.Soluk("· ") + u.ui.Ad(ad) + u.ui.Soluk(" sesli kanala girdi"))
		u.ton("kisi-girdi")
	}
	u.bitHizlariniAyarla()
	u.istemGuncelle()
}

func (u *Uygulama) esCikti(ad string) {
	if u.esler[ad] == nil {
		return
	}
	u.esKapat(ad)
	u.ui.Yaz(u.ui.Soluk("· ") + u.ui.Ad(ad) + u.ui.Soluk(" sesli kanaldan çıktı"))
	u.ton("kisi-cikti")
	u.bitHizlariniAyarla()
	u.istemGuncelle()
}

func (u *Uygulama) esKapat(ad string) {
	es := u.esler[ad]
	if es == nil {
		return
	}
	u.pcKapat(es)
	delete(u.esler, ad)
	u.izleriKaydet()
}

// ---------------------------------------------------------------- giden izlerin kaydı

// izKaydi: ses motorunun ve ekran kodlayıcısının (kendi goroutine'lerinde) paket yazdığı izler.
type izKaydi struct {
	mu       sync.Mutex
	mik      []*sesIzi
	pay      []*sesIzi
	goruntu  []*webrtc.TrackLocalStaticSample
	kareIste func()
}

var izler izKaydi

// izleriKaydet: bağlı eşlerin izlerini kaydet (görüntü yalnızca ekranımı izleyenlere).
func (u *Uygulama) izleriKaydet() {
	var mik, pay []*sesIzi
	var goruntu []*webrtc.TrackLocalStaticSample
	goster := u.yayin.ekran != nil && !u.yayin.ekransiz
	for _, es := range u.esler {
		if es.pc == nil || !es.izlerEklendi {
			continue
		}
		if es.mikIz != nil {
			mik = append(mik, es.mikIz)
		}
		if es.payIz != nil && u.yayin.ses {
			pay = append(pay, es.payIz)
		}
		if goster && es.izliyor && es.goruntuIz != nil && es.durum == webrtc.PeerConnectionStateConnected {
			goruntu = append(goruntu, es.goruntuIz)
		}
	}
	izler.mu.Lock()
	yeniIzleyen := len(goruntu) > len(izler.goruntu)
	izler.mik, izler.pay, izler.goruntu = mik, pay, goruntu
	izler.mu.Unlock()
	if yeniIzleyen {
		u.anahtarKareIste()
	}
}

func (u *Uygulama) sesMotorunuBagla() {
	u.motor.MikPaketi = func(veri []byte, sure int, basla bool) {
		izler.mu.Lock()
		liste := izler.mik
		izler.mu.Unlock()
		for _, iz := range liste {
			iz.gonder(veri, sure, basla)
		}
	}
	u.motor.PaylasimPaketi = func(veri []byte, sure int, basla bool) {
		izler.mu.Lock()
		liste := izler.pay
		izler.mu.Unlock()
		for _, iz := range liste {
			iz.gonder(veri, sure, basla)
		}
	}
}

// goruntuGonder: kodlanmış bir ekran karesini izleyenlere gönder (ekran goroutine'inden).
func goruntuGonder(kare []byte, sure time.Duration) {
	izler.mu.Lock()
	liste := izler.goruntu
	izler.mu.Unlock()
	for _, iz := range liste {
		iz.WriteSample(media.Sample{Data: kare, Duration: sure})
	}
}

func goruntuIzleyenVar() bool {
	izler.mu.Lock()
	defer izler.mu.Unlock()
	return len(izler.goruntu) > 0
}

// anahtarKareIste: ekran kodlayıcısı bir sonraki kareyi anahtar kare yapsın.
func (u *Uygulama) anahtarKareIste() {
	izler.mu.Lock()
	f := izler.kareIste
	izler.mu.Unlock()
	if f != nil {
		f()
	}
}

// ---------------------------------------------------------------- bit hızları

// bitHizlariniAyarla: gönderilen Opus bit hızları (kbps tavanı; kalabalık kanalda kişi başına düşer)
// ve kayıp yüzdesi (kodlayıcının kendi yedeği buna göre).
func (u *Uygulama) bitHizlariniAyarla() {
	n := max(1, u.esSayisi())
	mik := int(math.Round(math.Min(float64(u.ayar.Ses.Kalite), math.Max(40, 640/float64(n)))))
	pay := int(math.Round(math.Min(float64(u.ayar.Ses.YayinSes), math.Max(64, 3000/float64(n)))))
	var mikKayip, payKayip uint32
	for _, es := range u.esler {
		mikKayip = max(mikKayip, es.mikKayip.Load())
		payKayip = max(payKayip, es.payKayip.Load())
	}
	u.motor.MikBitHizi(mik*1000, int(mikKayip/10))
	u.motor.PaylasimBitHizi(pay*1000, int(payKayip/10))
	for _, es := range u.esler {
		u.redleriAyarla(es)
	}
}

// ---------------------------------------------------------------- saniyelik işler

var sonIstatistik time.Time

func (u *Uygulama) sesSaniyelik() {
	u.canlilikDenetle()
	if u.sesKanal == "" {
		return
	}
	// Mikrofon gerçekten açıldı mı / kapandı mı: kanaldakilere bildir.
	md := u.motor.MikDurumu()
	if md.Acik != u.mikVar {
		u.mikVar = md.Acik
		u.gonder(map[string]any{"type": "sessiz", "sessiz": u.mikSessizMi(), "sagir": u.ayar.Ses.Sagir})
		u.istemGuncelle()
	}
	u.kurtarmaTuru()
	u.bitHizlariniAyarla()
	if time.Since(sonIstatistik) > 2*time.Second {
		sonIstatistik = time.Now()
		for _, es := range u.esler {
			if es.pc != nil {
				go u.esIstatistik(es)
			}
		}
	}
	u.goruntuHiziAyarla()
	u.taniBelki()
}

// donusBeklemesi: sunucu yeniden başlayınca listede olmayan eş ne kadar beklenir.
func (u *Uygulama) donusBeklemesi() time.Duration {
	ms := math.Max(25000, u.girisAraligi/math.Max(1, u.girisKovasi)*float64(len(u.esler)+1)+15000)
	return time.Duration(ms) * time.Millisecond
}

// kurtarmaTuru: bozuk ya da hiç kurulamayan bağlantıları onar (bkz. web: kurtarmaTuru).
func (u *Uygulama) kurtarmaTuru() {
	if u.sesKanal == "" {
		return
	}
	simdi := time.Now()
	for _, es := range u.esler {
		if !es.bekleniyor.IsZero() {
			gecen := simdi.Sub(es.bekleniyor)
			olu := es.pc == nil || es.durum == webrtc.PeerConnectionStateFailed || es.durum == webrtc.PeerConnectionStateClosed
			if gecen > u.donusBeklemesi() || (olu && gecen > 25*time.Second) {
				u.esKapat(es.ad)
			}
			continue
		}
		if !u.bagli {
			continue
		}
		if es.pc == nil {
			if es.teklifci {
				u.esYenidenKur(es)
			} else if simdi.Sub(es.olusturma) > 8*time.Second {
				u.yenileIste(es, false)
			}
			continue
		}
		if es.teklifci && es.pc.SignalingState() == webrtc.SignalingStateStable && es.pc.LocalDescription() == nil && es.pc.RemoteDescription() == nil {
			u.teklifVer(es, false)
			continue
		}
		d := es.durum
		if d == webrtc.PeerConnectionStateConnected {
			es.sorunBasi = time.Time{}
			es.kurtarma = 0
			continue
		}
		if es.teklifci && es.pc.SignalingState() == webrtc.SignalingStateHaveLocalOffer && simdi.Sub(es.teklifZamani) > 8*time.Second && es.pc.LocalDescription() != nil {
			es.teklifZamani = simdi
			u.aciklamaGonder(es)
		}
		if es.sorunBasi.IsZero() {
			es.sorunBasi = simdi
		}
		esik := 12 * time.Second
		switch d {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			esik = 0
		case webrtc.PeerConnectionStateDisconnected:
			esik = 5 * time.Second
		}
		if simdi.Sub(es.sorunBasi) < esik {
			continue
		}
		bekleme := time.Duration(math.Min(30000, 4000*math.Pow(2, float64(min(es.kurtarma, 3))))) * time.Millisecond
		if simdi.Sub(es.sonKurtarma) < bekleme {
			continue
		}
		es.sonKurtarma = simdi
		es.kurtarma++
		if es.teklifci {
			if es.kurtarma <= 2 && es.pc.RemoteDescription() != nil && es.pc.SignalingState() == webrtc.SignalingStateStable {
				u.iceYenile(es)
			} else {
				u.esYenidenKur(es)
			}
		} else {
			u.yenileIste(es, true)
		}
	}
}

// ---------------------------------------------------------------- teşhis

var sonTani time.Time

func (u *Uygulama) taniGonder(veri map[string]any) {
	if u.sesKanal == "" && veri["olay"] != "kanala-girdi" {
		return
	}
	u.gonder(map[string]any{"type": "tani", "veri": veri})
}

// taniBelki: 10 saniyede bir kısa durum (sunucu yalnızca günlüğe yazar).
func (u *Uygulama) taniBelki() {
	if time.Since(sonTani) < 10*time.Second {
		return
	}
	sonTani = time.Now()
	esler := map[string]any{}
	for _, es := range u.esler {
		d := map[string]any{"durum": es.durum.String(), "tip": es.sonTip, "rttMs": math.Round(es.rtt * 1000)}
		if es.mikKaynak != nil {
			s := es.mikKaynak.Ses.Durum()
			d["mik"] = map[string]any{"alinan": s.Alinan, "gec": s.Gec, "uydurulan": s.Uydurulan, "kurtarilan": s.Kurtarilan, "tamponMs": math.Round(s.TamponMs), "hedefMs": math.Round(s.HedefMs)}
		}
		if es.payKaynak != nil {
			s := es.payKaynak.Ses.Durum()
			d["yayin"] = map[string]any{"alinan": s.Alinan, "uydurulan": s.Uydurulan, "tamponMs": math.Round(s.TamponMs)}
		}
		esler[es.ad] = d
	}
	md := u.motor.MikDurumu()
	u.taniGonder(map[string]any{"istemci": "cli " + surum, "esler": esler, "mik": map[string]any{"acik": md.Acik, "aygit": md.Aygit, "konusma": md.Olcum.Konusma, "esikAcik": md.Olcum.Acik}, "yayin": u.yayinBilgisi()})
}

// sesDurumuYaz: /durum çıktısı (sesli kanal kısmı).
func (u *Uygulama) sesDurumuYaz() {
	if u.sesKanal == "" {
		u.ui.Yaz("Sesli kanalda değilsin." + u.ui.Soluk(" (/ses <kanal>)"))
		return
	}
	md := u.motor.MikDurumu()
	mik := "kapalı"
	switch {
	case u.ayar.Ses.Sagir:
		mik = "sağır"
	case md.Acik:
		mik = fmt.Sprintf("açık (%s) · konuşma %%%d · gürültü %+.0f dB", firstNonEmpty(md.Aygit, "varsayılan"), int(md.Olcum.Konusma*100), math.Min(0, md.Olcum.RnnDb-md.Olcum.GirisDb))
		if u.ayar.Ses.Esik > 0 {
			if md.Olcum.Acik {
				mik += " · ses gidiyor"
			} else {
				mik += " · eşiğin altında"
			}
		}
	case !u.ayar.Ses.MikKapali:
		mik = "açılamadı (yalnızca dinliyorsun)"
	}
	u.ui.Yaz(u.ui.Kalin("♪ "+u.kanalAdi(u.sesKanal)) + u.ui.Soluk(" · mikrofon: ") + mik)
	var adlar []string
	for ad := range u.esler {
		adlar = append(adlar, ad)
	}
	sort.Strings(adlar)
	for _, ad := range adlar {
		es := u.esler[ad]
		baglanti := map[webrtc.PeerConnectionState]string{webrtc.PeerConnectionStateConnected: "bağlı", webrtc.PeerConnectionStateConnecting: "bağlanıyor…", webrtc.PeerConnectionStateNew: "bağlanıyor…", webrtc.PeerConnectionStateDisconnected: "kesiliyor…", webrtc.PeerConnectionStateFailed: "koptu · yeniden deneniyor"}[es.durum]
		if es.durum == webrtc.PeerConnectionStateConnected && es.sonTip != "" {
			baglanti = fmt.Sprintf("%s · %d ms", es.sonTip, int(math.Round(es.rtt*1000)))
		}
		if !es.bekleniyor.IsZero() {
			baglanti = "geri dönmesi bekleniyor"
		}
		parca := []string{baglanti}
		d := u.sesDurumlari[ad]
		if d.Sagir {
			parca = append(parca, "sağır")
		} else if d.Sessiz {
			parca = append(parca, "mikrofonu kapalı")
		}
		if es.mikKaynak != nil {
			s := es.mikKaynak.Ses.Durum()
			if s.Konusuyor {
				parca = append(parca, u.ui.Yesil("konuşuyor"))
			}
			if s.Alinan > 0 {
				parca = append(parca, fmt.Sprintf("tampon %d ms", int(s.TamponMs)))
				if s.Uydurulan+s.Kurtarilan > 0 {
					parca = append(parca, fmt.Sprintf("kayıp %d", s.Uydurulan+s.Kurtarilan))
				}
			}
		}
		k := u.ayar.kisi(ad)
		if k.Sustur {
			parca = append(parca, "sende susturulmuş")
		} else if k.Seviye != 100 {
			parca = append(parca, fmt.Sprintf("seviye %%%d", k.Seviye))
		}
		if y := d.Yayin; y != nil {
			p := "paylaşıyor"
			if !y.Goruntu {
				p = "ekransız paylaşıyor"
			}
			if es.payKaynak != nil && es.payKaynak.Ses.Durum().Konusuyor {
				p += " (ses geliyor)"
			}
			if k.YayinSustur {
				p += ", sende susturulmuş"
			}
			parca = append(parca, p)
		}
		u.ui.Yaz("  " + u.ui.Ad(ad) + " " + u.ui.Soluk(strings.Join(parca, " · ")))
	}
	if len(adlar) == 0 {
		u.ui.Yaz(u.ui.Soluk("  kanalda başka kimse yok"))
	}
	if u.yayin.var_() {
		u.ui.Yaz("  " + u.ui.Mavi("paylaşımın: "+u.yayinOzeti()))
	}
}
