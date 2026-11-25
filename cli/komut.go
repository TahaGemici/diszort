package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/TahaGemici/diszort/cli/ekran"
	"github.com/TahaGemici/diszort/cli/ses"
)

// Komutlar: "/" ile başlayan satırlar; gerisi açık kanala mesaj ("//" ile başlayan mesaj tek "/" ile
// gider). Komut adlarında Türkçe harf şart değil (/yardım = /yardim).

type komut struct {
	adlar []string
	arg   string
	acik  string
	fn    func(u *Uygulama, arg string)
	bolum string
}

var komutlar []komut

func init() {
	komutlar = []komut{
		{[]string{"yardım", "y", "?"}, "", "bu liste", (*Uygulama).kYardim, "Genel"},
		{[]string{"durum"}, "", "bağlantı, sesli kanal, eşler, paylaşım, aktarımlar", (*Uygulama).kDurum, "Genel"},
		{[]string{"çık", "q"}, "", "programdan çık", func(u *Uygulama, _ string) { u.bitir(nil) }, "Genel"},
		{[]string{"güncelle"}, "", "yeni sürüme güncelle ve yeniden başlat", (*Uygulama).kGuncelle, "Genel"},
		{[]string{"bağlan"}, "", "yeniden bağlan (başka yerde girildiyse burada sürdür)", (*Uygulama).kBaglan, "Genel"},
		{[]string{"iptal"}, "[no]", "giriş isteğini geri çek ya da bir aktarımı durdur", (*Uygulama).kIptal, "Genel"},

		{[]string{"kanallar", "k"}, "", "kanallar ve sesli kanallardakiler", (*Uygulama).kKanallar, "Yazılı kanallar"},
		{[]string{"git", "g"}, "<kanal>", "yazılı kanala geç", (*Uygulama).kGit, "Yazılı kanallar"},
		{[]string{"eski"}, "", "açık kanalın daha eski mesajları", (*Uygulama).kEski, "Yazılı kanallar"},
		{[]string{"kanal"}, "ekle yazı|ses <ad> · sil <kanal>", "kanal ekle / sil", (*Uygulama).kKanal, "Yazılı kanallar"},
		{[]string{"dosya", "f"}, "<yol>…", "dosya paylaş (Tab yolu tamamlar; sürükle-bırak da olur)", (*Uygulama).kDosya, "Dosyalar"},
		{[]string{"indir"}, "<no|ad>", "dosyayı İndirilenler'e indir", (*Uygulama).kIndir, "Dosyalar"},
		{[]string{"aktarımlar"}, "", "süren indirmeler/gönderimler, sunduğun dosyalar", func(u *Uygulama, _ string) { u.aktarimlariYaz() }, "Dosyalar"},
		{[]string{"bırak"}, "<no>", "paylaştığın dosyayı artık sunma", (*Uygulama).kBirak, "Dosyalar"},

		{[]string{"ses", "s"}, "<kanal>", "sesli kanala gir", (*Uygulama).kSes, "Sesli kanal"},
		{[]string{"ayrıl", "a"}, "", "sesli kanaldan çık", func(u *Uygulama, _ string) { u.sesKapat(true) }, "Sesli kanal"},
		{[]string{"mik", "m"}, "", "mikrofonu aç/kapat (Alt+M)", func(u *Uygulama, _ string) { u.mikDegistir() }, "Sesli kanal"},
		{[]string{"sağır", "d"}, "", "gelen sesleri kapat/aç (Alt+D)", func(u *Uygulama, _ string) { u.sagirDegistir() }, "Sesli kanal"},
		{[]string{"seviye"}, "<kişi> [paylaşım] <0-100>", "birinin sesi (yalnızca sende)", (*Uygulama).kSeviye, "Sesli kanal"},
		{[]string{"sustur"}, "<kişi> [paylaşım]", "birini yalnızca kendin için sustur / aç", (*Uygulama).kSustur, "Sesli kanal"},
		{[]string{"paylaş", "p"}, "[ekran [no] | ses [aygıt] | gizle | göster | dur [ekran|ses]]", "ekranını ve/veya bilgisayarının sesini paylaş", (*Uygulama).kPaylas, "Sesli kanal"},
		{[]string{"ekranlar"}, "", "paylaşılabilecek monitörler (X11)", (*Uygulama).kEkranlar, "Sesli kanal"},

		{[]string{"kişiler", "u"}, "", "çevrimiçi ve çevrimdışı kişiler", (*Uygulama).kKisiler, "Kişiler ve sunucu"},
		{[]string{"kabul"}, "<ad>", "kapıyı çalanı içeri al", func(u *Uygulama, a string) { u.kKarar(a, true) }, "Kişiler ve sunucu"},
		{[]string{"reddet"}, "<ad>", "kapıyı çalanı reddet", func(u *Uygulama, a string) { u.kKarar(a, false) }, "Kişiler ve sunucu"},
		{[]string{"at"}, "<ad>", "beyaz listeden çıkar (anahtarı iptal olur)", (*Uygulama).kAt, "Kişiler ve sunucu"},
		{[]string{"limit"}, "<2-50>", "beyaz liste sınırı", (*Uygulama).kLimit, "Kişiler ve sunucu"},
		{[]string{"beyazliste"}, "", "beyaz listedekiler ve son girişleri", func(u *Uygulama, _ string) { u.gonder(map[string]any{"type": "beyaz-liste"}) }, "Kişiler ve sunucu"},
		{[]string{"sunucu"}, "", "veritabanı boyutu, mesaj/dosya sayısı, sürüm", func(u *Uygulama, _ string) { u.gonder(map[string]any{"type": "sunucu-bilgi"}) }, "Kişiler ve sunucu"},
		{[]string{"temizle"}, "[#kanal] [gün]", "sohbeti temizle (hepsi ya da o kadar günden eskiler)", (*Uygulama).kTemizle, "Kişiler ve sunucu"},

		{[]string{"ayar"}, "[ad değer]", "ses ayarları (mikrofon, hoparlör, seviye, eşik, kalite, RED…)", (*Uygulama).kAyar, "Ayarlar"},
		{[]string{"aygıtlar"}, "", "mikrofonlar ve hoparlörler", (*Uygulama).kAygitlar, "Ayarlar"},
		{[]string{"dene"}, "", "mikrofonu dene: seviye, gürültü bastırma, eşik (yeniden yaz: bitir)", (*Uygulama).kDene, "Ayarlar"},
	}
}

func komutBul(ad string) *komut {
	n := sadelestir(ad)
	for i := range komutlar {
		for _, a := range komutlar[i].adlar {
			if sadelestir(a) == n {
				return &komutlar[i]
			}
		}
	}
	return nil
}

// girmedenOlur: girmeden de çalışan komutlar.
var girmedenOlur = map[string]bool{"yardım": true, "çık": true, "güncelle": true, "bağlan": true, "iptal": true, "ayar": true, "aygıtlar": true, "dene": true, "durum": true}

