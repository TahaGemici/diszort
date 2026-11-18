package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

// P2P dosya paylaşımı (bkz. web/ana.js "P2P dosya paylaşımı"). Dosyalar sunucuya yüklenmez: paylaşan
// tutar, sohbete yalnızca adı/boyutu yazılır; isteyen doğrudan bir WebRTC bağlantısı kurar (indiren
// teklif eder) ve dosya veri kanalından akar.
//
// Veri kanalı protokolü (alan açar): alan → {istek: id, baslangic}; gönderen → {tamam, boyut} ya da
// {hata: 'yok' | 'iptal'}, sonra ikili parçalar ve {bitti}. Alan diske yazdıkça {onay: bayt} der;
// gönderen, alanın yazdığından en fazla PENCERE kadar ileri gider.
//
// CLI'da paylaşılan dosyalar ayar dosyasına yazılır: program yeniden açılınca da sunulmaya devam eder.

const (
	parca       = 64 * 1024
	okumaBoyu   = 1024 * 1024
	tamponUst   = 4 * 1024 * 1024
	pencere     = 32 * 1024 * 1024
	onayAraligi = 4 * 1024 * 1024
)

type dosyaKaydi struct {
	DosyaBilgi
	sahip string
	no    int
}

type dosyaBagi struct {
	id          string
	ad          string
	alici       bool
	pc          *webrtc.PeerConnection
	adaylar     []webrtc.ICECandidateInit
	aktarimlar  map[any]bool
	kapandi     bool
	sonKullanim time.Time
	turn        bool
}

type gelenAktarim struct {
	id        string
	bilgi     *dosyaKaydi
	kisi      string
	hedef     string
	mu        sync.Mutex
	f         *os.File
	alinan    int64
	onaylanan int64
	kanal     *webrtc.DataChannel
	bag       *dosyaBagi
	deneme    int
	bekleme   int
	durum     string
	bitti     bool
	sonGeldi  bool
	baslangic time.Time
	hizBaz    int64
	acilis    *time.Timer
	yeniden   *time.Timer
}

type gidenAktarim struct {
	id         string
	ad         string
	kisi       string
	yol        string
	boyut      int64
	gonderilen atomic.Int64
	onaylanan  atomic.Int64
	kanal      *webrtc.DataChannel
	bag        *dosyaBagi
	bitti      atomic.Bool
	uyandir    chan struct{}
	baslangic  time.Time
}

type yerelDosya struct {
	PaylasilanDosya
}

type dosyaDurumu struct {
	mu            sync.Mutex
	paylasimlarim map[string]*yerelDosya
	sunulanlar    map[string]bool
	bilgiler      map[string]*dosyaKaydi
	numaralar     []string
	baglar        map[string]*dosyaBagi
	indirmeler    map[string]*gelenAktarim
	gonderimler   map[*gidenAktarim]bool
}

func (d *dosyaDurumu) kur() {
	d.paylasimlarim = map[string]*yerelDosya{}
	d.sunulanlar = map[string]bool{}
	d.bilgiler = map[string]*dosyaKaydi{}
	d.baglar = map[string]*dosyaBagi{}
	d.indirmeler = map[string]*gelenAktarim{}
	d.gonderimler = map[*gidenAktarim]bool{}
}

// yukle: ayar dosyasındaki paylaşımlar (dosya hâlâ yerindeyse ve boyutu aynıysa).
func (d *dosyaDurumu) yukle(u *Uygulama) {
	var kalan []PaylasilanDosya
	for _, p := range u.ayar.Paylasilanlar {
		bilgi, err := os.Stat(p.Yol)
		if err != nil || !bilgi.Mode().IsRegular() || bilgi.Size() != p.Boyut {
			continue
		}
		d.paylasimlarim[p.ID] = &yerelDosya{p}
		kalan = append(kalan, p)
	}
	u.ayar.Paylasilanlar = kalan
}

func (d *dosyaDurumu) kaydet(u *Uygulama) {
	var liste []PaylasilanDosya
	for _, p := range d.paylasimlarim {
		liste = append(liste, p.PaylasilanDosya)
	}
	sort.Slice(liste, func(i, j int) bool { return liste[i].Ad < liste[j].Ad })
	u.ayar.Paylasilanlar = liste
	u.ayarKaydet()
}

func (d *dosyaDurumu) idler() []string {
	var l []string
	for id := range d.paylasimlarim {
		l = append(l, id)
	}
	return l
}

func (d *dosyaDurumu) oturumHazir(u *Uygulama, sunulan []string) {
	d.sunulanlar = map[string]bool{}
	for _, id := range sunulan {
		d.sunulanlar[id] = true
	}
	if len(d.paylasimlarim) > 0 {
		u.gonder(map[string]any{"type": "dosya-sun", "idler": d.idler()})
	}
}

func (d *dosyaDurumu) sunulanlarGeldi(u *Uygulama, liste []string) {
	d.sunulanlar = map[string]bool{}
	for _, id := range liste {
		d.sunulanlar[id] = true
	}
}

