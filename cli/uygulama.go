package main

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/TahaGemici/diszort/cli/ses"
	"github.com/pion/webrtc/v4"
)

// ---------------------------------------------------------------- protokol nesneleri

type YayinBilgi struct {
	Goruntu bool `json:"goruntu"`
	Ses     bool `json:"ses"`
}

type SesKisi struct {
	Ad     string      `json:"ad"`
	Sessiz bool        `json:"sessiz"`
	Sagir  bool        `json:"sagir"`
	Askida bool        `json:"askida"`
	Yayin  *YayinBilgi `json:"yayin"`
}

type Kanal struct {
	ID      string    `json:"id"`
	Ad      string    `json:"ad"`
	Tur     string    `json:"tur"` // "yazi" | "ses"
	Kisiler []SesKisi `json:"kisiler"`
}

type Kim struct {
	Ad     string  `json:"ad"`
	Sessiz bool    `json:"sessiz"`
	Sagir  bool    `json:"sagir"`
	Ses    *string `json:"ses"`
}

type DosyaBilgi struct {
	ID    string `json:"id"`
	Ad    string `json:"ad"`
	Boyut int64  `json:"boyut"`
	Tur   string `json:"tur"`
}

type Mesaj struct {
	ID    int64       `json:"id"`
	Ad    string      `json:"ad"`
	Metin string      `json:"metin"`
	Zaman int64       `json:"zaman"`
	Dosya *DosyaBilgi `json:"dosya"`
}

type iceAyari struct {
	ICEServers []struct {
		URLs       json.RawMessage `json:"urls"`
		Username   string          `json:"username"`
		Credential string          `json:"credential"`
	} `json:"iceServers"`
}

// Gelen: sunucudan gelen ileti (alanların anlamı türe göre; bkz. sunucu/sunucu.js).
type Gelen struct {
	Type             string                     `json:"type"`
	Ad               string                     `json:"ad"`
	ID               string                     `json:"id"`
	Kanal            string                     `json:"kanal"`
	Kanallar         []Kanal                    `json:"kanallar"`
	Kimler           []Kim                      `json:"kimler"`
	BeyazListe       *int                       `json:"beyazListe"`
	BeyazListeAdlari []string                   `json:"beyazListeAdlari"`
	MaxKullanici     int                        `json:"maxKullanici"`
	Max              int                        `json:"max"`
	Ice              json.RawMessage            `json:"ice"`
	Surum            string                     `json:"surum"`
	TurnNesli        string                     `json:"turnNesli"`
	GirisAralikMs    *float64                   `json:"girisAralikMs"`
	GirisKova        *float64                   `json:"girisKova"`
	SunulanDosyalar  []string                   `json:"sunulanDosyalar"`
	Anahtar          string                     `json:"anahtar"`
	AnahtarGecersiz  bool                       `json:"anahtarGecersiz"`
	Message          string                     `json:"message"`
	Kod              string                     `json:"kod"`
	Bekle            float64                    `json:"bekle"`
	Kayitli          bool                       `json:"kayitli"`
	Kabul            bool                       `json:"kabul"`
	Kisiler          json.RawMessage            `json:"kisiler"`
	Mesaj            json.RawMessage            `json:"mesaj"`
	Mesajlar         []Mesaj                    `json:"mesajlar"`
	Bitti            bool                       `json:"bitti"`
	Devam            bool                       `json:"devam"`
	Sessiz           bool                       `json:"sessiz"`
	Sagir            bool                       `json:"sagir"`
	From             string                     `json:"from"`
	Sdp              *webrtc.SessionDescription `json:"sdp"`
	Oturum           string                     `json:"oturum"`
	Tam              bool                       `json:"tam"`
	Teklif           bool                       `json:"teklif"`
	Izle             bool                       `json:"izle"`
	Sunulan          []string                   `json:"sunulan"`
	Idler            []string                   `json:"idler"`
	Veri             json.RawMessage            `json:"veri"`
	Veritabani       float64                    `json:"veritabani"`
	Dosya            json.RawMessage            `json:"dosya"`
	BosAlan          *float64                   `json:"bosAlan"`
	Gun              float64                    `json:"gun"`
	Silinen          float64                    `json:"silinen"`
}

// ---------------------------------------------------------------- uygulama

type istek struct {
	id, ad  string
	kayitli bool
}

type Uygulama struct {
	is    chan func()
	ayar  *Ayar
	ui    *Arayuz
	motor *ses.Motor
	betik bool
	cikis chan error

	// sunucu bağlantısı
	ws            *soket
	bagli         bool
	oturumVardi   bool
	durduruldu    bool
	bekleyenIstek bool
	girisAdi      string
	yenidenDene   int
	frenDenemesi  int
	yenidenZaman  *time.Timer
	sonSunucu     time.Time
	canlilik      *time.Timer
	sekme         string
	sunucuSurumu  string
	turnNesli     string
	girisAraligi  float64
	girisKovasi   float64
	adSoruldu     bool

	// durum
	ben                string
	sunucuMax          int
	beyazListe         int
	beyazListeAdlari   []string
	maxKullanici       int
	kanallar           []Kanal
	kimler             []Kim
	ice                []webrtc.ICEServer
	iceZamani          time.Time
	aktifKanal         string
	mesajlar           []Mesaj
	gecmisBitti        bool
	gecmisIstegi       string
	okunmamis          map[string]int
	yaziyorlar         map[string]time.Time
	yaziyorZamani      time.Time
	istekler           []istek
	sesDurumlari       map[string]SesKisi
	sunucuBilgisiBekle bool

	// sesli kanal (sesli.go)
	sesKanal     string
	sesHedef     string
	sesGiriliyor bool
	esler        map[string]*Es
	mikVar       bool
	denemede     bool

	// paylaşım (paylasim.go)
	yayin yayinDurumu

	// dosyalar (dosya.go)
	dosyalar dosyaDurumu

	guncelleme      *surumBilgisi
	bekleyenler     []func() // girmeden yazılanlar (girince yapılır)
	bahsedilen      map[string]bool
	yenidenBasliyor bool

	// tam ekran sohbet (tamekran.go) ve komut konsolu (konsol.go)
	ekran     *TamEkran
	konsol    *konsolSunucu
	dinleyici *net.UnixListener
}