func (u *Uygulama) satirGeldi(s string) {
	if strings.TrimSpace(s) == "" {
		return
	}
	if !u.oturumVardi && !u.bekleyenIstek && !u.durduruldu {
		if k := komutBul(strings.Fields(strings.TrimPrefix(s, "/") + " ")[0]); !strings.HasPrefix(s, "/") || k == nil || !girmedenOlur[k.adlar[0]] {
			if len(u.bekleyenler) < 50 {
				u.bekleyenler = append(u.bekleyenler, func() { u.satirGeldi(s) })
			}
			if !u.betik {
				u.durum("Girince yapılacak (bağlanılıyor…).", false)
			}
			return
		}
	}
	if strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") {
		ad, arg, _ := strings.Cut(strings.TrimSpace(s[1:]), " ")
		k := komutBul(ad)
		if k == nil {
			u.durum("Bilinmeyen komut: /"+ad+" (/yardım)", true)
			return
		}
		k.fn(u, strings.TrimSpace(arg))
		return
	}
	if strings.HasPrefix(s, "//") {
		s = s[1:]
	}
	if !u.oturumVardi {
		u.durum("Henüz girmedin; mesaj gönderilemez.", true)
		return
	}
	// Yalnızca bir dosya yolu yapıştırıldıysa (terminale sürükle-bırak): paylaşmak isteyip istemediğini sor.
	if yollar := yollariAyir(s); len(yollar) > 0 && hepsiDosyaMi(yollar) {
		u.ui.Sor(fmt.Sprintf("%d dosya paylaşılsın mı? (e/h) ", len(yollar)), false, func(c string) {
			u.calistir(func() {
				if evetMi(c) {
					u.dosyalariPaylas(yollar)
				} else {
					u.yaziGonder(s)
				}
			})
		})
		return
	}
	u.yaziGonder(s)
}

// konsolSatiri: komut bölmesinden (tmux'un sağ bölmesi) gelen satır: her zaman komut ("/" yazmak şart
// değil). Yalnızca dosya yolları yapıştırıldıysa (sürükle-bırak) açık kanalda paylaşılsın mı diye sorar.
func (u *Uygulama) konsolSatiri(s string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return
	}
	if strings.HasPrefix(s, "//") {
		u.durum("Mesajlar sohbet penceresinden yazılır; burası yalnızca komutlar için.", true)
		return
	}
	if !strings.HasPrefix(s, "/") {
		if yollar := yollariAyir(s); len(yollar) > 0 && hepsiDosyaMi(yollar) {
			if u.aktifKanal == "" || !u.bagli {
				u.durum("Dosya paylaşmak için önce sunucuya bağlan ve bir yazılı kanal seç.", true)
				return
			}
			u.onayla(fmt.Sprintf("%d dosya #%s kanalında paylaşılsın mı?", len(yollar), u.kanalAdi(u.aktifKanal)), func() { u.dosyalariPaylas(yollar) })
			return
		}
		ad, _, _ := strings.Cut(s, " ")
		if komutBul(ad) == nil {
			u.durum("Bilinmeyen komut: "+ad+" (komutların listesi: yardım; mesajlar sohbet penceresinden yazılır)", true)
			return
		}
		s = "/" + s
	}
	u.satirGeldi(s)
}

// sohbetMesaji: tam ekranda yazılan: her zaman açık kanala mesaj (komut değil).
func (u *Uygulama) sohbetMesaji(s string) {
	if strings.TrimSpace(s) == "" {
		return
	}
	if !u.oturumVardi {
		if !u.bekleyenIstek && !u.durduruldu && len(u.bekleyenler) < 50 {
			u.bekleyenler = append(u.bekleyenler, func() { u.sohbetMesaji(s) })
			u.durum("Girince gönderilecek (bağlanılıyor…).", false)
			return
		}
		u.durum("Henüz girmedin; mesaj gönderilemedi.", true)
		return
	}
	u.yaziGonder(s)
}