// sunduklarimOnaylandi: sunucu yalnızca hâlâ sohbette duran ve benim paylaştığım dosyaları kabul eder.
func (d *dosyaDurumu) sunduklarimOnaylandi(u *Uygulama, idler []string) {
	gecerli := map[string]bool{}
	for _, id := range idler {
		gecerli[id] = true
	}
	degisti := false
	for id := range d.paylasimlarim {
		if !gecerli[id] {
			delete(d.paylasimlarim, id)
			degisti = true
		}
	}
	if degisti {
		d.kaydet(u)
	}
}

// bilgiEkle: sohbette görülen bir dosya (numara alır: /indir 3).
func (d *dosyaDurumu) bilgiEkle(b DosyaBilgi, sahip string) *dosyaKaydi {
	if k := d.bilgiler[b.ID]; k != nil {
		return k
	}
	d.numaralar = append(d.numaralar, b.ID)
	k := &dosyaKaydi{DosyaBilgi: b, sahip: sahip, no: len(d.numaralar)}
	d.bilgiler[b.ID] = k
	return k
}

func (u *Uygulama) dosyaSatiri(id string) string {
	d := &u.dosyalar
	k := d.bilgiler[id]
	if k == nil {
		return ""
	}
	s := u.ui.Mavi(fmt.Sprintf("[%d] ", k.no)) + u.ui.Kalin(k.Ad) + u.ui.Soluk(" · "+boyutYaz(k.Boyut))
	switch {
	case d.paylasimlarim[id] != nil:
		s += u.ui.Soluk(" · senin; sunuluyor")
	case d.indirmeler[id] != nil:
		s += u.ui.Soluk(" · indiriliyor…")
	case d.sunulanlar[id]:
		s += u.ui.Soluk(fmt.Sprintf(" · /indir %d", k.no))
	case k.sahip == u.ben:
		s += u.ui.Soluk(" · senin; artık sunulmuyor")
	default:
		s += u.ui.Soluk(" · " + k.sahip + " çevrimdışı (açılınca indirilebilir)")
	}
	return s
}

// dosyaBul: numarayla ya da ad başıyla.
func (u *Uygulama) dosyaBul(ara string) (*dosyaKaydi, error) {
	ara = strings.TrimPrefix(strings.TrimSpace(ara), "#")
	var n int
	if _, err := fmt.Sscanf(ara, "%d", &n); err == nil && fmt.Sprint(n) == ara {
		if n >= 1 && n <= len(u.dosyalar.numaralar) {
			return u.dosyalar.bilgiler[u.dosyalar.numaralar[n-1]], nil
		}
		return nil, fmt.Errorf("%d numaralı dosya yok", n)
	}
	var adaylar []*dosyaKaydi
	for _, id := range u.dosyalar.numaralar {
		k := u.dosyalar.bilgiler[id]
		if strings.EqualFold(k.Ad, ara) {
			return k, nil
		}
		if strings.HasPrefix(strings.ToLower(k.Ad), strings.ToLower(ara)) {
			adaylar = append(adaylar, k)
		}
	}
	if len(adaylar) == 1 {
		return adaylar[0], nil
	}
	if len(adaylar) > 1 {
		return nil, errors.New("birden çok dosya uyuyor; numarasını yaz")
	}
	return nil, errors.New("böyle bir dosya görülmedi (sohbette görünen dosyaların numarası var)")
}

// ---------------------------------------------------------------- paylaşma

func (u *Uygulama) dosyalariPaylas(yollar []string) {
	if u.aktifKanal == "" || !u.bagli {
		u.durum("Dosya paylaşmak için önce sunucuya bağlan ve bir yazılı kanal seç.", true)
		return
	}
	if len(yollar) > 20 {
		u.durum("Bir seferde en fazla 20 dosya paylaşılır.", true)
		yollar = yollar[:20]
	}
	adet := 0
	for _, yol := range yollar {
		yol = yolAc(yol)
		mutlak, err := filepath.Abs(yol)
		if err == nil {
			yol = mutlak
		}
		bilgi, err := os.Stat(yol)
		if err != nil {
			u.durum(yol+": bulunamadı.", true)
			continue
		}
		if !bilgi.Mode().IsRegular() {
			u.durum(yol+": düz bir dosya değil (klasör paylaşılamaz).", true)
			continue
		}
		if bilgi.Size() == 0 {
			u.durum(filepath.Base(yol)+": boş dosya paylaşılamaz.", true)
			continue
		}
		if f, err := os.Open(yol); err != nil {
			u.durum(yol+": okunamıyor.", true)
			continue
		} else {
			f.Close()
		}
		id := rastgeleHex(24)
		ad := filepath.Base(yol)
		tur := mime.TypeByExtension(strings.ToLower(filepath.Ext(ad)))
		if i := strings.Index(tur, ";"); i >= 0 {
			tur = tur[:i]
		}
		u.dosyalar.paylasimlarim[id] = &yerelDosya{PaylasilanDosya{ID: id, Yol: yol, Ad: ad, Boyut: bilgi.Size(), Tur: tur}}
		u.gonder(map[string]any{"type": "dosya-paylas", "kanal": u.aktifKanal, "id": id, "ad": ad, "boyut": bilgi.Size(), "tur": tur})
		adet++
	}
	if adet > 0 {
		u.dosyalar.kaydet(u)
		u.durum(fmt.Sprintf("%d dosya paylaşıldı; program açık kaldıkça (sonraki açılışlarda da) indirilebilir. Sunmayı bırakmak: /bırak <no>", adet), false)
	}
}