// yeniUygulama: tamEkran: sohbet terminali kaplar, komutlar komut konsolundan (yoksa satır arayüzü).
// dinleyici: komut konsolunun soketi (nil: konsol yok).
func yeniUygulama(ayar *Ayar, betik, tamEkran bool, dinleyici *net.UnixListener) *Uygulama {
	u := &Uygulama{
		is:           make(chan func(), 1024),
		ayar:         ayar,
		ui:           yeniArayuz(betik),
		betik:        betik,
		cikis:        make(chan error, 1),
		sekme:        rastgeleKimlik(16),
		girisAraligi: 10000,
		girisKovasi:  1,
		sunucuMax:    10,
		maxKullanici: 10,
		okunmamis:    map[string]int{},
		yaziyorlar:   map[string]time.Time{},
		sesDurumlari: map[string]SesKisi{},
		esler:        map[string]*Es{},
		bahsedilen:   map[string]bool{},
		gecmisBitti:  true,
		dinleyici:    dinleyici,
	}
	if tamEkran {
		u.ui.uzak = true
		u.ekran = yeniTamEkran(u)
	}
	u.dosyalar.kur()
	u.motor = ses.YeniMotor()
	u.motor.Bildir = func(m string, hata bool) {
		u.calistir(func() { u.durum(m, hata) })
	}
	u.motor.Gunluk = u.gunluk
	return u
}

// calistir: işi olay döngüsünde yap (durum yalnızca orada değişir).
func (u *Uygulama) calistir(f func()) {
	select {
	case u.is <- f:
	default:
		// Döngü tıkandıysa (olmamalı) bekle.
		u.is <- f
	}
}

// sonra: ms sonra olay döngüsünde.
func (u *Uygulama) sonra(d time.Duration, f func()) *time.Timer {
	return time.AfterFunc(d, func() { u.calistir(f) })
}

func (u *Uygulama) gunluk(s string) {
	if y := os.Getenv("DISZORT_GUNLUK"); y != "" {
		if f, err := os.OpenFile(y, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			fmt.Fprintf(f, "%s %s\n", time.Now().Format("15:04:05.000"), s)
			f.Close()
		}
	}
}

func (u *Uygulama) Calis() error {
	u.sesMotorunuBagla()
	u.ui.Satir = func(s string) { u.calistir(func() { u.satirGeldi(s) }) }
	u.ui.KonsolSatir = func(s string) { u.calistir(func() { u.konsolSatiri(s) }) }
	u.ui.Degisti = func(s string) { u.calistir(func() { u.girdiDegisti(s) }) }
	u.ui.Tus = func(t string) { u.calistir(func() { u.tusGeldi(t) }) }
	u.ui.Tamamla = u.tamamla
	if u.dinleyici != nil {
		u.konsol = yeniKonsolSunucu(u.dinleyici, u.ui)
		u.konsol.tamamla = u.tamamla
		u.konsol.tus = func(t string) { u.calistir(func() { u.tusGeldi(t) }) }
		u.konsol.cik = func() { u.calistir(func() { u.bitir(nil) }) }
		u.ui.konsol = u.konsol
	}
	if err := u.ui.Baslat(); err != nil {
		return err
	}
	defer u.ui.Bitir()
	if u.ekran != nil {
		if err := u.ekran.Baslat(); err != nil {
			return err
		}
		defer u.ekran.Bitir()
	}
	if u.konsol != nil {
		u.konsol.baslat()
	}
	if u.ekran != nil {
		u.ui.Yaz(u.ui.Kalin(surumYazisi()) + u.ui.Soluk(" · "+u.ayar.Sunucu+" · yardım: komutların listesi"))
	} else {
		u.ui.Yaz(u.ui.Kalin(surumYazisi()) + u.ui.Soluk(" · "+u.ayar.Sunucu+" · /yardım komutları listeler"))
	}
	u.istemGuncelle()
	u.dosyalar.yukle(u)
	go func() {
		// Çökerse terminal ham kipte kalmasın.
		defer func() {
			if r := recover(); r != nil {
				if u.ekran != nil {
					u.ekran.Bitir()
				}
				u.ui.Bitir()
				panic(r)
			}
		}()
		for f := range u.is {
			f()
			if u.ekran != nil {
				u.ekran.belkiCiz()
			}
		}
	}()
	u.calistir(u.basla)
	// Saniyede bir: yazıyor göstergesi, istem, ses durumu, kurtarma.
	go func() {
		for range time.Tick(time.Second) {
			u.calistir(u.saniyelik)
		}
	}()
	if !u.betik && surum != "yerel" {
		go u.guncellemeDenetle()
	}
	err := <-u.cikis
	return err
}

func (u *Uygulama) basla() {
	if u.ayar.Anahtar != "" {
		u.girisAdi = ""
		u.durum("Bağlanılıyor…", false)
		u.baglan()
		return
	}
	u.adSor("")
}

// adSor: anahtar yok: adını sor ve kapıyı çal.
func (u *Uygulama) adSor(not string) {
	if not != "" {
		u.durum(not, true)
	}
	u.adSoruldu = true
	onceki := u.ayar.Ad
	soru := "Adın (içeridekilere sorulacak): "
	if onceki != "" {
		soru = fmt.Sprintf("Adın [%s]: ", onceki)
	}
	sor := u.ui.Sor
	if u.ekran != nil {
		sor = func(m string, _ bool, c func(string)) { u.ekran.Sor(m, false, c) }
	}
	sor(soru, false, func(s string) {
		u.calistir(func() {
			s = strings.TrimSpace(s)
			if s == "" {
				s = onceki
			}
			if s == "" {
				u.adSor("Bir ad yaz (ya da Ctrl+C ile çık).")
				return
			}
			if r := []rune(s); len(r) > 32 {
				s = string(r[:32])
			}
			u.girisAdi = s
			u.ayar.Ad = s
			u.ayarKaydet()
			u.frenDenemesi = 0
			u.durum("İçeridekilere soruluyor…", false)
			u.baglan()
		})
	})
}