func hepsiDosyaMi(yollar []string) bool {
	for _, y := range yollar {
		y = yolAc(y)
		if !strings.HasPrefix(y, "/") {
			return false
		}
		b, err := os.Stat(y)
		if err != nil || !b.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func evetMi(s string) bool {
	switch sadelestir(s) {
	case "e", "evet", "y", "yes", "tamam":
		return true
	}
	return false
}

// yaziyorBildir: mesaj yazılıyorken (en çok 4 sn'de bir).
func (u *Uygulama) girdiDegisti(s string) {
	if u.aktifKanal == "" || !u.bagli || strings.TrimSpace(s) == "" || strings.HasPrefix(s, "/") {
		return
	}
	if time.Since(u.yaziyorZamani) < 4*time.Second {
		return
	}
	u.yaziyorZamani = time.Now()
	u.gonder(map[string]any{"type": "yaziyor", "kanal": u.aktifKanal})
}

func (u *Uygulama) tusGeldi(t string) {
	switch t {
	case "alt+m":
		u.mikDegistir()
	case "alt+d":
		u.sagirDegistir()
	case "ctrl+c", "ctrl+d", "eof":
		u.bitir(nil)
	}
}

// onayla: tehlikeli işlerden önce e/h sorusu.
func (u *Uygulama) onayla(soru string, f func()) {
	u.ui.Sor(soru+" (e/h) ", false, func(c string) {
		u.calistir(func() {
			if evetMi(c) {
				f()
			} else {
				u.durum("Vazgeçildi.", false)
			}
		})
	})
}

func (u *Uygulama) bagliMi() bool {
	if !u.bagli {
		u.durum("Sunucuya bağlı değilsin.", true)
		return false
	}
	return true
}

// ---------------------------------------------------------------- genel

func (u *Uygulama) kYardim(string) {
	bolum := ""
	for _, k := range komutlar {
		if k.bolum != bolum {
			bolum = k.bolum
			u.ui.Yaz(u.ui.Kalin(bolum))
		}
		adlar := "/" + k.adlar[0]
		if len(k.adlar) > 1 {
			var kisa []string
			for _, a := range k.adlar[1:] {
				kisa = append(kisa, "/"+a)
			}
			adlar += u.ui.Soluk(" (" + strings.Join(kisa, " ") + ")")
		}
		arg := ""
		if k.arg != "" {
			arg = " " + k.arg
		}
		u.ui.Yaz("  " + adlar + arg + u.ui.Soluk(" — "+k.acik))
	}
	if u.ekran != nil {
		u.ui.Yaz(u.ui.Soluk("Bu bölmede yazılan komut olarak gider (başına / gerekmez; dosya sürüklersen açık kanalda paylaşılır). Tab tamamlar, ↑/↓ önceki komutlar."))
		u.ui.Yaz(u.ui.Soluk("Sohbet (sol bölme): yazılan mesaj olarak gider (Alt+Enter yeni satır, Tab @ad tamamlar). Alt+↑/↓ ya da Alt+1…9 kanal, ↑/↓ ve PgUp/PgDn kaydır, Esc en alta, Alt+M mikrofon, Alt+D sağır."))
		u.ui.Yaz(u.ui.Soluk("Bölmeler arası " + bolmeGecisi() + " / ←; Ctrl+C (hangi bölmede olursa) hepsini kapatır."))
		return
	}
	u.ui.Yaz(u.ui.Soluk("Düz yazı açık kanala mesaj olarak gider (Alt+Enter yeni satır; '/' ile başlayan mesaj için '//'). Tab tamamlar, ↑/↓ önceki satırlar. Alt+M mikrofon, Alt+D sağır, Ctrl+C çık."))
}

func (u *Uygulama) kDurum(arg string) {
	if arg == "json" {
		u.durumJSON()
		return
	}
	b := "bağlı"
	if !u.bagli {
		b = "bağlı değil"
	}
	u.ui.Yaz(u.ui.Kalin(surumYazisi()) + u.ui.Soluk(" · "+u.ayar.Sunucu+" · "+b+" · "+u.ben))
	u.sesDurumuYaz()
	if u.yayin.ekran != nil {
		u.ui.Yaz("  ekran: " + u.yayin.ekran.Bilgi())
	}
	if len(u.dosyalar.indirmeler)+len(u.dosyalar.gonderimler) > 0 {
		u.aktarimlariYaz()
	}
}

func (u *Uygulama) kGuncelle(string) {
	u.durum("Yeni sürüm aranıyor…", false)
	go func() {
		yeni, err := guncelle(nil, func(m string) { u.calistir(func() { u.durum(m, false) }) })
		u.calistir(func() {
			switch {
			case err != nil:
				u.durum("Güncellenemedi: "+err.Error(), true)
			case yeni == "":
				u.durum("Zaten son sürüm: "+surum, false)
			default:
				u.durum("Güncellendi: "+yeni+"; yeniden başlatılıyor…", false)
				// Yeniden başlatmayı main yapar (terminal eski haline döndükten sonra).
				u.yenidenBasliyor = true
				u.bitir(errYenidenBaslat)
			}
		})
	}()
}

func (u *Uygulama) kBaglan(string) {
	if u.bagli {
		u.durum("Zaten bağlısın.", false)
		return
	}
	u.durduruldu = false
	u.yenidenDene = 0
	if u.ayar.Anahtar == "" {
		u.adSor("")
		return
	}
	u.durum("Bağlanılıyor…", false)
	u.baglan()
}

func (u *Uygulama) kIptal(arg string) {
	if arg == "" && u.bekleyenIstek {
		u.gonder(map[string]any{"type": "giris-iptal"})
		if u.ws != nil {
			s := u.ws
			go s.yaz(map[string]any{"type": "giris-iptal"})
			time.AfterFunc(300*time.Millisecond, s.kapat)
		}
		u.durduruldu = true
		u.bekleyenIstek = false
		u.durum("İstek geri çekildi. (/bağlan ile yeniden isteyebilirsin)", false)
		u.istemGuncelle()
		return
	}
	if arg == "" {
		u.durum("Neyi? /iptal <dosya no> (süren aktarımlar: /aktarımlar)", true)
		return
	}
	k, err := u.dosyaBul(arg)
	if err != nil {
		u.durum(err.Error(), true)
		return
	}
	u.aktarimIptal(k)
}

// ---------------------------------------------------------------- yazılı kanallar

func (u *Uygulama) kKanallar(string) {
	u.ui.Yaz(u.ui.Kalin("Yazılı kanallar"))
	for _, k := range u.kanallar {
		if k.Tur != "yazi" {
			continue
		}
		s := "  #" + k.Ad
		if k.ID == u.aktifKanal {
			s = u.ui.Kalin(s + " ◂")
		}
		if n := u.okunmamis[k.ID]; n > 0 {
			s += u.ui.Sari(fmt.Sprintf(" (%d yeni)", n))
		}
		u.ui.Yaz(s)
	}
	u.ui.Yaz(u.ui.Kalin("Sesli kanallar"))
	for _, k := range u.kanallar {
		if k.Tur != "ses" {
			continue
		}
		s := "  ♪ " + k.Ad
		if len(k.Kisiler) > 0 {
			s += u.ui.Soluk(fmt.Sprintf(" %d/%d", len(k.Kisiler), u.sunucuMax))
		}
		if k.ID == u.sesKanal {
			s = u.ui.Yesil(s + " ◂")
		}
		u.ui.Yaz(s)
		for _, p := range k.Kisiler {
			var d []string
			if p.Sagir {
				d = append(d, "sağır")
			} else if p.Sessiz {
				d = append(d, "mikrofonu kapalı")
			}
			if p.Yayin != nil {
				if p.Yayin.Goruntu {
					d = append(d, "ekran paylaşıyor")
				} else {
					d = append(d, "ses paylaşıyor")
				}
			}
			if p.Askida {
				d = append(d, "bağlantısı koptu")
			}
			ek := ""
			if len(d) > 0 {
				ek = u.ui.Soluk(" (" + strings.Join(d, ", ") + ")")
			}
			u.ui.Yaz("      " + u.ui.Ad(p.Ad) + ek)
		}
	}
}

func (u *Uygulama) kGit(arg string) {
	k := u.kanalBul(arg, "yazi")
	if k == nil {
		u.durum("Böyle bir yazılı kanal yok: "+arg+" (/kanallar)", true)
		return
	}
	if k.ID == u.aktifKanal {
		u.durum("Zaten #"+k.Ad+" kanalındasın.", false)
		return
	}
	u.kanalSec(k.ID)
}

func (u *Uygulama) kEski(string) {
	if u.aktifKanal == "" || !u.bagliMi() {
		return
	}
	if u.gecmisBitti {
		u.durum("Bu kanalın başına geldin.", false)
		return
	}
	if u.ekran != nil {
		u.durum("Sohbet penceresinde yukarı kaydır (PgUp): eski mesajlar kendiliğinden gelir.", false)
	}
	u.eskiIste()
}

// eskiIste: açık kanalın yüklenenlerden daha eski mesajlarını iste.
func (u *Uygulama) eskiIste() {
	var once int64
	if len(u.mesajlar) > 0 {
		once = u.mesajlar[0].ID
	}
	u.gecmisIstegi = u.aktifKanal
	u.gonder(map[string]any{"type": "gecmis", "kanal": u.aktifKanal, "once": once})
}

func (u *Uygulama) kKanal(arg string) {
	if !u.bagliMi() {
		return
	}
	alt, kalan, _ := strings.Cut(arg, " ")
	switch sadelestir(alt) {
	case "ekle":
		tur, ad, _ := strings.Cut(strings.TrimSpace(kalan), " ")
		t := map[string]string{"yazi": "yazi", "yazili": "yazi", "ses": "ses", "sesli": "ses"}[sadelestir(tur)]
		ad = strings.TrimSpace(ad)
		if t == "" || ad == "" {
			u.durum("Kullanım: /kanal ekle yazı <ad>  ya da  /kanal ekle ses <ad>", true)
			return
		}
		u.gonder(map[string]any{"type": "kanal-ekle", "tur": t, "ad": kisalt(ad, 24)})
	case "sil":
		k := u.kanalBul(kalan, "")
		if k == nil {
			u.durum("Böyle bir kanal yok: "+kalan, true)
			return
		}
		uyari := fmt.Sprintf("\"%s\" kanalı silinecek", k.Ad)
		if k.Tur == "yazi" {
			uyari += " ve içindeki mesajlar ile dosyalar da silinecek."
		} else if len(k.Kisiler) > 0 {
			uyari += "; içindeki kişiler kanaldan çıkarılacak."
		}
		u.onayla(uyari+" Emin misin?", func() { u.gonder(map[string]any{"type": "kanal-sil", "kanal": k.ID}) })
	default:
		u.durum("Kullanım: /kanal ekle yazı|ses <ad>  ·  /kanal sil <kanal>", true)
	}
}

// ---------------------------------------------------------------- dosyalar

func (u *Uygulama) kDosya(arg string) {
	yollar := yollariAyir(arg)
	if len(yollar) == 0 {
		u.durum("Kullanım: /dosya <yol> [yol…] (Tab tamamlar; dosyayı terminale sürükleyebilirsin)", true)
		return
	}
	u.dosyalariPaylas(yollar)
}

func (u *Uygulama) kIndir(arg string) {
	if arg == "" {
		u.durum("Hangi dosya? /indir <no> (numaralar sohbette dosyanın yanında)", true)
		return
	}
	k, err := u.dosyaBul(arg)
	if err != nil {
		u.durum(err.Error(), true)
		return
	}
	u.dosyaIndir(k)
}

func (u *Uygulama) kBirak(arg string) {
	k, err := u.dosyaBul(arg)
	if err != nil {
		u.durum(err.Error(), true)
		return
	}
	u.paylasimiBirak(k)
}

// ---------------------------------------------------------------- sesli kanal

func (u *Uygulama) kSes(arg string) {
	if arg == "" {
		var sesliler []Kanal
		for _, k := range u.kanallar {
			if k.Tur == "ses" {
				sesliler = append(sesliler, k)
			}
		}
		if len(sesliler) == 1 {
			u.sesAc(sesliler[0].ID)
			return
		}
		u.durum("Hangi kanal? /ses <kanal> (/kanallar)", true)
		return
	}
	k := u.kanalBul(arg, "ses")
	if k == nil {
		u.durum("Böyle bir sesli kanal yok: "+arg+" (/kanallar)", true)
		return
	}
	u.sesAc(k.ID)
}

// kisiArgumani: "<kişi> [paylaşım] <değer>" → kişi, paylaşım mı, kalan.
func (u *Uygulama) kisiArgumani(arg string) (string, bool, string) {
	parcalar := strings.Fields(arg)
	if len(parcalar) == 0 {
		return "", false, ""
	}
	ad := strings.TrimPrefix(parcalar[0], "@")
	// Adda boşluk olabilir: bilinen bir adla en uzun eşleşme.
	for n := len(parcalar); n >= 1; n-- {
		aday := strings.TrimPrefix(strings.Join(parcalar[:n], " "), "@")
		if u.kisiVarMi(aday) {
			ad = u.kisiAdi(aday)
			parcalar = parcalar[n:]
			goto bulundu
		}
	}
	parcalar = parcalar[1:]
bulundu:
	pay := false
	if len(parcalar) > 0 && strings.HasPrefix(sadelestir(parcalar[0]), "payl") {
		pay = true
		parcalar = parcalar[1:]
	}
	return ad, pay, strings.Join(parcalar, " ")
}

func (u *Uygulama) bilinenAdlar() []string {
	gorulen := map[string]bool{}
	var l []string
	ekle := func(a string) {
		if a != "" && !gorulen[a] {
			gorulen[a] = true
			l = append(l, a)
		}
	}
	for _, k := range u.kimler {
		ekle(k.Ad)
	}
	for _, a := range u.beyazListeAdlari {
		ekle(a)
	}
	for a := range u.esler {
		ekle(a)
	}
	for _, i := range u.istekler {
		ekle(i.ad)
	}
	sort.Strings(l)
	return l
}

func (u *Uygulama) kisiVarMi(ad string) bool {
	for _, a := range u.bilinenAdlar() {
		if sadelestir(a) == sadelestir(ad) {
			return true
		}
	}
	return false
}

func (u *Uygulama) kisiAdi(ad string) string {
	for _, a := range u.bilinenAdlar() {
		if sadelestir(a) == sadelestir(ad) {
			return a
		}
	}
	return ad
}

func (u *Uygulama) kSeviye(arg string) {
	ad, pay, kalan := u.kisiArgumani(arg)
	n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(kalan, "%"), "%"))
	if ad == "" || err != nil || n < 0 || n > 100 {
		u.durum("Kullanım: /seviye <kişi> [paylaşım] <0-100>", true)
		return
	}
	k := u.ayar.kisi(ad)
	if pay {
		k.YayinSeviye = n
	} else {
		k.Seviye = n
	}
	u.ayarKaydet()
	if es := u.esler[ad]; es != nil {
		u.esSesUygula(es)
	}
	ne := "sesi"
	if pay {
		ne = "paylaşımının sesi"
	}
	u.durum(fmt.Sprintf("%s %s: %%%d (yalnızca sende).", ad, ne, n), false)
}