// yolAc: yapıştırılan yol: tırnaklar, file://, ~/, kaçışlı boşluklar.
func yolAc(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && (s[0] == '\'' || s[0] == '"') && s[len(s)-1] == s[0] {
		s = s[1 : len(s)-1]
	}
	if strings.HasPrefix(s, "file://") {
		s = urlAc(strings.TrimPrefix(s, "file://"))
	}
	if strings.HasPrefix(s, "~/") {
		if ev, err := os.UserHomeDir(); err == nil {
			s = filepath.Join(ev, s[2:])
		}
	}
	return strings.ReplaceAll(s, `\ `, " ")
}

// yollariAyir: "/dosya a.txt 'b c.pdf' d\ e.png" → yollar.
func yollariAyir(s string) []string {
	var yollar []string
	var b strings.Builder
	tirnak := rune(0)
	kacis := false
	for _, r := range s {
		switch {
		case kacis:
			b.WriteRune(r)
			kacis = false
		case r == '\\' && tirnak != '\'':
			kacis = true
		case tirnak != 0 && r == tirnak:
			tirnak = 0
		case tirnak == 0 && (r == '\'' || r == '"'):
			tirnak = r
		case tirnak == 0 && (r == ' ' || r == '\t' || r == '\n'):
			if b.Len() > 0 {
				yollar = append(yollar, b.String())
				b.Reset()
			}
		default:
			b.WriteRune(r)
		}
	}
	if b.Len() > 0 {
		yollar = append(yollar, b.String())
	}
	return yollar
}

func (u *Uygulama) paylasimiBirak(k *dosyaKaydi) {
	d := &u.dosyalar
	if d.paylasimlarim[k.ID] == nil {
		u.durum(k.Ad+" senin sunduğun bir dosya değil.", true)
		return
	}
	delete(d.paylasimlarim, k.ID)
	for akt := range d.gonderimler {
		if akt.id == k.ID {
			u.gonderimiIptalEt(akt)
		}
	}
	d.kaydet(u)
	u.gonder(map[string]any{"type": "dosya-sun", "idler": d.idler()})
	u.durum(k.Ad+" artık sunulmuyor.", false)
}

// ---------------------------------------------------------------- bağlantılar

func (u *Uygulama) dosyaSinyali(ad string, veri map[string]any) {
	u.gonder(map[string]any{"type": "dosya-sinyal", "to": ad, "veri": veri})
}

func (u *Uygulama) bagOlustur(id, ad string, alici bool) *dosyaBagi {
	pc, err := u.dosyaAPI().NewPeerConnection(u.pcAyari())
	if err != nil {
		u.gunluk("dosya bağlantısı kurulamadı: " + err.Error())
		return nil
	}
	bag := &dosyaBagi{id: id, ad: ad, alici: alici, pc: pc, aktarimlar: map[any]bool{}, sonKullanim: time.Now()}
	u.dosyalar.baglar[id] = bag
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		aday := c.ToJSON()
		u.calistir(func() {
			if !bag.kapandi {
				u.dosyaSinyali(ad, map[string]any{"tur": "aday", "bag": id, "aday": aday})
			}
		})
	})
	pc.OnConnectionStateChange(func(d webrtc.PeerConnectionState) {
		u.calistir(func() {
			if bag.kapandi {
				return
			}
			if d == webrtc.PeerConnectionStateFailed || d == webrtc.PeerConnectionStateClosed {
				u.bagKapat(bag, "Bağlantı koptu", false)
			}
		})
	})
	return bag
}

func (u *Uygulama) aliciBagi(ad string) *dosyaBagi {
	for _, b := range u.dosyalar.baglar {
		if b.alici && b.ad == ad && !b.kapandi {
			d := b.pc.ConnectionState()
			if d != webrtc.PeerConnectionStateFailed && d != webrtc.PeerConnectionStateClosed && d != webrtc.PeerConnectionStateDisconnected {
				return b
			}
		}
	}
	bag := u.bagOlustur(rastgeleKimlik(16), ad, true)
	if bag == nil {
		return nil
	}
	// Teklif, ilk veri kanalı açıldıktan sonra (SCTP satırı teklife girsin diye).
	u.calistir(func() {
		if bag.kapandi {
			return
		}
		teklif, err := bag.pc.CreateOffer(nil)
		if err == nil {
			err = bag.pc.SetLocalDescription(teklif)
		}
		if err != nil {
			u.bagKapat(bag, "Bağlantı kurulamadı", false)
			return
		}
		d := bag.pc.LocalDescription()
		u.dosyaSinyali(ad, map[string]any{"tur": "teklif", "bag": bag.id, "sdp": map[string]string{"type": d.Type.String(), "sdp": d.SDP}})
	})
	return bag
}