func (u *Uygulama) bitir(err error) {
	u.durduruldu = true
	if u.sesKanal != "" && u.bagli {
		u.gonder(map[string]any{"type": "ses-cik"})
	}
	u.sesKapat(false)
	u.dosyalar.hepsiniKapat()
	u.motor.Kapat()
	if u.ws != nil {
		u.ws.kapat()
	}
	u.ayarKaydet()
	if u.konsol != nil {
		neden := "bitti"
		if u.yenidenBasliyor {
			neden = "yeniden"
		}
		u.konsol.kapat(neden)
	}
	if u.ekran != nil {
		u.ekran.Bitir()
	}
	select {
	case u.cikis <- err:
	default:
	}
}

func (u *Uygulama) ayarKaydet() {
	if err := u.ayar.Kaydet(); err != nil {
		u.gunluk("ayar yazılamadı: " + err.Error())
	}
}

// ---------------------------------------------------------------- bildirimler

func (u *Uygulama) durum(metin string, hata bool) {
	if metin == "" {
		return
	}
	if hata {
		u.ui.Yaz(u.ui.Kirmizi("! " + metin))
	} else {
		u.ui.Yaz(u.ui.Soluk("· " + metin))
	}
	if u.ekran != nil {
		u.ekran.bildir(metin, hata)
	}
}

// zil: adın geçince, kapı çalınınca (tam ekranda sohbetin terminalinde).
func (u *Uygulama) zil() {
	if u.ekran != nil {
		u.ekran.zil()
	} else {
		u.ui.Zil()
	}
}

func (u *Uygulama) ton(tur string) {
	if u.ayar.Ses.Sesler {
		u.motor.Ton(tur)
	}
}

// istemGuncelle: giriş satırının (tam ekranda: komut konsolunun) başı: bağlantı, sesli kanal,
// açık kanal; satır arayüzünde okunmamışlar ve yazanlar da.
func (u *Uygulama) istemGuncelle() {
	var p []string
	if u.ekran != nil {
		p = u.konsolParcalari()
	} else {
		p = u.durumParcalari(false)
	}
	kanal := "#" + u.kanalAdi(u.aktifKanal)
	if u.aktifKanal == "" {
		kanal = ""
	}
	ist := strings.Join(p, " ")
	if ist != "" {
		ist += " "
	}
	u.ui.Istem(ist + u.ui.Kalin(kanal) + "> ")
}

// konsolParcalari: tam ekranda komut bölmesinin istemi kısa (sesli kanal, paylaşım ve aktarımlar
// sohbetin durum çubuğunda): bağlantı sorunu, kapıdakiler, mikrofon denemesi.
func (u *Uygulama) konsolParcalari() []string {
	var p []string
	switch {
	case u.bekleyenIstek:
		p = append(p, u.ui.Sari("[izin bekleniyor · iptal]"))
	case !u.bagli && u.oturumVardi:
		p = append(p, u.ui.Sari("[bağlantı koptu]"))
	case !u.bagli:
		p = append(p, u.ui.Soluk("[bağlanıyor…]"))
	}
	if len(u.istekler) > 0 {
		p = append(p, u.ui.Sari(fmt.Sprintf("[kapıda %d]", len(u.istekler))))
	}
	if u.denemede {
		p = append(p, u.denemeIstemi())
	}
	return p
}

// durumParcalari: istemin (ya da tam ekranın durum çubuğunun) parçaları. tam: okunmamışlar ve
// yazanlar hariç (tam ekranda kendi yerlerinde görünür), kapıda bekleyenler dahil.
func (u *Uygulama) durumParcalari(tam bool) []string {
	var p []string
	switch {
	case u.bekleyenIstek:
		p = append(p, u.ui.Sari("[izin bekleniyor · /iptal]"))
	case !u.bagli && u.oturumVardi:
		p = append(p, u.ui.Sari("[bağlantı koptu]"))
	case !u.bagli:
		p = append(p, u.ui.Soluk("[bağlanıyor…]"))
	}
	if u.sesKanal != "" {
		durum := "mik açık"
		switch {
		case u.ayar.Ses.Sagir:
			durum = "sağır"
		case u.ayar.Ses.MikKapali:
			durum = "mik kapalı"
		case !u.mikVar:
			durum = "yalnızca dinliyor"
		}
		parca := []string{"♪ " + u.kanalAdi(u.sesKanal), durum, fmt.Sprintf("%d kişi", u.esSayisi()+1)}
		if u.yayin.var_() {
			parca = append(parca, u.yayinOzeti())
		}
		p = append(p, u.ui.Yesil("["+strings.Join(parca, " · ")+"]"))
	} else if u.sesGiriliyor {
		p = append(p, u.ui.Soluk("[sesli kanala giriliyor…]"))
	}
	if !tam {
		var ok []string
		for _, k := range u.kanallar {
			if n := u.okunmamis[k.ID]; n > 0 && k.Tur == "yazi" {
				ok = append(ok, fmt.Sprintf("+%d #%s", n, k.Ad))
			}
		}
		if len(ok) > 0 {
			p = append(p, u.ui.Sari(strings.Join(ok, " ")))
		}
		if y := u.yazanlar(); y != "" {
			p = append(p, u.ui.Soluk(y))
		}
	} else if len(u.istekler) > 0 {
		p = append(p, u.ui.Sari(fmt.Sprintf("[kapıda %d kişi]", len(u.istekler))))
	}
	if a := u.aktarimOzeti(); a != "" {
		p = append(p, u.ui.Mavi("["+a+"]"))
	}
	if u.denemede {
		p = append(p, u.denemeIstemi())
	}
	if u.guncelleme != nil {
		p = append(p, u.ui.Mavi("[yeni sürüm "+u.guncelleme.Surum+": /güncelle]"))
	}
	return p
}