func (u *Uygulama) kSustur(arg string) {
	ad, pay, _ := u.kisiArgumani(arg)
	if ad == "" {
		u.durum("Kullanım: /sustur <kişi> [paylaşım]", true)
		return
	}
	k := u.ayar.kisi(ad)
	var simdi bool
	if pay {
		k.YayinSustur = !k.YayinSustur
		simdi = k.YayinSustur
	} else {
		k.Sustur = !k.Sustur
		simdi = k.Sustur
	}
	u.ayarKaydet()
	if es := u.esler[ad]; es != nil {
		u.esSesUygula(es)
	}
	ne := ad
	if pay {
		ne = ad + " paylaşımı"
	}
	if simdi {
		u.durum(ne+" senin için susturuldu.", false)
	} else {
		u.durum(ne+" yeniden duyuluyor.", false)
	}
}

func (u *Uygulama) kPaylas(arg string) {
	alt, kalan, _ := strings.Cut(strings.TrimSpace(arg), " ")
	kalan = strings.TrimSpace(kalan)
	switch sadelestir(alt) {
	case "":
		if u.yayin.var_() && !u.yayin.ekransiz && u.yayin.ses && u.yayin.ekran != nil {
			u.durum("Zaten ekranını ve sesini paylaşıyorsun. ("+u.yayinOzeti()+"; bitirmek: /paylaş dur)", false)
			return
		}
		if !u.yayin.ses {
			u.paylasSes(u.ayar.Ses.YayinAygit)
		}
		if u.yayin.ekran == nil {
			u.paylasEkran(0)
		} else if u.yayin.ekransiz {
			u.ekranGizle(false)
		}
	case "ekran":
		no := 0
		if kalan != "" {
			if strings.HasPrefix(sadelestir(kalan), "tum") || sadelestir(kalan) == "hepsi" {
				no = -1
			} else if n, err := strconv.Atoi(kalan); err == nil {
				no = n
			}
		}
		u.paylasEkran(no)
	case "ses":
		aygit := ""
		if kalan != "" {
			girisler, _, err := u.motor.Aygitlar()
			if err != nil {
				u.durum("Ses aygıtları okunamadı: "+err.Error(), true)
				return
			}
			a, err := ses.AygitBul(girisler, kalan)
			if err != nil {
				u.durum(err.Error()+" (/aygıtlar)", true)
				return
			}
			aygit = a.Ad
		}
		if u.yayin.ses {
			if u.yayin.sesAygit == aygit {
				u.durum("Ses zaten paylaşılıyor.", false)
				return
			}
			u.motor.Paylasim(false, "")
		}
		u.ayar.Ses.YayinAygit = aygit
		u.ayarKaydet()
		u.paylasSes(aygit)
	case "gizle":
		u.ekranGizle(true)
	case "goster":
		u.ekranGizle(false)
	case "dur", "bitir", "kapat":
		switch sadelestir(kalan) {
		case "ekran":
			u.ekranDurdur()
		case "ses":
			u.sesPaylasimiDurdur()
		default:
			if !u.yayin.var_() {
				u.durum("Paylaşım yok.", false)
				return
			}
			u.yayinDurdur(true)
		}
	default:
		u.durum("Kullanım: /paylaş · /paylaş ekran [no|tümü] · /paylaş ses [aygıt] · /paylaş gizle|göster · /paylaş dur [ekran|ses]", true)
	}
}