func (u *Uygulama) bagKapat(bag *dosyaBagi, neden string, karsiKapatti bool) {
	if bag.kapandi {
		return
	}
	bag.kapandi = true
	delete(u.dosyalar.baglar, bag.id)
	if !karsiKapatti && u.bagli {
		u.dosyaSinyali(bag.ad, map[string]any{"tur": "kapat", "bag": bag.id})
	}
	for a := range bag.aktarimlar {
		switch akt := a.(type) {
		case *gelenAktarim:
			u.aktarimKoptu(akt, firstNonEmpty(neden, "Bağlantı koptu"))
		case *gidenAktarim:
			u.gonderimBitti(akt, firstNonEmpty(neden, "bağlantı koptu"))
		}
	}
	go bag.pc.Close()
}

var bagKalibi = regexp.MustCompile(`^[a-z0-9]{8,40}$`)

func (u *Uygulama) dosyaSinyaliGeldi(ad string, ham json.RawMessage) {
	var v struct {
		Tur  string                     `json:"tur"`
		Bag  string                     `json:"bag"`
		Sdp  *webrtc.SessionDescription `json:"sdp"`
		Aday json.RawMessage            `json:"aday"`
	}
	if ad == "" || json.Unmarshal(ham, &v) != nil {
		return
	}
	bag := u.dosyalar.baglar[v.Bag]
	if bag != nil && bag.ad != ad {
		return
	}
	switch v.Tur {
	case "teklif":
		u.dosyaTeklifiGeldi(ad, v.Bag, v.Sdp, bag)
	case "yanit":
		if bag != nil && bag.alici && v.Sdp != nil && bag.pc.SignalingState() == webrtc.SignalingStateHaveLocalOffer {
			if err := bag.pc.SetRemoteDescription(*v.Sdp); err != nil {
				u.bagKapat(bag, "Bağlantı kurulamadı", false)
				return
			}
			u.dosyaAdaylari(bag)
		}
	case "aday":
		if bag == nil || len(v.Aday) == 0 {
			return
		}
		var a webrtc.ICECandidateInit
		if json.Unmarshal(v.Aday, &a) != nil {
			return
		}
		if bag.pc.RemoteDescription() != nil {
			bag.pc.AddICECandidate(a)
		} else if len(bag.adaylar) < 100 {
			bag.adaylar = append(bag.adaylar, a)
		}
	case "kapat":
		if bag != nil {
			u.bagKapat(bag, "Karşı taraf bağlantıyı kapattı", true)
		}
	case "ulasilamadi":
		for _, b := range u.dosyalar.baglar {
			if b.ad == ad {
				u.bagKapat(b, ad+" çevrimdışı", true)
			}
		}
	}
}

func (u *Uygulama) dosyaAdaylari(bag *dosyaBagi) {
	for _, a := range bag.adaylar {
		bag.pc.AddICECandidate(a)
	}
	bag.adaylar = nil
}

// dosyaTeklifiGeldi (gönderen): biri dosyalarımdan birini istemek için bağlanıyor.
func (u *Uygulama) dosyaTeklifiGeldi(ad, bagID string, sdp *webrtc.SessionDescription, bag *dosyaBagi) {
	if !bagKalibi.MatchString(bagID) || sdp == nil {
		return
	}
	if bag != nil && bag.alici {
		return
	}
	if len(u.dosyalar.paylasimlarim) == 0 {
		u.dosyaSinyali(ad, map[string]any{"tur": "kapat", "bag": bagID})
		return
	}
	if bag == nil {
		bag = u.bagOlustur(bagID, ad, false)
		if bag == nil {
			u.dosyaSinyali(ad, map[string]any{"tur": "kapat", "bag": bagID})
			return
		}
		bag.pc.OnDataChannel(func(dc *webrtc.DataChannel) {
			u.calistir(func() { u.gidenKanal(bag, dc) })
		})
	}
	err := bag.pc.SetRemoteDescription(*sdp)
	if err == nil {
		u.dosyaAdaylari(bag)
		var yanit webrtc.SessionDescription
		yanit, err = bag.pc.CreateAnswer(nil)
		if err == nil {
			err = bag.pc.SetLocalDescription(yanit)
		}
	}
	if err != nil {
		u.gunluk("dosya teklifi: " + err.Error())
		u.bagKapat(bag, "", false)
		return
	}
	d := bag.pc.LocalDescription()
	u.dosyaSinyali(ad, map[string]any{"tur": "yanit", "bag": bag.id, "sdp": map[string]string{"type": d.Type.String(), "sdp": d.SDP}})
}

// ---------------------------------------------------------------- gönderen

func kanalaYaz(dc *webrtc.DataChannel, v any) {
	if dc == nil || dc.ReadyState() != webrtc.DataChannelStateOpen {
		return
	}
	b, _ := json.Marshal(v)
	dc.SendText(string(b))
}