func (u *Uygulama) yazanlar() string {
	var adlar []string
	for ad, z := range u.yaziyorlar {
		if time.Since(z) > 5*time.Second {
			delete(u.yaziyorlar, ad)
			continue
		}
		adlar = append(adlar, ad)
	}
	sort.Strings(adlar)
	switch {
	case len(adlar) == 0:
		return ""
	case len(adlar) == 1:
		return adlar[0] + " yazıyor…"
	case len(adlar) > 3:
		return strings.Join(adlar[:3], ", ") + " ve diğerleri yazıyor…"
	}
	return strings.Join(adlar, ", ") + " yazıyor…"
}

func (u *Uygulama) saniyelik() {
	u.istemGuncelle()
	u.sesSaniyelik()
	u.dosyalar.saniyelik(u)
}

// ---------------------------------------------------------------- kanallar

func (u *Uygulama) kanalBilgi(id string) *Kanal {
	for i := range u.kanallar {
		if u.kanallar[i].ID == id {
			return &u.kanallar[i]
		}
	}
	return nil
}

func (u *Uygulama) kanalAdi(id string) string {
	if k := u.kanalBilgi(id); k != nil {
		return k.Ad
	}
	return id
}

// kanalBul: ad ya da kimlikle (başında # olabilir; büyük/küçük harf ve Türkçe harf farkı yok).
func (u *Uygulama) kanalBul(ara, tur string) *Kanal {
	ara = strings.TrimPrefix(strings.TrimSpace(ara), "#")
	if ara == "" {
		return nil
	}
	n := sadelestir(ara)
	var adaylar []*Kanal
	for i := range u.kanallar {
		k := &u.kanallar[i]
		if tur != "" && k.Tur != tur {
			continue
		}
		if k.ID == ara || sadelestir(k.Ad) == n {
			return k
		}
		if strings.HasPrefix(sadelestir(k.Ad), n) {
			adaylar = append(adaylar, k)
		}
	}
	if len(adaylar) == 1 {
		return adaylar[0]
	}
	return nil
}

func (u *Uygulama) ilkKanal() string {
	for _, a := range []string{u.ayar.Kanal} {
		if k := u.kanalBilgi(a); k != nil && k.Tur == "yazi" {
			return a
		}
	}
	for _, k := range u.kanallar {
		if k.Tur == "yazi" {
			return k.ID
		}
	}
	return ""
}

func (u *Uygulama) kanallarGeldi(liste []Kanal) {
	u.kanallar = liste
	onceki := u.sesDurumlari
	u.sesDurumlari = map[string]SesKisi{}
	for _, k := range liste {
		if k.Tur != "ses" {
			continue
		}
		for _, p := range k.Kisiler {
			u.sesDurumlari[p.Ad] = p
		}
	}
	u.yayinDurumlariDegisti(onceki)
	if u.aktifKanal != "" && u.kanalBilgi(u.aktifKanal) == nil {
		u.aktifKanal = ""
		if ilk := u.ilkKanal(); ilk != "" {
			u.kanalSec(ilk)
		}
	}
	if u.sesKanal != "" && u.kanalBilgi(u.sesKanal) == nil {
		u.sesKapat(false)
	}
	u.istemGuncelle()
}

func (u *Uygulama) kanalSec(id string) {
	k := u.kanalBilgi(id)
	if k == nil || k.Tur != "yazi" {
		return
	}
	u.aktifKanal = id
	delete(u.okunmamis, id)
	delete(u.bahsedilen, id)
	u.mesajlar = nil
	u.yaziyorlar = map[string]time.Time{}
	u.gecmisBitti = true
	u.ayar.Kanal = id
	u.ayarKaydet()
	if u.ekran != nil {
		u.ekran.kanalDegisti()
	} else {
		u.ui.Yaz(u.ui.Kalin("── #" + k.Ad + " ──"))
	}
	u.gecmisIstegi = id
	u.gonder(map[string]any{"type": "gecmis", "kanal": id, "once": 0})
	u.istemGuncelle()
}

// ---------------------------------------------------------------- sohbet

var baglantiKalibi = regexp.MustCompile(`https?://[^\s<>"']+[^\s<>"'.,;:!?)\]}]`)
var bahsetmeKalibi = regexp.MustCompile(`@[\p{L}\p{N}_.\-]+`)

func (u *Uygulama) bahsediyorMu(metin string) bool {
	if u.ben == "" {
		return false
	}
	for _, p := range bahsetmeKalibi.FindAllString(metin, -1) {
		if trKucuk(p[1:]) == trKucuk(u.ben) {
			return true
		}
	}
	return false
}

func (u *Uygulama) metinCiz(metin string) string {
	// Bağlantılar ve adımın geçtiği yer vurgulanır.
	var b strings.Builder
	son := 0
	for _, yer := range baglantiKalibi.FindAllStringIndex(metin, -1) {
		b.WriteString(u.bahsetmeCiz(metin[son:yer[0]]))
		b.WriteString(u.ui.Baglanti(metin[yer[0]:yer[1]]))
		son = yer[1]
	}
	b.WriteString(u.bahsetmeCiz(metin[son:]))
	return b.String()
}

func (u *Uygulama) bahsetmeCiz(s string) string {
	if u.ben == "" {
		return s
	}
	return bahsetmeKalibi.ReplaceAllStringFunc(s, func(p string) string {
		if trKucuk(p[1:]) == trKucuk(u.ben) {
			return u.ui.Vurgu(p)
		}
		return p
	})
}

func saatYaz(z int64) string { return time.UnixMilli(z).Format("15:04") }