func (u *Uygulama) kEkranlar(string) {
	switch ekran.Oturum() {
	case "wayland":
		u.ui.Yaz("Wayland: paylaşılacak ekranı (ya da pencereyi) masaüstünün seçim penceresi sorar; seçim hatırlanır." + u.ui.Soluk(" (başka bir ekran seçmek için: /ayar ekran-seçimi sıfırla)"))
	case "x11":
		ml, err := ekran.X11Monitorler()
		if err != nil {
			u.durum("Monitörler okunamadı: "+err.Error(), true)
			return
		}
		for _, m := range ml {
			u.ui.Yaz("  " + m.String())
		}
		u.ui.Yaz(u.ui.Soluk("  /paylaş ekran <no> (ya da tümü); numarasız: birincil monitör"))
	default:
		u.durum("Masaüstü oturumu bulunamadı.", true)
	}
}

// ---------------------------------------------------------------- kişiler ve sunucu

func (u *Uygulama) kKisiler(string) {
	cevrimici := map[string]bool{}
	u.ui.Yaz(u.ui.Kalin(fmt.Sprintf("Çevrimiçi — %d", len(u.kimler))))
	for _, k := range u.kimler {
		cevrimici[k.Ad] = true
		ek := "çevrimiçi"
		if k.Ses != nil {
			ek = "♪ " + u.kanalAdi(*k.Ses)
		}
		ben := ""
		if k.Ad == u.ben {
			ben = " (sen)"
		}
		u.ui.Yaz("  " + u.ui.Ad(k.Ad) + ben + u.ui.Soluk(" "+ek))
	}
	var disarida []string
	for _, a := range u.beyazListeAdlari {
		if !cevrimici[a] {
			disarida = append(disarida, a)
		}
	}
	sort.Strings(disarida)
	if len(disarida) > 0 {
		u.ui.Yaz(u.ui.Kalin(fmt.Sprintf("Çevrimdışı — %d", len(disarida))))
		for _, a := range disarida {
			u.ui.Yaz("  " + u.ui.Soluk(a))
		}
	}
	if u.beyazListe > 0 {
		u.ui.Yaz(u.ui.Soluk(fmt.Sprintf("Beyaz liste %d/%d · /limit <n> · /at <ad>", u.beyazListe, u.maxKullanici)))
	}
	if len(u.istekler) > 0 {
		for _, i := range u.istekler {
			u.ui.Yaz(u.ui.Sari("  ! "+i.ad+" girmek istiyor") + u.ui.Soluk(" · /kabul "+i.ad+" · /reddet "+i.ad))
		}
	}
}

func (u *Uygulama) kKarar(arg string, kabul bool) {
	if !u.bagliMi() {
		return
	}
	if len(u.istekler) == 0 {
		u.durum("Bekleyen giriş isteği yok.", false)
		return
	}
	var sec *istek
	if arg == "" && len(u.istekler) == 1 {
		sec = &u.istekler[0]
	} else {
		for i := range u.istekler {
			if sadelestir(u.istekler[i].ad) == sadelestir(strings.TrimPrefix(arg, "@")) || u.istekler[i].id == arg {
				sec = &u.istekler[i]
				break
			}
		}
	}
	if sec == nil {
		var adlar []string
		for _, i := range u.istekler {
			adlar = append(adlar, i.ad)
		}
		u.durum("Kimin? Bekleyenler: "+strings.Join(adlar, ", "), true)
		return
	}
	id, ad := sec.id, sec.ad
	u.gonder(map[string]any{"type": "giris-karari", "id": id, "kabul": kabul})
	u.istekSil(id)
	if !kabul {
		u.durum(ad+" reddedildi.", false)
	}
}

func (u *Uygulama) kAt(arg string) {
	if !u.bagliMi() {
		return
	}
	ad := u.kisiAdi(strings.TrimPrefix(strings.TrimSpace(arg), "@"))
	if ad == "" {
		u.durum("Kimi? /at <ad>", true)
		return
	}
	if ad == u.ben {
		u.durum("Kendini atamazsın.", true)
		return
	}
	u.onayla(fmt.Sprintf("\"%s\" beyaz listeden çıkarılacak ve anahtarı iptal edilecek; tekrar girmek için izin istemesi gerekir. Emin misin?", ad), func() {
		u.gonder(map[string]any{"type": "at", "ad": ad})
	})
}

func (u *Uygulama) kLimit(arg string) {
	if !u.bagliMi() {
		return
	}
	n, err := strconv.Atoi(strings.TrimSpace(arg))
	if err != nil {
		u.durum(fmt.Sprintf("Beyaz liste %d/%d. Değiştirmek: /limit <2-50>", u.beyazListe, u.maxKullanici), false)
		return
	}
	n = min(50, max(2, n))
	u.gonder(map[string]any{"type": "kisi-limiti", "deger": n})
}