func (u *Uygulama) gidenKanal(bag *dosyaBagi, dc *webrtc.DataChannel) {
	bag.sonKullanim = time.Now()
	var akt *gidenAktarim
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if !m.IsString {
			return
		}
		var v struct {
			Istek     *string  `json:"istek"`
			Baslangic float64  `json:"baslangic"`
			Onay      *float64 `json:"onay"`
		}
		if json.Unmarshal(m.Data, &v) != nil {
			return
		}
		if v.Istek != nil {
			u.calistir(func() {
				if akt != nil {
					return
				}
				p := u.dosyalar.paylasimlarim[*v.Istek]
				if p == nil {
					kanalaYaz(dc, map[string]string{"hata": "yok"})
					time.AfterFunc(300*time.Millisecond, func() { dc.Close() })
					return
				}
				bas := min(p.Boyut, max(0, int64(v.Baslangic)))
				akt = &gidenAktarim{id: p.ID, ad: p.Ad, kisi: bag.ad, yol: p.Yol, boyut: p.Boyut, kanal: dc, bag: bag, uyandir: make(chan struct{}, 1), baslangic: time.Now()}
				akt.gonderilen.Store(bas)
				akt.onaylanan.Store(bas)
				u.dosyalar.gonderimler[akt] = true
				bag.aktarimlar[akt] = true
				go u.gonderimDongusu(akt)
			})
			return
		}
		if v.Onay != nil && akt != nil {
			n := int64(*v.Onay)
			if n > akt.onaylanan.Load() {
				akt.onaylanan.Store(n)
			}
			select {
			case akt.uyandir <- struct{}{}:
			default:
			}
			if n >= akt.boyut {
				u.calistir(func() { u.gonderimBitti(akt, "") })
			}
		}
	})
	dc.OnClose(func() {
		u.calistir(func() {
			if akt != nil && !akt.bitti.Load() {
				neden := "yarıda kaldı"
				if akt.onaylanan.Load() >= akt.boyut {
					neden = ""
				}
				u.gonderimBitti(akt, neden)
			}
		})
	})
}

// gonderimDongusu: dosyayı parça parça gönder (kendi goroutine'inde).
func (u *Uygulama) gonderimDongusu(akt *gidenAktarim) {
	dc := akt.kanal
	f, err := os.Open(akt.yol)
	if err != nil {
		kanalaYaz(dc, map[string]string{"hata": "okunamadi"})
		u.calistir(func() { u.gonderimBitti(akt, "dosya okunamadı") })
		time.AfterFunc(300*time.Millisecond, func() { dc.Close() })
		return
	}
	defer f.Close()
	dc.SetBufferedAmountLowThreshold(tamponUst / 4)
	dc.OnBufferedAmountLow(func() {
		select {
		case akt.uyandir <- struct{}{}:
		default:
		}
	})
	kanalaYaz(dc, map[string]any{"tamam": true, "boyut": akt.boyut, "baslangic": akt.gonderilen.Load()})
	blok := make([]byte, okumaBoyu)
	for akt.gonderilen.Load() < akt.boyut {
		if akt.bitti.Load() || dc.ReadyState() != webrtc.DataChannelStateOpen {
			return
		}
		if dc.BufferedAmount() > tamponUst || akt.gonderilen.Load()-akt.onaylanan.Load() > pencere {
			select {
			case <-akt.uyandir:
			case <-time.After(time.Second):
			}
			continue
		}
		bas := akt.gonderilen.Load()
		n, err := f.ReadAt(blok[:min(int64(okumaBoyu), akt.boyut-bas)], bas)
		if err != nil && !errors.Is(err, io.EOF) || n == 0 {
			kanalaYaz(dc, map[string]string{"hata": "okunamadi"})
			u.calistir(func() { u.gonderimBitti(akt, "dosya okunamadı") })
			time.AfterFunc(300*time.Millisecond, func() { dc.Close() })
			return
		}
		for i := 0; i < n; i += parca {
			if err := dc.Send(blok[i:min(n, i+parca)]); err != nil {
				return
			}
		}
		akt.gonderilen.Store(bas + int64(n))
	}
	kanalaYaz(dc, map[string]bool{"bitti": true})
}

func (u *Uygulama) gonderimBitti(akt *gidenAktarim, hata string) {
	if akt.bitti.Swap(true) {
		return
	}
	delete(u.dosyalar.gonderimler, akt)
	delete(akt.bag.aktarimlar, akt)
	akt.bag.sonKullanim = time.Now()
	select {
	case akt.uyandir <- struct{}{}:
	default:
	}
	if hata == "" {
		u.durum(fmt.Sprintf("%s → %s gönderildi.", akt.ad, akt.kisi), false)
	} else if hata != "iptal edildi" {
		u.gunluk(fmt.Sprintf("gönderim %s → %s: %s", akt.ad, akt.kisi, hata))
	}
	u.istemGuncelle()
}

func (u *Uygulama) gonderimiIptalEt(akt *gidenAktarim) {
	kanalaYaz(akt.kanal, map[string]string{"hata": "iptal"})
	u.gonderimBitti(akt, "iptal edildi")
	time.AfterFunc(300*time.Millisecond, func() { akt.kanal.Close() })
}

// ---------------------------------------------------------------- indiren