func gunEtiketi(z int64) string {
	d := time.UnixMilli(z)
	simdi := time.Now()
	if d.Format("2006-01-02") == simdi.Format("2006-01-02") {
		return "Bugün"
	}
	if d.Format("2006-01-02") == simdi.AddDate(0, 0, -1).Format("2006-01-02") {
		return "Dün"
	}
	aylar := []string{"Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"}
	return fmt.Sprintf("%d %s %d", d.Day(), aylar[d.Month()-1], d.Year())
}

func boyutYaz(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1<<20:
		return fmt.Sprintf("%d KB", (n+512)/1024)
	case n < 1<<30:
		return strings.Replace(fmt.Sprintf("%.1f MB", float64(n)/(1<<20)), ".", ",", 1)
	}
	return strings.Replace(fmt.Sprintf("%.1f GB", float64(n)/(1<<30)), ".", ",", 1)
}

// mesajSatiri: bir mesajın terminaldeki hali.
func (u *Uygulama) mesajSatiri(m Mesaj) string {
	bas := u.ui.Soluk(saatYaz(m.Zaman)) + " " + u.ui.Ad(m.Ad)
	if m.Dosya != nil {
		u.dosyalar.bilgiEkle(*m.Dosya, m.Ad)
		return bas + " " + u.dosyaSatiri(m.Dosya.ID)
	}
	metin := u.metinCiz(m.Metin)
	if strings.Contains(metin, "\n") {
		metin = strings.ReplaceAll(metin, "\n", "\n      ")
	}
	return bas + ": " + metin
}

func (u *Uygulama) mesajlariYaz(liste []Mesaj, oncekiGun string) {
	gun := oncekiGun
	for _, m := range liste {
		g := gunEtiketi(m.Zaman)
		if g != gun {
			u.ui.Yaz(u.ui.Soluk("── " + g + " ──"))
			gun = g
		}
		u.ui.Yaz(u.mesajSatiri(m))
	}
}

func (u *Uygulama) gecmisGeldi(m Gelen) {
	if u.gecmisIstegi == m.Kanal {
		u.gecmisIstegi = ""
	}
	if m.Kanal != u.aktifKanal {
		return
	}
	gelen := m.Mesajlar
	if len(u.mesajlar) == 0 {
		u.gecmisBitti = m.Bitti
		u.mesajlar = gelen
		if u.ekran != nil {
			return
		}
		goster := gelen
		if len(goster) > 25 {
			goster = goster[len(goster)-25:]
			u.ui.Yaz(u.ui.Soluk(fmt.Sprintf("(daha önce %d mesaj daha var: /eski)", len(gelen)-25)))
		} else if !m.Bitti {
			u.ui.Yaz(u.ui.Soluk("(daha eski mesajlar: /eski)"))
		}
		if len(gelen) == 0 {
			u.ui.Yaz(u.ui.Soluk("Henüz mesaj yok. İlk mesajı sen yaz."))
		}
		u.mesajlariYaz(goster, "")
		return
	}
	bilinen := map[int64]bool{}
	for _, x := range u.mesajlar {
		bilinen[x.ID] = true
	}
	var yeniler []Mesaj
	for _, x := range gelen {
		if !bilinen[x.ID] {
			yeniler = append(yeniler, x)
		}
	}
	if len(yeniler) == 0 {
		if len(gelen) > 0 && gelen[0].ID < u.mesajlar[0].ID {
			u.gecmisBitti = m.Bitti
		}
		return
	}
	if yeniler[len(yeniler)-1].ID < u.mesajlar[0].ID {
		// Daha eski mesajlar istendi.
		u.gecmisBitti = m.Bitti
		u.mesajlar = append(yeniler, u.mesajlar...)
		if u.ekran != nil {
			return
		}
		u.ui.Yaz(u.ui.Soluk("── daha eski mesajlar ──"))
		u.mesajlariYaz(yeniler, "")
		u.ui.Yaz(u.ui.Soluk("── (eski mesajların sonu) ──"))
		return
	}
	// Bağlantı koptuğu sırada gelenler.
	enYeni := u.mesajlar[len(u.mesajlar)-1].ID
	var kacan []Mesaj
	for _, x := range yeniler {
		if x.ID > enYeni {
			kacan = append(kacan, x)
		}
	}
	u.mesajlar = append(u.mesajlar, kacan...)
	if len(kacan) > 0 && u.ekran == nil {
		u.ui.Yaz(u.ui.Soluk("── bağlantı koptuğu sırada ──"))
		u.mesajlariYaz(kacan, "")
	}
}

func (u *Uygulama) mesajGeldi(kanal string, m Mesaj) {
	if m.Dosya != nil {
		u.dosyalar.bilgiEkle(*m.Dosya, m.Ad)
	}
	if kanal == u.aktifKanal {
		for _, x := range u.mesajlar {
			if x.ID == m.ID {
				return
			}
		}
		onceki := ""
		if n := len(u.mesajlar); n > 0 {
			onceki = gunEtiketi(u.mesajlar[n-1].Zaman)
		}
		// Kimlik sırasıyla (geçmiş de öyle gelir): sunucudan sırası karışık gelse de yeri doğru olsun.
		i := len(u.mesajlar)
		for i > 0 && u.mesajlar[i-1].ID > m.ID {
			i--
		}
		u.mesajlar = append(u.mesajlar[:i], append([]Mesaj{m}, u.mesajlar[i:]...)...)
		if len(u.mesajlar) > 2000 {
			u.mesajlar = u.mesajlar[len(u.mesajlar)-2000:]
		}
		delete(u.yaziyorlar, m.Ad)
		if u.ekran != nil {
			u.ekran.mesajEklendi(m, onceki)
		} else {
			u.mesajlariYaz([]Mesaj{m}, onceki)
		}
		if m.Ad != u.ben && m.Metin != "" && u.bahsediyorMu(m.Metin) {
			u.zil()
		}
	} else if m.Ad != u.ben {
		u.okunmamis[kanal]++
		if m.Metin != "" && u.bahsediyorMu(m.Metin) {
			u.bahsedilen[kanal] = true
			u.ui.Yaz(u.ui.Sari("@ #"+u.kanalAdi(kanal)) + " " + u.mesajSatiri(m) + u.ui.Soluk("  (/git "+u.kanalAdi(kanal)+")"))
			if u.ekran != nil {
				u.ekran.bildir(u.ui.Sari("@ #"+u.kanalAdi(kanal))+" "+u.ui.Ad(m.Ad)+": "+kisalt(m.Metin, 80)+u.ui.Soluk("  (Alt+↑↓ ile kanala geç)"), false)
			}
			u.zil()
		}
	}
	u.istemGuncelle()
}