func (u *Uygulama) kTemizle(arg string) {
	if !u.bagliMi() {
		return
	}
	kanal, gun := "", 0
	for _, p := range strings.Fields(arg) {
		if n, err := strconv.Atoi(p); err == nil {
			gun = n
			continue
		}
		k := u.kanalBul(p, "yazi")
		if k == nil {
			u.durum("Böyle bir yazılı kanal yok: "+p, true)
			return
		}
		kanal = k.ID
	}
	kapsam := "Tüm yazılı kanallardaki"
	if kanal != "" {
		kapsam = "#" + u.kanalAdi(kanal) + " kanalındaki"
	}
	ne := "bütün mesajlar"
	if gun > 0 {
		ne = fmt.Sprintf("%d günden eski mesajlar", gun)
	}
	u.onayla(fmt.Sprintf("%s %s ve paylaşılan dosyaların kayıtları kalıcı olarak silinecek (geri alınamaz). Emin misin?", kapsam, ne), func() {
		u.gonder(map[string]any{"type": "sohbet-temizle", "kanal": kanal, "gun": gun})
	})
}

// ---------------------------------------------------------------- ayarlar

func acikKapali(v bool) string {
	if v {
		return "açık"
	}
	return "kapalı"
}

func (u *Uygulama) kAyar(arg string) {
	s := &u.ayar.Ses
	ad, deger, _ := strings.Cut(strings.TrimSpace(arg), " ")
	deger = strings.TrimSpace(deger)
	if ad == "" {
		esik := "kapalı"
		if s.Esik > 0 {
			esik = fmt.Sprintf("%%%d (%.0f dBFS)", s.Esik, esikDb(s.Esik))
		}
		satirlar := [][2]string{
			{"mik", firstNonEmpty(s.Mik, "varsayılan")},
			{"hoparlör", firstNonEmpty(s.Hoparlor, "varsayılan")},
			{"seviye", fmt.Sprintf("%%%d (mikrofonun gönderilen seviyesi, 0-200)", s.MikSeviye)},
			{"eşik", esik + " (konuşma eşiği: altında ses gitmez)"},
			{"kalite", fmt.Sprintf("%d kbps (mikrofon: 48, 96, 128)", s.Kalite)},
			{"paylaşım-kalite", fmt.Sprintf("%d kbps (paylaşılan ses: 96, 128, 192, 256, 320)", s.YayinSes)},
			{"red", acikKapali(s.MikRed) + " (mikrofonda kayıplara karşı yedek)"},
			{"paylaşım-red", acikKapali(s.YayinRed) + fmt.Sprintf(" (paylaşılan seste yedek; en çok %d kbps'de)", redSiganHiz)},
			{"sesler", acikKapali(s.Sesler) + " (giriş/çıkış sesleri)"},
			{"yankı", acikKapali(s.YankiEngel) + " (yankı engelleme: hoparlörle konuşuyorsan aç; kulaklıkta gerekmez)"},
			{"kare", fmt.Sprintf("%d (ekran paylaşımının kare hızı: 15, 30, 60)", s.Kare)},
			{"paylaşım-aygıt", firstNonEmpty(s.YayinAygit, "uygulamaların sesi (Diszort hariç)")},
			{"güncelleme", acikKapali(!u.ayar.OtoGuncellemeKapali) + " (açılışta yeni sürüm varsa kendiliğinden güncellenir)"},
		}
		u.ui.Yaz(u.ui.Kalin("Ayarlar") + u.ui.Soluk(" · değiştirmek: /ayar <ad> <değer> · "+u.ayar.yol))
		for _, sa := range satirlar {
			u.ui.Yaz("  " + sa[0] + u.ui.Soluk(": ") + sa[1])
		}
		return
	}
	mantik := func() (bool, bool) {
		switch sadelestir(deger) {
		case "acik", "ac", "evet", "1", "on":
			return true, true
		case "kapali", "kapa", "hayir", "0", "off":
			return false, true
		}
		u.durum("Değer: açık ya da kapalı", true)
		return false, false
	}
	sayi := func(gecerli ...int) (int, bool) {
		n, err := strconv.Atoi(strings.Trim(deger, "%"))
		if err != nil {
			u.durum("Bir sayı yaz.", true)
			return 0, false
		}
		if len(gecerli) > 0 {
			for _, g := range gecerli {
				if g == n {
					return n, true
				}
			}
			u.durum(fmt.Sprintf("Geçerli değerler: %v", gecerli), true)
			return 0, false
		}
		return n, true
	}
	switch sadelestir(ad) {
	case "mik", "mikrofon":
		if deger == "" || sadelestir(deger) == "varsayilan" {
			s.Mik = ""
		} else {
			girisler, _, err := u.motor.Aygitlar()
			if err != nil {
				u.durum("Ses aygıtları okunamadı: "+err.Error(), true)
				return
			}
			a, err := ses.AygitBul(girisler, deger)
			if err != nil {
				u.durum(err.Error()+" (/aygıtlar)", true)
				return
			}
			s.Mik = a.Ad
		}
		u.mikUygula()
	case "hoparlor", "cikis":
		if deger == "" || sadelestir(deger) == "varsayilan" {
			s.Hoparlor = ""
		} else {
			_, cikislar, err := u.motor.Aygitlar()
			if err != nil {
				u.durum("Ses aygıtları okunamadı: "+err.Error(), true)
				return
			}
			a, err := ses.AygitBul(cikislar, deger)
			if err != nil {
				u.durum(err.Error()+" (/aygıtlar)", true)
				return
			}
			s.Hoparlor = a.Ad
		}
		if u.sesKanal != "" {
			u.motor.Cikis(true, s.Hoparlor)
		}
	case "seviye":
		n, ok := sayi()
		if !ok {
			return
		}
		s.MikSeviye = min(200, max(0, n))
		u.mikUygula()
	case "esik":
		if strings.HasPrefix(sadelestir(deger), "kapa") {
			s.Esik = 0
		} else {
			n, ok := sayi()
			if !ok {
				return
			}
			s.Esik = min(100, max(0, n))
		}
		u.mikUygula()
	case "kalite":
		n, ok := sayi(48, 96, 128)
		if !ok {
			return
		}
		s.Kalite = n
		u.bitHizlariniAyarla()
		u.opusYenile()
	case "paylasim-kalite", "paylasimkalite":
		n, ok := sayi(yayinSesSecenekleri...)
		if !ok {
			return
		}
		s.YayinSes = n
		u.bitHizlariniAyarla()
		u.opusYenile()
	case "red":
		v, ok := mantik()
		if !ok {
			return
		}
		s.MikRed = v
		u.bitHizlariniAyarla()
	case "paylasim-red", "paylasimred":
		v, ok := mantik()
		if !ok {
			return
		}
		s.YayinRed = v
		u.bitHizlariniAyarla()
	case "sesler":
		v, ok := mantik()
		if !ok {
			return
		}
		s.Sesler = v
	case "yanki", "yanki-engelleme":
		v, ok := mantik()
		if !ok {
			return
		}
		s.YankiEngel = v
		u.mikUygula()
	case "kare":
		n, ok := sayi(15, 30, 60)
		if !ok {
			return
		}
		s.Kare = n
		if u.yayin.ekran != nil {
			u.durum("Yeni kare hızı bir sonraki ekran paylaşımında geçerli.", false)
		}
	case "paylasim-aygit", "paylasimaygit":
		if deger == "" || strings.HasPrefix(sadelestir(deger), "uygulama") || sadelestir(deger) == "varsayilan" {
			s.YayinAygit = ""
		} else {
			girisler, _, err := u.motor.Aygitlar()
			if err != nil {
				u.durum("Ses aygıtları okunamadı: "+err.Error(), true)
				return
			}
			a, err := ses.AygitBul(girisler, deger)
			if err != nil {
				u.durum(err.Error()+" (/aygıtlar)", true)
				return
			}
			s.YayinAygit = a.Ad
		}
	case "ekran-secimi", "ekransecimi":
		u.ayar.EkranIzni = ""
		u.durum("Ekran seçimi unutuldu; bir sonraki paylaşımda yeniden sorulur.", false)
	case "guncelleme", "otomatik-guncelleme":
		v, ok := mantik()
		if !ok {
			return
		}
		u.ayar.OtoGuncellemeKapali = !v
	default:
		u.durum("Bilinmeyen ayar: "+ad+" (/ayar)", true)
		return
	}
	u.ayar.duzelt()
	u.ayarKaydet()
	u.durum("Kaydedildi.", false)
}