// indirmeKlasoru: XDG İndirilenler klasörü (~/Downloads, ~/İndirilenler…).
func indirmeKlasoru() string {
	ev, _ := os.UserHomeDir()
	if b, err := os.ReadFile(filepath.Join(ev, ".config", "user-dirs.dirs")); err == nil {
		for _, s := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(s, "XDG_DOWNLOAD_DIR=") {
				d := strings.Trim(strings.TrimPrefix(s, "XDG_DOWNLOAD_DIR="), `"`)
				d = strings.ReplaceAll(d, "$HOME", ev)
				if bilgi, err := os.Stat(d); err == nil && bilgi.IsDir() {
					return d
				}
			}
		}
	}
	for _, d := range []string{filepath.Join(ev, "Downloads"), filepath.Join(ev, "İndirilenler")} {
		if bilgi, err := os.Stat(d); err == nil && bilgi.IsDir() {
			return d
		}
	}
	d := filepath.Join(ev, "Downloads")
	if os.MkdirAll(d, 0o755) == nil {
		return d
	}
	return "."
}

// bosAd: klasörde var olmayan bir ad (ad.uzantı, ad (1).uzantı, …).
func bosAd(klasor, ad string) string {
	ad = strings.Map(func(r rune) rune {
		if r == '/' || r == 0 {
			return '_'
		}
		return r
	}, ad)
	if ad == "" || ad == "." || ad == ".." {
		ad = "dosya"
	}
	uz := filepath.Ext(ad)
	kok := strings.TrimSuffix(ad, uz)
	for i := 0; ; i++ {
		aday := ad
		if i > 0 {
			aday = fmt.Sprintf("%s (%d)%s", kok, i, uz)
		}
		yol := filepath.Join(klasor, aday)
		if _, err := os.Stat(yol); errors.Is(err, os.ErrNotExist) {
			if _, err := os.Stat(yol + ".part"); errors.Is(err, os.ErrNotExist) {
				return yol
			}
		}
	}
}

func (u *Uygulama) dosyaIndir(k *dosyaKaydi) {
	d := &u.dosyalar
	if d.indirmeler[k.ID] != nil {
		u.durum(k.Ad+" zaten indiriliyor.", false)
		return
	}
	if d.paylasimlarim[k.ID] != nil {
		u.durum(k.Ad+" senin paylaştığın dosya.", false)
		return
	}
	if !u.bagli {
		u.durum("Sunucuya bağlı değilsin.", true)
		return
	}
	if !d.sunulanlar[k.ID] {
		u.durum(k.sahip+" şu an bu dosyayı sunmuyor (programı ya da sayfası kapalı).", true)
		return
	}
	klasor := indirmeKlasoru()
	hedef := bosAd(klasor, k.Ad)
	f, err := os.OpenFile(hedef+".part", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		u.durum("Dosya yazılamıyor: "+err.Error(), true)
		return
	}
	akt := &gelenAktarim{id: k.ID, bilgi: k, kisi: k.sahip, hedef: hedef, f: f, durum: "baglaniyor", baslangic: time.Now()}
	d.indirmeler[k.ID] = akt
	u.durum(fmt.Sprintf("İndiriliyor: %s (%s) ← %s", k.Ad, boyutYaz(k.Boyut), k.sahip), false)
	u.indirmeKanaliAc(akt)
	u.istemGuncelle()
}

func (u *Uygulama) indirmeKanaliAc(akt *gelenAktarim) {
	bag := u.aliciBagi(akt.kisi)
	if bag == nil {
		u.indirmeBitti(akt, "Bağlantı kurulamadı.")
		return
	}
	ordered := true
	dc, err := bag.pc.CreateDataChannel("dosya", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		u.indirmeBitti(akt, "Bağlantı kurulamadı.")
		return
	}
	akt.bag = bag
	akt.kanal = dc
	akt.durum = "baglaniyor"
	bag.aktarimlar[akt] = true
	bag.sonKullanim = time.Now()
	dc.OnOpen(func() {
		akt.mu.Lock()
		bas := akt.alinan
		akt.mu.Unlock()
		kanalaYaz(dc, map[string]any{"istek": akt.id, "baslangic": bas})
		u.calistir(func() {
			if akt.acilis != nil {
				akt.acilis.Stop()
			}
		})
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) { u.indirmeMesaji(akt, dc, m) })
	dc.OnClose(func() {
		u.calistir(func() {
			if akt.kanal == dc {
				u.aktarimKoptu(akt, "Bağlantı koptu")
			}
		})
	})
	akt.acilis = u.sonra(25*time.Second, func() {
		if akt.kanal != dc || dc.ReadyState() == webrtc.DataChannelStateOpen {
			return
		}
		if bag.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			u.bagKapat(bag, akt.kisi+" ile bağlantı kurulamadı", false)
		} else {
			u.aktarimKoptu(akt, akt.kisi+" yanıt vermedi")
		}
	})
}