func (u *Uygulama) yaziGonder(metin string) {
	metin = strings.TrimSpace(metin)
	if metin == "" {
		return
	}
	if u.aktifKanal == "" {
		u.durum("Önce bir yazılı kanal seç: /git <kanal>", true)
		return
	}
	if !u.bagli {
		u.durum("Sunucuya bağlı değilsin; mesaj gönderilemedi.", true)
		return
	}
	if r := []rune(metin); len(r) > 2000 {
		metin = string(r[:2000])
		u.durum("Mesaj 2000 karakterde kesildi.", true)
	}
	u.yaziyorZamani = time.Time{}
	u.gonder(map[string]any{"type": "yazi", "kanal": u.aktifKanal, "metin": metin})
}

// ---------------------------------------------------------------- giriş istekleri

func (u *Uygulama) istekEkle(id, ad string, kayitli bool) {
	for _, i := range u.istekler {
		if i.id == id {
			return
		}
	}
	u.istekler = append(u.istekler, istek{id: id, ad: ad, kayitli: kayitli})
	satir := u.ui.Sari("! ") + u.ui.Ad(ad) + u.ui.Sari(" girmek istiyor") + u.ui.Soluk(" · /kabul "+ad+" · /reddet "+ad)
	if kayitli {
		satir += "\n  " + u.ui.Kirmizi("Bu ad beyaz listede kayıtlı. Kabul edersen eski cihazının anahtarı iptal olur; gerçekten o mu, emin ol.")
	}
	u.ui.Yaz(satir)
	if u.ekran != nil {
		u.ekran.bildir(u.ui.Ad(ad)+u.ui.Sari(" girmek istiyor")+u.ui.Soluk(" · komut penceresinde: kabul "+ad+" ya da reddet "+ad), false)
	}
	u.zil()
	u.ton("kapi")
}

func (u *Uygulama) istekSil(id string) {
	for i, x := range u.istekler {
		if x.id == id {
			u.istekler = append(u.istekler[:i], u.istekler[i+1:]...)
			return
		}
	}
}

// ---------------------------------------------------------------- sunucu iletileri