// opusYenile: karşı taraftaki Firefox Opus hedefini ancak yeniden anlaşmada uygular: teklif ettiğimiz
// bağlantılarda yeni teklif, yanıtladıklarımızda karşıdan yeni teklif iste. (Bizim kodlayıcımız
// hemen ayarlanır.)
func (u *Uygulama) opusYenile() {
	for _, es := range u.esler {
		if es.pc == nil || esKapandi(es) || es.pc.RemoteDescription() == nil {
			continue
		}
		if !es.teklifci {
			u.gonder(map[string]any{"type": "yenile", "to": es.ad, "oturum": es.oturum, "teklif": true})
		}
	}
}

func (u *Uygulama) kAygitlar(string) {
	girisler, cikislar, err := u.motor.Aygitlar()
	if err != nil {
		u.durum("Ses aygıtları okunamadı: "+err.Error(), true)
		return
	}
	yaz := func(baslik string, l []ses.AygitBilgisi, secili string) {
		u.ui.Yaz(u.ui.Kalin(baslik))
		for i, a := range l {
			ek := ""
			if a.Varsayilan {
				ek += " (varsayılan)"
			}
			if a.Monitor {
				ek += " (bir hoparlörün sesi)"
			}
			s := fmt.Sprintf("  %d. %s", i+1, a.Aciklama)
			if a.Ad == secili {
				s = u.ui.Kalin(s + " ◂")
			}
			u.ui.Yaz(s + u.ui.Soluk(ek))
		}
	}
	yaz("Mikrofonlar (/ayar mik <no>)", girisler, u.ayar.Ses.Mik)
	yaz("Hoparlörler (/ayar hoparlör <no>)", cikislar, u.ayar.Ses.Hoparlor)
}

func (u *Uygulama) kDene(string) {
	u.denemede = !u.denemede
	if u.denemede {
		u.motor.Cikis(true, u.ayar.Ses.Hoparlor)
		u.durum("Mikrofon deneniyor: seviye, gürültü bastırma ve eşik giriş satırında. Bitirmek için /dene.", false)
	} else {
		if u.sesKanal == "" {
			u.motor.Cikis(false, "")
		}
		u.durum("Deneme bitti.", false)
	}
	u.mikUygula()
	u.istemGuncelle()
}

// denemeIstemi: deneme sürerken giriş satırının başı.
func (u *Uygulama) denemeIstemi() string {
	md := u.motor.MikDurumu()
	if !md.Acik {
		return u.ui.Sari("[deneme: mikrofon açılıyor…]")
	}
	o := md.Olcum
	seviye := math.Max(0, math.Min(1, (o.CikisDb+60)/50))
	dolu := int(math.Round(seviye * 10))
	cubuk := strings.Repeat("▮", dolu) + strings.Repeat("▯", 10-dolu)
	esik := ""
	if u.ayar.Ses.Esik > 0 {
		if o.Acik {
			esik = " · ses gidiyor"
		} else {
			esik = " · eşiğin altında"
		}
	}
	return u.ui.Mavi(fmt.Sprintf("[deneme %s konuşma %%%d · gürültü %+.0f dB%s]", cubuk, int(o.Konusma*100), math.Min(0, o.RnnDb-o.GirisDb), esik))
}

// ---------------------------------------------------------------- Tab tamamlama

func (u *Uygulama) tamamla(girdi string) (string, []string) {
	sonuc := make(chan [2]any, 1)
	u.calistir(func() {
		y, o := u.tamamlaIc(girdi)
		sonuc <- [2]any{y, o}
	})
	select {
	case r := <-sonuc:
		return r[0].(string), r[1].([]string)
	case <-time.After(time.Second):
		return girdi, nil
	}
}

// ortakBas: adayların ortak başı (büyük/küçük harf duyarsız).
func ortakBas(adaylar []string) string {
	if len(adaylar) == 0 {
		return ""
	}
	bas := []rune(adaylar[0])
	for _, a := range adaylar[1:] {
		r := []rune(a)
		n := 0
		for n < len(bas) && n < len(r) && strings.EqualFold(string(bas[n]), string(r[n])) {
			n++
		}
		bas = bas[:n]
	}
	return string(bas)
}

func tamamlaListe(girdi, son string, adaylar []string, bosluk bool) (string, []string) {
	var uyan []string
	for _, a := range adaylar {
		if strings.HasPrefix(sadelestir(a), sadelestir(son)) {
			uyan = append(uyan, a)
		}
	}
	if len(uyan) == 0 {
		return girdi, nil
	}
	bas := girdi[:len(girdi)-len(son)]
	if len(uyan) == 1 {
		ek := ""
		if bosluk {
			ek = " "
		}
		return bas + uyan[0] + ek, nil
	}
	o := ortakBas(uyan)
	if len([]rune(o)) > len([]rune(son)) {
		return bas + o, uyan
	}
	return girdi, uyan
}