// indirmeMesaji: veri kanalının goroutine'inde (parçalar doğrudan diske yazılır).
func (u *Uygulama) indirmeMesaji(akt *gelenAktarim, dc *webrtc.DataChannel, m webrtc.DataChannelMessage) {
	if m.IsString {
		var v struct {
			Hata  string  `json:"hata"`
			Tamam bool    `json:"tamam"`
			Boyut float64 `json:"boyut"`
			Bitti bool    `json:"bitti"`
		}
		if json.Unmarshal(m.Data, &v) != nil {
			return
		}
		u.calistir(func() {
			if akt.kanal != dc || akt.bitti {
				return
			}
			switch {
			case v.Hata != "":
				neden := map[string]string{"yok": akt.kisi + " artık bu dosyayı sunmuyor.", "iptal": akt.kisi + " gönderimi durdurdu."}[v.Hata]
				u.indirmeBitti(akt, firstNonEmpty(neden, "Paylaşan dosyayı okuyamadı."))
			case v.Tamam:
				if int64(v.Boyut) != akt.bilgi.Boyut {
					u.indirmeBitti(akt, "Dosya değişmiş (boyutu farklı).")
					return
				}
				akt.durum = "aliniyor"
				akt.mu.Lock()
				akt.hizBaz = akt.alinan
				akt.mu.Unlock()
				akt.baslangic = time.Now()
			case v.Bitti:
				akt.sonGeldi = true
				u.indirmeyiTamamla(akt)
			}
		})
		return
	}
	akt.mu.Lock()
	defer akt.mu.Unlock()
	if akt.bitti || akt.f == nil || akt.kanal != dc {
		return
	}
	if akt.alinan+int64(len(m.Data)) > akt.bilgi.Boyut {
		u.calistir(func() { u.indirmeBitti(akt, "Beklenenden fazla veri geldi.") })
		return
	}
	if _, err := akt.f.WriteAt(m.Data, akt.alinan); err != nil {
		u.calistir(func() { u.indirmeBitti(akt, "Diske yazılamadı: "+err.Error()) })
		return
	}
	akt.alinan += int64(len(m.Data))
	if akt.alinan-akt.onaylanan >= onayAraligi || akt.alinan == akt.bilgi.Boyut {
		akt.onaylanan = akt.alinan
		kanalaYaz(dc, map[string]int64{"onay": akt.alinan})
	}
}

// aktarimKoptu: kanal ya da bağlantı koptu: paylaşan hâlâ sunuyorsa kaldığı yerden yeniden iste.
func (u *Uygulama) aktarimKoptu(akt *gelenAktarim, neden string) {
	if akt.bitti {
		return
	}
	if akt.acilis != nil {
		akt.acilis.Stop()
	}
	dc := akt.kanal
	akt.kanal = nil
	if dc != nil {
		go dc.Close()
	}
	if akt.bag != nil {
		delete(akt.bag.aktarimlar, akt)
	}
	akt.bag = nil
	if akt.sonGeldi {
		return
	}
	akt.deneme++
	if akt.deneme > 6 {
		u.indirmeBitti(akt, neden)
		return
	}
	akt.durum = "bekliyor"
	akt.yeniden = u.sonra(time.Duration(min(10, akt.deneme))*time.Second, func() { u.yenidenIste(akt) })
}

func (u *Uygulama) yenidenIste(akt *gelenAktarim) {
	if akt.bitti {
		return
	}
	if !u.bagli || !u.dosyalar.sunulanlar[akt.id] {
		akt.bekleme++
		if akt.bekleme > 40 {
			u.indirmeBitti(akt, akt.kisi+" geri gelmedi; aktarım durdu.")
			return
		}
		akt.yeniden = u.sonra(3*time.Second, func() { u.yenidenIste(akt) })
		return
	}
	u.indirmeKanaliAc(akt)
}

func (u *Uygulama) indirmeyiTamamla(akt *gelenAktarim) {
	if akt.bitti {
		return
	}
	akt.mu.Lock()
	alinan := akt.alinan
	akt.mu.Unlock()
	if alinan != akt.bilgi.Boyut {
		u.indirmeBitti(akt, "Dosya eksik geldi.")
		return
	}
	akt.mu.Lock()
	akt.bitti = true
	f := akt.f
	akt.f = nil
	akt.mu.Unlock()
	if akt.acilis != nil {
		akt.acilis.Stop()
	}
	if akt.yeniden != nil {
		akt.yeniden.Stop()
	}
	err := f.Close()
	if err == nil {
		err = os.Rename(akt.hedef+".part", akt.hedef)
	}
	if dc := akt.kanal; dc != nil {
		akt.kanal = nil
		time.AfterFunc(200*time.Millisecond, func() { dc.Close() })
	}
	if akt.bag != nil {
		delete(akt.bag.aktarimlar, akt)
	}
	delete(u.dosyalar.indirmeler, akt.id)
	if err != nil {
		u.durum(akt.bilgi.Ad+": kaydedilemedi: "+err.Error(), true)
		return
	}
	sure := time.Since(akt.baslangic).Seconds()
	hiz := ""
	if sure > 0.5 {
		hiz = " · " + boyutYaz(int64(float64(akt.bilgi.Boyut-akt.hizBaz)/sure)) + "/sn"
	}
	u.ui.Yaz(u.ui.Yesil("✓ İndirildi: ") + akt.hedef + u.ui.Soluk(hiz))
	u.istemGuncelle()
}