func (u *Uygulama) iletiGeldi(m Gelen) {
	u.sonSunucu = time.Now()
	switch m.Type {
	case "hazir":
		u.oturumHazir(m)
	case "bekleniyor":
		u.bekleyenIstek = true
		if m.AnahtarGecersiz {
			u.durum("Anahtar geçersiz; izin bekleniyor… (vazgeçmek için /iptal)", false)
		} else {
			u.durum("İçeridekilere soruldu; izin bekleniyor… (vazgeçmek için /iptal)", false)
		}
		u.istemGuncelle()
	case "giris-red":
		u.girisReddi(m)
	case "oturum-devralindi":
		u.durduruldu = true
		u.oturumuBitir(firstNonEmpty(m.Message, "Bu hesapla başka bir yerde girildi.") + " Burada sürdürmek için /bağlan.")
	case "atildi":
		u.durduruldu = true
		u.ayar.Anahtar = ""
		u.ayarKaydet()
		u.oturumuBitir(firstNonEmpty(m.Message, "Sunucudan atıldın; tekrar izin iste.") + " (/bağlan ile yeniden izin isteyebilirsin)")
	case "kanallar":
		u.kanallarGeldi(m.Kanallar)
	case "kimler":
		u.kimler = m.Kimler
		if m.BeyazListe != nil {
			u.beyazListe = *m.BeyazListe
		}
		if m.BeyazListeAdlari != nil {
			u.beyazListeAdlari = m.BeyazListeAdlari
		}
		if m.MaxKullanici > 0 {
			u.maxKullanici = m.MaxKullanici
		}
	case "beyaz-liste":
		u.beyazListeGeldi(m)
	case "giris-istegi":
		u.istekEkle(m.ID, m.Ad, m.Kayitli)
	case "istek-kapandi":
		u.istekSil(m.ID)
		if m.Kabul {
			u.durum(m.Ad+" içeri alındı.", false)
		}
	case "yazi":
		var ms Mesaj
		if json.Unmarshal(m.Mesaj, &ms) == nil {
			u.mesajGeldi(m.Kanal, ms)
		}
	case "gecmis":
		u.gecmisGeldi(m)
	case "yaziyor":
		if m.Kanal == u.aktifKanal && m.Ad != u.ben {
			u.yaziyorlar[m.Ad] = time.Now()
			u.istemGuncelle()
		}
	case "ses-girdi":
		u.sesKatil(m)
	case "ses-kisi-girdi":
		if u.sesKanal != "" && m.Kanal == u.sesKanal {
			u.esGirdi(m.Ad, m.Devam, true)
		}
	case "ses-kisi-cikti":
		if u.sesKanal != "" && m.Kanal == u.sesKanal {
			u.esCikti(m.Ad)
		}
	case "ses-kapatildi":
		u.durum("Kanal silindi; sesli kanaldan çıkarıldın.", true)
		u.sesKapat(false)
	case "sessiz":
		d := u.sesDurumlari[m.Ad]
		d.Sessiz, d.Sagir = m.Sessiz, m.Sagir
		u.sesDurumlari[m.Ad] = d
	case "sdp":
		u.sdpGeldi(m.From, m.Sdp, m.Oturum)
	case "ice":
		u.iceGeldi(m.From, m.Ice, m.Oturum)
	case "yenile":
		u.yenileGeldi(m.From, m.Oturum, m.Tam, m.Teklif)
	case "izle":
		u.izleGeldi(m.From, m.Izle)
	case "dosya-durum":
		u.dosyalar.sunulanlarGeldi(u, m.Sunulan)
	case "dosya-sun":
		u.dosyalar.sunduklarimOnaylandi(u, m.Idler)
	case "dosya-sinyal":
		u.dosyaSinyaliGeldi(m.From, m.Veri)
	case "sunucu-bilgi":
		u.sunucuBilgisiGeldi(m)
	case "sohbet-temizlendi":
		u.sohbetTemizlendi(m)
	case "ice-sunuculari":
		u.iceAyarla(m.Ice)
	case "hata":
		u.durum(m.Message, true)
		if m.Kod == "ses-dolu" || m.Kod == "ses-kanal-yok" {
			u.sesGirisiBasarisiz()
		}
	}
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func (u *Uygulama) oturumHazir(m Gelen) {
	if m.Surum != "" {
		if u.sunucuSurumu != "" && m.Surum != u.sunucuSurumu {
			u.durum("Sunucu güncellendi ("+m.Surum+").", false)
			go u.guncellemeDenetle()
		}
		u.sunucuSurumu = m.Surum
	}
	ilk := !u.oturumVardi
	turnYenilendi := u.turnNesli != "" && m.TurnNesli != "" && m.TurnNesli != u.turnNesli
	if m.TurnNesli != "" {
		u.turnNesli = m.TurnNesli
	}
	if m.GirisAralikMs != nil && *m.GirisAralikMs >= 0 {
		u.girisAraligi = *m.GirisAralikMs
	}
	if m.GirisKova != nil && *m.GirisKova >= 1 {
		u.girisKovasi = *m.GirisKova
	}
	u.bagli = true
	u.oturumVardi = true
	u.durduruldu = false
	u.bekleyenIstek = false
	u.yenidenDene = 0
	u.frenDenemesi = 0
	if len(m.Ice) > 0 {
		u.iceAyarla(m.Ice)
	}
	if m.Anahtar != "" {
		u.ayar.Anahtar = m.Anahtar
	}
	if m.Ad != "" {
		u.ben = m.Ad
		u.girisAdi = m.Ad
		u.ayar.Ad = m.Ad
	}
	u.ayarKaydet()
	if m.BeyazListe != nil {
		u.beyazListe = *m.BeyazListe
	}
	u.beyazListeAdlari = m.BeyazListeAdlari
	if m.MaxKullanici > 0 {
		u.maxKullanici = m.MaxKullanici
	}
	if m.Max > 0 {
		u.sunucuMax = m.Max
	}
	u.kimler = m.Kimler
	u.dosyalar.oturumHazir(u, m.SunulanDosyalar)
	u.istekler = nil
	u.kanallarGeldi(m.Kanallar)
	if ilk {
		u.ui.Yaz(u.ui.Yesil("Girdin: ") + u.ui.Ad(u.ben) + u.ui.Soluk(fmt.Sprintf(" · %d kişi çevrimiçi · /kanallar · /kişiler", len(u.kimler))))
		if u.ekran != nil {
			u.ekran.bildir(u.ui.Yesil("Girdin: ")+u.ui.Ad(u.ben), false)
		}
		if ilk := u.ilkKanal(); ilk != "" {
			u.kanalSec(ilk)
		}
		// Girmeden önce yazılanlar (betikte hemen gelir).
		bekleyen := u.bekleyenler
		u.bekleyenler = nil
		for _, f := range bekleyen {
			f()
		}
	} else {
		u.durum("Yeniden bağlandın.", false)
		if u.aktifKanal != "" {
			u.gecmisIstegi = u.aktifKanal
			u.gonder(map[string]any{"type": "gecmis", "kanal": u.aktifKanal, "once": 0})
		}
		if u.sesKanal != "" {
			if turnYenilendi {
				for _, es := range u.esler {
					if es.sonTip == "TURN" && es.pc != nil {
						es.turnYenile = true
					}
				}
			}
			u.gonder(map[string]any{"type": "ses-gir", "kanal": u.sesKanal, "devam": true, "sessiz": u.mikSessizMi(), "sagir": u.ayar.Ses.Sagir, "yayin": u.yayinBilgisi()})
		}
	}
	u.istemGuncelle()
}

func (u *Uygulama) girisReddi(m Gelen) {
	metin := firstNonEmpty(m.Message, "Giriş reddedildi.")
	u.bagli = false
	if u.ws != nil {
		u.ws.kapat()
		u.ws = nil
	}
	if m.Kod == "fren" {
		u.frenDenemesi++
		if u.frenDenemesi <= 30 {
			bekle := m.Bekle
			if bekle <= 0 {
				bekle = 10000
			}
			u.yenidenBaglanmayiPlanla(time.Duration(bekle+150+rand.Float64()*1200) * time.Millisecond)
			return
		}
	}
	u.durduruldu = true
	u.bekleyenIstek = false
	switch m.Kod {
	case "anahtar":
		u.ayar.Anahtar = ""
		u.ayarKaydet()
		u.adSor(metin)
		return
	case "ad", "ad-kullaniliyor", "reddedildi", "zaman-asimi", "kimse-yok":
		if !u.oturumVardi {
			u.adSor(metin)
			return
		}
	}
	u.oturumuBitir(metin)
}

// oturumuBitir: atıldın, başka yerde girildi, reddedildi: ses kapanır, bağlantı durur.
func (u *Uygulama) oturumuBitir(metin string) {
	if u.yenidenZaman != nil {
		u.yenidenZaman.Stop()
	}
	u.bagli = false
	u.oturumVardi = false
	if u.ws != nil {
		u.ws.kapat()
		u.ws = nil
	}
	u.sesKapat(false)
	u.istekler = nil
	u.durum(metin, true)
	u.istemGuncelle()
}

func (u *Uygulama) beyazListeGeldi(m Gelen) {
	var kisiler []struct {
		Ad       string  `json:"ad"`
		SonGiris float64 `json:"son_giris"`
		Yonetici any     `json:"yonetici"`
	}
	json.Unmarshal(m.Kisiler, &kisiler)
	cevrimici := map[string]bool{}
	for _, k := range u.kimler {
		cevrimici[k.Ad] = true
	}
	u.ui.Yaz(u.ui.Kalin(fmt.Sprintf("Beyaz liste %d/%d", len(kisiler), max(m.MaxKullanici, u.maxKullanici))))
	for _, k := range kisiler {
		durum := "çevrimdışı"
		if cevrimici[k.Ad] {
			durum = "çevrimiçi"
		}
		if k.SonGiris > 0 {
			durum += " · son giriş " + time.UnixMilli(int64(k.SonGiris)).Format("02.01.2006 15:04")
		}
		u.ui.Yaz("  " + u.ui.Ad(k.Ad) + " " + u.ui.Soluk(durum))
	}
}

func (u *Uygulama) sunucuBilgisiGeldi(m Gelen) {
	var mesajSayisi, dosyaSayisi float64
	json.Unmarshal(m.Mesaj, &mesajSayisi)
	json.Unmarshal(m.Dosya, &dosyaSayisi)
	bos := "bilinmiyor"
	if m.BosAlan != nil {
		bos = boyutYaz(int64(*m.BosAlan))
	}
	u.ui.Yaz(u.ui.Kalin("Sunucu") + u.ui.Soluk(" · "+u.ayar.Sunucu))
	u.ui.Yaz(fmt.Sprintf("  veritabanı %s · %d mesaj · %d dosya kaydı · boş alan %s · sürüm %s", boyutYaz(int64(m.Veritabani)), int64(mesajSayisi), int64(dosyaSayisi), bos, firstNonEmpty(m.Surum, "—")))
}

func (u *Uygulama) sohbetTemizlendi(m Gelen) {
	kapsam := "tüm kanallar"
	if m.Kanal != "" {
		kapsam = "#" + u.kanalAdi(m.Kanal)
	}
	gun := ""
	if m.Gun > 0 {
		gun = fmt.Sprintf(", %d günden eski", int(m.Gun))
	}
	u.durum(fmt.Sprintf("%s sohbeti temizledi (%s%s): %d mesaj silindi.", m.Ad, kapsam, gun, int64(m.Silinen)), false)
	for id := range u.okunmamis {
		if m.Kanal == "" || m.Kanal == id {
			delete(u.okunmamis, id)
		}
	}
	if u.aktifKanal != "" && (m.Kanal == "" || m.Kanal == u.aktifKanal) {
		u.mesajlar = nil
		u.gecmisIstegi = u.aktifKanal
		u.gonder(map[string]any{"type": "gecmis", "kanal": u.aktifKanal, "once": 0})
	}
}

// iceAyarla: sunucunun verdiği STUN/TURN (TURN şifresi bir günlük).
func (u *Uygulama) iceAyarla(ham json.RawMessage) {
	var a iceAyari
	if json.Unmarshal(ham, &a) != nil {
		return
	}
	var liste []webrtc.ICEServer
	for _, s := range a.ICEServers {
		var urls []string
		if json.Unmarshal(s.URLs, &urls) != nil {
			var tek string
			if json.Unmarshal(s.URLs, &tek) == nil {
				urls = []string{tek}
			}
		}
		if len(urls) == 0 {
			continue
		}
		liste = append(liste, webrtc.ICEServer{URLs: urls, Username: s.Username, Credential: s.Credential})
	}
	u.ice = liste
	u.iceZamani = time.Now()
	if len(liste) == 0 {
		// Sunucunun TURN'ü henüz hazır değil: biraz sonra yeniden sor.
		u.sonra(3*time.Second, func() { u.gonder(map[string]any{"type": "ice-iste"}) })
		return
	}
	for _, es := range u.esler {
		es.sunuculariTazele()
	}
}

func (u *Uygulama) iceTazeMi() {
	if time.Since(u.iceZamani) > 6*time.Hour {
		u.gonder(map[string]any{"type": "ice-iste"})
	}
}

// ---------------------------------------------------------------- güncelleme denetimi

func (u *Uygulama) guncellemeDenetle() {
	time.Sleep(3 * time.Second)
	for {
		s, err := sonSurum()
		if err == nil && yeniMi(s) {
			u.calistir(func() {
				if u.guncelleme == nil || u.guncelleme.Commit != s.Commit {
					u.guncelleme = s
					u.durum("Yeni sürüm var: "+s.Surum+" · /güncelle", false)
					u.istemGuncelle()
				}
			})
		}
		time.Sleep(6 * time.Hour)
	}
}

// ---------------------------------------------------------------- yardımcılar

func rastgeleKimlik(n int) string {
	const harf = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = harf[rand.Intn(len(harf))]
	}
	return string(b)
}

func rastgeleHex(n int) string {
	const harf = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = harf[rand.Intn(16)]
	}
	return string(b)
}

var trKucukHarf = strings.NewReplacer("I", "ı", "İ", "i")

func trKucuk(s string) string { return strings.ToLower(trKucukHarf.Replace(s)) }

// sadelestir: karşılaştırma için: küçük harf, Türkçe harfler sadeleşir.
func sadelestir(s string) string {
	return strings.NewReplacer("ı", "i", "ç", "c", "ş", "s", "ğ", "g", "ü", "u", "ö", "o", "â", "a", "î", "i", "û", "u").Replace(trKucuk(strings.TrimSpace(s)))
}