func (u *Uygulama) tamamlaIc(girdi string) (string, []string) {
	if !strings.HasPrefix(girdi, "/") {
		// Mesajda @ad.
		i := strings.LastIndexAny(girdi, " \n")
		son := girdi[i+1:]
		if strings.HasPrefix(son, "@") {
			var adlar []string
			for _, a := range u.bilinenAdlar() {
				adlar = append(adlar, "@"+a)
			}
			return tamamlaListe(girdi, son, adlar, true)
		}
		return girdi, nil
	}
	ad, arg, varArg := strings.Cut(girdi[1:], " ")
	if !varArg {
		var adlar []string
		for _, k := range komutlar {
			adlar = append(adlar, "/"+k.adlar[0])
		}
		return tamamlaListe(girdi, girdi, adlar, true)
	}
	k := komutBul(ad)
	if k == nil {
		return girdi, nil
	}
	son := arg
	if i := strings.LastIndex(arg, " "); i >= 0 {
		son = arg[i+1:]
	}
	kanallar := func(tur string) []string {
		var l []string
		for _, c := range u.kanallar {
			if tur == "" || c.Tur == tur {
				l = append(l, c.Ad)
			}
		}
		return l
	}
	switch k.adlar[0] {
	case "git":
		return tamamlaListe(girdi, son, kanallar("yazi"), false)
	case "ses":
		return tamamlaListe(girdi, son, kanallar("ses"), false)
	case "temizle":
		return tamamlaListe(girdi, son, kanallar("yazi"), true)
	case "kanal":
		if !strings.Contains(arg, " ") {
			return tamamlaListe(girdi, son, []string{"ekle", "sil"}, true)
		}
		if strings.HasPrefix(sadelestir(arg), "sil ") {
			return tamamlaListe(girdi, son, kanallar(""), false)
		}
		if strings.HasPrefix(sadelestir(arg), "ekle ") && strings.Count(arg, " ") == 1 {
			return tamamlaListe(girdi, son, []string{"yazı", "ses"}, true)
		}
	case "kabul", "reddet":
		var l []string
		for _, i := range u.istekler {
			l = append(l, i.ad)
		}
		return tamamlaListe(girdi, son, l, false)
	case "at", "seviye", "sustur":
		if !strings.Contains(arg, " ") {
			return tamamlaListe(girdi, son, u.bilinenAdlar(), true)
		}
		if k.adlar[0] != "at" {
			return tamamlaListe(girdi, son, []string{"paylaşım"}, true)
		}
	case "paylaş":
		if !strings.Contains(arg, " ") {
			return tamamlaListe(girdi, son, []string{"ekran", "ses", "gizle", "göster", "dur"}, true)
		}
		if strings.HasPrefix(sadelestir(arg), "dur ") {
			return tamamlaListe(girdi, son, []string{"ekran", "ses"}, false)
		}
	case "ayar":
		if !strings.Contains(arg, " ") {
			return tamamlaListe(girdi, son, []string{"mik", "hoparlör", "seviye", "eşik", "kalite", "paylaşım-kalite", "red", "paylaşım-red", "sesler", "yankı", "kare", "paylaşım-aygıt", "ekran-seçimi", "güncelleme"}, true)
		}
		alt := sadelestir(strings.Fields(arg)[0])
		switch alt {
		case "red", "paylasim-red", "sesler", "yanki":
			return tamamlaListe(girdi, son, []string{"açık", "kapalı"}, false)
		case "kalite":
			return tamamlaListe(girdi, son, []string{"48", "96", "128"}, false)
		case "kare":
			return tamamlaListe(girdi, son, []string{"15", "30", "60"}, false)
		}
	case "indir", "bırak", "iptal":
		var l []string
		for _, id := range u.dosyalar.numaralar {
			l = append(l, u.dosyalar.bilgiler[id].Ad)
		}
		return tamamlaListe(girdi, son, l, false)
	case "dosya":
		return yolTamamla(girdi, son)
	}
	return girdi, nil
}

// yolTamamla: dosya yolu (boşluklar kaçışlı).
func yolTamamla(girdi, son string) (string, []string) {
	ham := strings.ReplaceAll(son, `\ `, " ")
	acik := yolAc(ham)
	klasor, bas := filepath.Split(acik)
	if klasor == "" {
		klasor = "."
	}
	girdiler, err := os.ReadDir(klasor)
	if err != nil {
		return girdi, nil
	}
	var adaylar []string
	for _, g := range girdiler {
		ad := g.Name()
		if strings.HasPrefix(ad, ".") && !strings.HasPrefix(bas, ".") {
			continue
		}
		if !strings.HasPrefix(ad, bas) {
			continue
		}
		if g.IsDir() {
			ad += "/"
		}
		adaylar = append(adaylar, ad)
	}
	if len(adaylar) == 0 {
		return girdi, nil
	}
	sort.Strings(adaylar)
	kacir := func(s string) string { return strings.ReplaceAll(s, " ", `\ `) }
	onEk := girdi[:len(girdi)-len(son)]
	klasorYazi := son[:len(son)-len(kacir(bas))]
	if len(adaylar) == 1 {
		ek := ""
		if !strings.HasSuffix(adaylar[0], "/") {
			ek = " "
		}
		return onEk + klasorYazi + kacir(adaylar[0]) + ek, nil
	}
	o := ortakBas(adaylar)
	return onEk + klasorYazi + kacir(o), adaylar
}

// durumJSON: makinece okunur durum (denemeler için): "DURUM {...}".
func (u *Uygulama) durumJSON() {
	esler := map[string]any{}
	for ad, es := range u.esler {
		d := map[string]any{"durum": es.durum.String(), "tip": es.sonTip, "rttMs": math.Round(es.rtt * 1000), "izliyor": es.izliyor}
		if es.mikKaynak != nil {
			s := es.mikKaynak.Ses.Durum()
			d["mik"] = map[string]any{"alinan": s.Alinan, "red": s.Red, "uydurulan": s.Uydurulan, "kurtarilan": s.Kurtarilan, "konusuyor": s.Konusuyor, "caliyor": s.Caliyor, "tamponMs": math.Round(s.TamponMs)}
		}
		if es.payKaynak != nil {
			s := es.payKaynak.Ses.Durum()
			d["yayin"] = map[string]any{"alinan": s.Alinan, "konusuyor": s.Konusuyor}
		}
		if es.mikIz != nil {
			d["gidenRed"] = es.mikIz.redGidiyor()
		}
		esler[ad] = d
	}
	md := u.motor.MikDurumu()
	y := map[string]any{"ses": u.yayin.ses, "ekran": u.yayin.ekran != nil, "gizli": u.yayin.ekransiz, "uygulamalar": u.motor.PaylasimKaynaklari()}
	if u.yayin.ekran != nil {
		y["bilgi"] = u.yayin.ekran.Bilgi()
	}
	v := map[string]any{"bagli": u.bagli, "ben": u.ben, "ses": u.sesKanal, "kanal": u.aktifKanal, "mik": map[string]any{"acik": md.Acik, "konusuyor": md.Konusuyor, "aygit": md.Aygit}, "esler": esler, "yayin": y, "indirmeler": len(u.dosyalar.indirmeler), "paylasimlarim": len(u.dosyalar.paylasimlarim)}
	b, _ := json.Marshal(v)
	u.ui.Yaz("DURUM " + string(b))
}