func (u *Uygulama) indirmeBitti(akt *gelenAktarim, hata string) {
	if akt.bitti {
		return
	}
	akt.mu.Lock()
	akt.bitti = true
	f := akt.f
	akt.f = nil
	akt.mu.Unlock()
	if akt.acilis != nil {
		akt.acilis.Stop()
	}
	if akt.yeniden != nil {
		akt.yeniden.Stop()
	}
	if dc := akt.kanal; dc != nil {
		go dc.Close()
	}
	akt.kanal = nil
	if akt.bag != nil {
		delete(akt.bag.aktarimlar, akt)
	}
	if f != nil {
		f.Close()
		os.Remove(akt.hedef + ".part")
	}
	delete(u.dosyalar.indirmeler, akt.id)
	if hata != "" {
		u.durum(akt.bilgi.Ad+": "+hata, true)
	}
	u.istemGuncelle()
}

// aktarimOzeti: istemde gösterilen kısa durum.
func (u *Uygulama) aktarimOzeti() string {
	var p []string
	for _, akt := range u.dosyalar.indirmeler {
		akt.mu.Lock()
		alinan := akt.alinan
		akt.mu.Unlock()
		yuzde := 0
		if akt.bilgi.Boyut > 0 {
			yuzde = int(alinan * 100 / akt.bilgi.Boyut)
		}
		durum := fmt.Sprintf("%%%d", yuzde)
		if akt.durum == "baglaniyor" {
			durum = "bağlanıyor"
		} else if akt.durum == "bekliyor" {
			durum = "bekliyor"
		}
		p = append(p, fmt.Sprintf("↓%s %s", kisalt(akt.bilgi.Ad, 16), durum))
	}
	for akt := range u.dosyalar.gonderimler {
		yuzde := 0
		if akt.boyut > 0 {
			yuzde = int(akt.onaylanan.Load() * 100 / akt.boyut)
		}
		p = append(p, fmt.Sprintf("↑%s→%s %%%d", kisalt(akt.ad, 12), akt.kisi, yuzde))
	}
	sort.Strings(p)
	if len(p) > 3 {
		p = append(p[:3], fmt.Sprintf("+%d", len(p)-3))
	}
	return strings.Join(p, " ")
}

// aktarimlariYaz: /aktarımlar.
func (u *Uygulama) aktarimlariYaz() {
	if len(u.dosyalar.indirmeler) == 0 && len(u.dosyalar.gonderimler) == 0 {
		u.ui.Yaz("Süren aktarım yok.")
	}
	for _, akt := range u.dosyalar.indirmeler {
		akt.mu.Lock()
		alinan := akt.alinan
		akt.mu.Unlock()
		hiz := ""
		if s := time.Since(akt.baslangic).Seconds(); s > 1 && alinan > akt.hizBaz {
			hiz = " · " + boyutYaz(int64(float64(alinan-akt.hizBaz)/s)) + "/sn"
		}
		u.ui.Yaz(fmt.Sprintf("  ↓ [%d] %s ← %s · %s / %s%s · %s", akt.bilgi.no, akt.bilgi.Ad, akt.kisi, boyutYaz(alinan), boyutYaz(akt.bilgi.Boyut), hiz, akt.durum))
	}
	for akt := range u.dosyalar.gonderimler {
		u.ui.Yaz(fmt.Sprintf("  ↑ %s → %s · %s / %s", akt.ad, akt.kisi, boyutYaz(akt.onaylanan.Load()), boyutYaz(akt.boyut)))
	}
	if len(u.dosyalar.paylasimlarim) > 0 {
		var adlar []string
		for _, p := range u.dosyalar.paylasimlarim {
			adlar = append(adlar, p.Ad)
		}
		sort.Strings(adlar)
		u.ui.Yaz(u.ui.Soluk("  sunduğun dosyalar: " + strings.Join(adlar, ", ")))
	}
}

// iptal: süren bir indirmeyi ya da gönderimi durdur.
func (u *Uygulama) aktarimIptal(k *dosyaKaydi) {
	if akt := u.dosyalar.indirmeler[k.ID]; akt != nil {
		u.indirmeBitti(akt, "")
		u.durum(k.Ad+" indirmesi durduruldu.", false)
		return
	}
	n := 0
	for akt := range u.dosyalar.gonderimler {
		if akt.id == k.ID {
			u.gonderimiIptalEt(akt)
			n++
		}
	}
	if n == 0 {
		u.durum(k.Ad+" için süren aktarım yok.", true)
	}
}

func (d *dosyaDurumu) saniyelik(u *Uygulama) {
	// Boşta kalan bağlantıları kapat (indiren 1, gönderen 3 dakika sonra).
	for _, bag := range d.baglar {
		if len(bag.aktarimlar) > 0 {
			bag.sonKullanim = time.Now()
			continue
		}
		bekle := 3 * time.Minute
		if bag.alici {
			bekle = time.Minute
		}
		if time.Since(bag.sonKullanim) > bekle {
			u.bagKapat(bag, "", false)
		}
	}
}

func (d *dosyaDurumu) hepsiniKapat() {
	for _, akt := range d.indirmeler {
		akt.mu.Lock()
		if akt.f != nil {
			akt.f.Close()
			akt.f = nil
		}
		akt.mu.Unlock()
	}
	for _, bag := range d.baglar {
		bag.pc.Close()
	}
}
