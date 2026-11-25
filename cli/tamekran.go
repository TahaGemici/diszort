package main

import (
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/term"
)

// Tam ekran sohbet: terminali kaplar: üstte durum çubuğu, solda kanallar ve kişiler, ortada açık
// kanalın mesajları, altta bildirim ve yazma satırı. Yazılan her şey açık kanala mesaj olarak gider;
// komutlar tmux'un sağ bölmesindeki komut konsolundan verilir (tmux.go, konsol.go). Fare yok.
//
// Bütün durum olay döngüsünde değişir; çizim de orada yapılır: en çok ~30 kare/sn ve yalnızca
// değişen satırlar yazılır (görüşmede konuşanları göstermek için saniyede 5 kez bakılır).

type ekranSorusu struct {
	metin     string
	evetHayir bool
	cevap     func(string)
}

type TamEkran struct {
	u        *Uygulama
	gen, yuk int
	onceki   []string
	imlecS   int
	oncekiI  int
	tamCiz   bool

	girdi  []rune
	imlec  int
	kaydir int

	kaydirma  int // sohbet alttan kaç satır yukarıda (0: en altta)
	yeniAltta int // yukarıdayken gelen mesaj sayısı
	sohbetG   int // son çizimde sohbet alanının genişliği

	bildirim      string
	bildirimHata  bool
	bildirimZaman time.Time

	soru         *ekranSorusu
	komutUyarisi string

	canli atomic.Bool // sesli kanalda: konuşanlar için sık çiz

	mu            sync.Mutex
	eskiDurum     *term.State
	bitti         atomic.Bool
	sonCizim      time.Time
	cizimBekliyor bool
	ust           string // durum çubuğunun rengi
}

func yeniTamEkran(u *Uygulama) *TamEkran {
	e := &TamEkran{u: u, gen: 80, yuk: 24}
	switch {
	case !u.ui.renk:
		e.ust = "\x1b[7m"
	default:
		e.ust = "\x1b[48;5;236m\x1b[38;5;252m"
	}
	return e
}

// ---------------------------------------------------------------- terminal

func (e *TamEkran) Baslat() error {
	durum, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return err
	}
	e.eskiDurum = durum
	e.boyutAl()
	// Ayrı ekran (çıkınca terminal eski haline döner), satır taşması kapalı (düzen bozulmasın),
	// yapıştırılan metin tek parça.
	os.Stdout.WriteString("\x1b[?1049h\x1b[?7l\x1b[?2004h\x1b[H\x1b[2J")
	u := e.u
	isaret := make(chan os.Signal, 4)
	signal.Notify(isaret, syscall.SIGWINCH, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for s := range isaret {
			if s == syscall.SIGWINCH {
				u.calistir(func() {
					e.boyutAl()
					e.tamCiz = true
				})
				continue
			}
			u.calistir(func() { u.bitir(nil) })
		}
	}()
	go tuslariOku(os.Stdin, tusAlici{
		Tus:      func(ad string) { u.calistir(func() { e.tus(ad) }) },
		Harf:     func(r rune) { u.calistir(func() { e.harf(r) }) },
		Yapistir: func(s string) { u.calistir(func() { e.yapistir(s) }) },
		Bitti:    func() { u.calistir(func() { u.bitir(nil) }) },
	})
	go func() {
		for range time.Tick(200 * time.Millisecond) {
			if e.canli.Load() {
				u.calistir(func() {})
			}
		}
	}()
	return nil
}

func (e *TamEkran) boyutAl() {
	if g, y, err := term.GetSize(int(os.Stdout.Fd())); err == nil && g > 0 && y > 0 {
		e.gen, e.yuk = g, y
	}
}

// Bitir: terminali eski haline getir (birden çok kez çağrılabilir).
func (e *TamEkran) Bitir() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.bitti.CompareAndSwap(false, true) || e.eskiDurum == nil {
		return
	}
	os.Stdout.WriteString("\x1b[0m\x1b[?2004l\x1b[?7h\x1b[?25h\x1b[?1049l")
	term.Restore(int(os.Stdin.Fd()), e.eskiDurum)
}

func (e *TamEkran) zil() { os.Stdout.WriteString("\a") }

// belkiCiz: her işten sonra (olay döngüsünde): son çizimden 30 ms geçtiyse hemen, yoksa biraz sonra.
func (e *TamEkran) belkiCiz() {
	if e.bitti.Load() {
		return
	}
	if d := time.Since(e.sonCizim); d >= 30*time.Millisecond {
		e.ciz()
	} else if !e.cizimBekliyor {
		e.cizimBekliyor = true
		time.AfterFunc(30*time.Millisecond-d, func() { e.u.calistir(func() { e.cizimBekliyor = false }) })
	}
}

func (e *TamEkran) ciz() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.bitti.Load() {
		return
	}
	e.sonCizim = time.Now()
	e.canli.Store(e.u.sesKanal != "")
	satirlar := e.olustur()
	var b strings.Builder
	if e.tamCiz || len(e.onceki) != len(satirlar) {
		b.WriteString("\x1b[H\x1b[2J")
		e.onceki = nil
		e.tamCiz = false
	}
	for i, s := range satirlar {
		if i < len(e.onceki) && e.onceki[i] == s {
			continue
		}
		fmt.Fprintf(&b, "\x1b[%d;1H%s\x1b[0m\x1b[K", i+1, s)
	}
	e.onceki = satirlar
	if b.Len() == 0 && e.imlecS == e.oncekiI {
		return
	}
	e.oncekiI = e.imlecS
	os.Stdout.WriteString("\x1b[?2026h\x1b[?25l" + b.String() + fmt.Sprintf("\x1b[%d;%dH\x1b[?25h\x1b[?2026l", e.yuk, e.imlecS+1))
}

// ---------------------------------------------------------------- düzen

func (e *TamEkran) olustur() []string {
	g, y := e.gen, e.yuk
	satirlar := make([]string, y)
	if g < 30 || y < 8 {
		satirlar[0] = kes("Pencere çok küçük", g)
		return satirlar
	}
	govde := y - 3
	kenarG := 0
	if g >= 72 {
		kenarG = min(28, max(20, g/5))
	}
	sohbetG := g - 2
	if kenarG > 0 {
		sohbetG = g - kenarG - 3
	}
	e.sohbetG = sohbetG
	satirlar[0] = e.baslik(g, kenarG == 0)
	var kenar []string
	if kenarG > 0 {
		kenar = e.kenarCubugu(kenarG, govde)
	}
	sohbet := e.sohbet(sohbetG, govde)
	ayrac := e.u.ui.Soluk("│")
	for i := 0; i < govde; i++ {
		if kenarG > 0 {
			satirlar[1+i] = kenar[i] + ayrac + " " + sohbet[i]
		} else {
			satirlar[1+i] = " " + sohbet[i]
		}
	}
	satirlar[y-2] = kes(e.bilgiSatiri(), g)
	satirlar[y-1], e.imlecS = e.girdiSatiri(g)
	return satirlar
}

// baslik: durum çubuğu: Diszort · sunucu (· #kanal) … bağlantı, sesli kanal, paylaşım, aktarımlar.
func (e *TamEkran) baslik(g int, kanalDa bool) string {
	u := e.u
	sol := u.ui.Kalin("Diszort") + u.ui.Soluk(" · "+sunucuAdi(u.ayar.Sunucu))
	if kanalDa && u.aktifKanal != "" {
		sol += " · " + u.ui.Kalin("#"+u.kanalAdi(u.aktifKanal))
	}
	sag := strings.Join(u.durumParcalari(true), u.ui.Soluk(" · "))
	if u.oturumVardi && u.sesKanal == "" && !u.yayin.var_() && sag == "" {
		sag = u.ui.Soluk(fmt.Sprintf("%d kişi çevrimiçi", len(u.kimler)))
	}
	s := " " + iki(sol, sag, g-2) + " "
	return e.ust + strings.ReplaceAll(s, "\x1b[0m", "\x1b[0m"+e.ust) + strings.Repeat(" ", max(0, g-gorunur(s)))
}

func sunucuAdi(adres string) string {
	if v, err := urlCoz(adres); err == nil && v.Host != "" {
		return v.Host
	}
	return adres
}

// kenarCubugu: yazılı kanallar (okunmamışlar), sesli kanallar ve içindekiler, çevrimiçi kişiler,
// kapıdakiler. Her satır tam w sütun.
func (e *TamEkran) kenarCubugu(w, h int) []string {
	u := e.u
	ui := u.ui
	var s []string
	baslik := func(t string) { s = append(s, " "+ui.Soluk(ui.Kalin(t))) }
	if len(u.istekler) > 0 {
		s = append(s, " "+ui.Sari(ui.Kalin(fmt.Sprintf("KAPIDA · %d", len(u.istekler)))))
		for _, i := range u.istekler {
			s = append(s, "  "+ui.Ad(i.ad))
		}
		s = append(s, " "+ui.Soluk("komut: kabul <ad>"), "")
	}
	baslik("YAZILI")
	for _, k := range u.kanallar {
		if k.Tur != "yazi" {
			continue
		}
		sag := ""
		if u.bahsedilen[k.ID] {
			sag = ui.Vurgu("@")
		} else if n := u.okunmamis[k.ID]; n > 0 {
			sag = ui.Sari(fmt.Sprint(n))
		}
		ad := "# " + k.Ad
		if k.ID == u.aktifKanal {
			s = append(s, "\x1b[1;7m"+doldur(" "+ad, w)+"\x1b[0m")
			continue
		}
		if sag != "" {
			ad = ui.Kalin(ad)
		}
		s = append(s, " "+iki(ad, sag, w-2))
	}
	s = append(s, "")
	baslik("SESLİ")
	for _, k := range u.kanallar {
		if k.Tur != "ses" {
			continue
		}
		ad := "♪ " + k.Ad
		sag := ""
		if len(k.Kisiler) > 0 {
			sag = ui.Soluk(fmt.Sprintf("%d", len(k.Kisiler)))
		}
		if k.ID == u.sesKanal {
			ad = ui.Yesil(ui.Kalin(ad))
		}
		s = append(s, " "+iki(ad, sag, w-2))
		for _, p := range k.Kisiler {
			s = append(s, "   "+iki(e.kisiAdi(k.ID, p), ui.Soluk(kisiBayraklari(p)), w-4))
		}
	}
	s = append(s, "")
	baslik(fmt.Sprintf("ÇEVRİMİÇİ · %d", len(u.kimler)))
	adlar := make([]string, 0, len(u.kimler))
	for _, k := range u.kimler {
		adlar = append(adlar, k.Ad)
	}
	sort.Slice(adlar, func(i, j int) bool { return trKucuk(adlar[i]) < trKucuk(adlar[j]) })
	for _, ad := range adlar {
		s = append(s, "  "+ui.Ad(ad))
	}
	if len(s) > h {
		s = append(s[:h-1], " "+ui.Soluk("…"))
	}
	for len(s) < h {
		s = append(s, "")
	}
	for i := range s {
		s[i] = doldur(s[i], w)
	}
	return s
}

// kisiAdi: sesli kanaldaki kişi; konuşuyorsa yeşil (yalnızca kendi kanalında bilinir).
func (e *TamEkran) kisiAdi(kanal string, p SesKisi) string {
	u := e.u
	if kanal == u.sesKanal {
		konusuyor := false
		if p.Ad == u.ben {
			konusuyor = !u.mikSessizMi() && u.motor.MikDurumu().Konusuyor
		} else if es := u.esler[p.Ad]; es != nil && es.mikKaynak != nil {
			konusuyor = es.mikKaynak.Ses.Durum().Konusuyor
		}
		if konusuyor {
			return u.ui.Yesil(u.ui.Kalin("● " + p.Ad))
		}
	}
	return u.ui.Soluk("○ ") + u.ui.Ad(p.Ad)
}

func kisiBayraklari(p SesKisi) string {
	var b []string
	switch {
	case p.Askida:
		b = append(b, "koptu")
	case p.Sagir:
		b = append(b, "sağır")
	case p.Sessiz:
		b = append(b, "sessiz")
	}
	if p.Yayin != nil {
		if p.Yayin.Goruntu {
			b = append(b, "ekran")
		} else {
			b = append(b, "ses")
		}
	}
	return strings.Join(b, " ")
}

// sohbet: açık kanalın mesajları: alttan yukarı, kaydırma kadar yukarıdan; h satır.
func (e *TamEkran) sohbet(w, h int) []string {
	u := e.u
	ui := u.ui
	gorunen := make([]string, h)
	orta := func(s string) []string {
		gorunen[h/2] = strings.Repeat(" ", max(0, (w-gorunur(s))/2)) + s
		return gorunen
	}
	switch {
	case u.bekleyenIstek:
		return orta(ui.Sari("İçeridekilere soruldu; izin bekleniyor…") + ui.Soluk(" (vazgeçmek: komut konsolunda iptal)"))
	case !u.oturumVardi && u.durduruldu:
		return orta(ui.Soluk("Bağlı değil · yeniden bağlanmak için komut konsolunda: bağlan"))
	case !u.oturumVardi:
		return orta(ui.Soluk("bağlanıyor…"))
	case u.aktifKanal == "":
		return orta(ui.Soluk("Yazılı kanal yok (komut: kanal ekle yazı <ad>)"))
	case len(u.mesajlar) == 0 && u.gecmisIstegi == u.aktifKanal:
		return orta(ui.Soluk("yükleniyor…"))
	case len(u.mesajlar) == 0:
		return orta(ui.Soluk("Henüz mesaj yok. İlk mesajı sen yaz."))
	}
	// Alttan yukarı: gereken kadar mesaj satıra çevrilir (ters sırada).
	gerek := h + e.kaydirma
	var ters []string
	ms := u.mesajlar
	i := len(ms) - 1
	for ; i >= 0 && len(ters) < gerek; i-- {
		satirlar := sar(u.mesajSatiri(ms[i]), w, 6)
		for j := len(satirlar) - 1; j >= 0; j-- {
			ters = append(ters, satirlar[j])
		}
		if i == 0 || gunEtiketi(ms[i-1].Zaman) != gunEtiketi(ms[i].Zaman) {
			ters = append(ters, gunAyraci(ui, gunEtiketi(ms[i].Zaman), w))
		}
	}
	if i < 0 {
		// Yüklenen mesajların başı göründü.
		if u.gecmisBitti {
			ters = append(ters, ui.Soluk(kes("── #"+u.kanalAdi(u.aktifKanal)+" kanalının başı ──", w)))
		} else {
			ters = append(ters, ui.Soluk("daha eski mesajlar yükleniyor…"))
			if e.kaydirma+h >= len(ters) && u.gecmisIstegi == "" && u.bagli {
				u.eskiIste()
			}
		}
		e.kaydirma = min(e.kaydirma, max(0, len(ters)-h))
	}
	if e.kaydirma == 0 {
		e.yeniAltta = 0
	}
	for r := 0; r < h; r++ {
		if k := e.kaydirma + (h - 1 - r); k < len(ters) {
			gorunen[r] = ters[k]
		}
	}
	return gorunen
}

func gunAyraci(ui *Arayuz, gun string, w int) string {
	ic := " " + gun + " "
	sol := max(2, (w-gorunur(ic))/2)
	sag := max(2, w-sol-gorunur(ic))
	return ui.Soluk(strings.Repeat("─", sol) + ic + strings.Repeat("─", sag))
}

// bilgiSatiri: bildirim, geçmişte olduğun, yazanlar ya da tuş ipuçları.
func (e *TamEkran) bilgiSatiri() string {
	u := e.u
	ui := u.ui
	simdi := time.Now()
	switch {
	case e.bildirim != "" && simdi.Sub(e.bildirimZaman) < 6*time.Second:
		if e.bildirimHata {
			return " " + ui.Kirmizi("! "+e.bildirim)
		}
		return " " + ui.Soluk("· ") + e.bildirim
	case e.kaydirma > 0:
		s := " " + ui.Soluk("↑ geçmişe bakıyorsun")
		if e.yeniAltta > 0 {
			s += ui.Sari(fmt.Sprintf(" · %d yeni mesaj", e.yeniAltta))
		}
		return s + ui.Soluk(" · Esc: en alta")
	}
	if y := u.yazanlar(); y != "" {
		return " " + ui.Soluk(y)
	}
	return " " + ui.Soluk(bolmeGecisi()+" komutlar · Alt+↑↓ kanal · PgUp/PgDn kaydır · Alt+M mik · Alt+D sağır · Ctrl+C kapat")
}

// bolmeGecisi: sohbet ile komut bölmesi arasında geçiş tuşu (Diszort'un tmux'unda Alt+←/→).
func bolmeGecisi() string {
	if os.Getenv("DISZORT_TMUX") == "kullanici" {
		return "Ctrl+B →"
	}
	return "Alt+→"
}

// girdiSatiri: istem + yazılan (imleç görünsün diye yatay kayar). Dönüş: satır ve imlecin sütunu.
func (e *TamEkran) girdiSatiri(g int) (string, int) {
	u := e.u
	ui := u.ui
	istem := " "
	switch {
	case e.soru != nil:
		istem += ui.Sari(e.soru.metin) + " "
	case u.bekleyenIstek:
		istem += ui.Sari("[izin bekleniyor]") + " "
	case !u.oturumVardi:
		istem += ui.Soluk("[bağlanıyor…]") + " "
	}
	if e.soru == nil && u.aktifKanal != "" {
		istem += ui.Kalin("#"+u.kanalAdi(u.aktifKanal)) + " › "
	}
	if gorunur(istem) > g/2 {
		istem = kes(istem, g/2) + " "
	}
	pw := gorunur(istem)
	alan := max(5, g-pw-1)
	if e.imlec < e.kaydir {
		e.kaydir = e.imlec
	}
	for {
		w := 0
		for _, r := range e.girdi[e.kaydir:e.imlec] {
			w += runeGenislik(r)
		}
		if w < alan || e.kaydir >= e.imlec {
			break
		}
		e.kaydir++
	}
	var b strings.Builder
	b.WriteString(istem)
	w, imlecW := 0, -1
	for i := e.kaydir; i < len(e.girdi); i++ {
		r := e.girdi[i]
		rw := runeGenislik(r)
		if w+rw > alan {
			break
		}
		if i == e.imlec {
			imlecW = w
		}
		switch {
		case r == '\n':
			b.WriteString(ui.Soluk("↵"))
		case r < 32:
			b.WriteString("^" + string(r+64))
		default:
			b.WriteRune(r)
		}
		w += rw
	}
	if imlecW < 0 {
		imlecW = w
	}
	return b.String(), pw + imlecW
}

// ---------------------------------------------------------------- olaylar (uygulamadan)

// bildir: bilgi satırında birkaç saniye (komut konsoluna ayrıca yazılır).
func (e *TamEkran) bildir(metin string, hata bool) {
	e.bildirim, e.bildirimHata, e.bildirimZaman = metin, hata, time.Now()
}

// kanalDegisti: başka bir kanala geçildi.
func (e *TamEkran) kanalDegisti() {
	e.kaydirma, e.yeniAltta = 0, 0
	e.komutUyarisi = ""
}

// mesajEklendi: açık kanala mesaj geldi: yukarıdayken görünen yer kaymasın.
func (e *TamEkran) mesajEklendi(m Mesaj, oncekiGun string) {
	if e.kaydirma == 0 {
		return
	}
	n := len(sar(e.u.mesajSatiri(m), max(10, e.sohbetG), 6))
	if gunEtiketi(m.Zaman) != oncekiGun {
		n++
	}
	e.kaydirma += n
	e.yeniAltta++
}

// Sor: yazma satırında soru (ad sorusu ya da evet/hayır). Esc: vazgeç.
func (e *TamEkran) Sor(metin string, evetHayir bool, cevap func(string)) {
	e.soru = &ekranSorusu{metin: metin, evetHayir: evetHayir, cevap: cevap}
	e.girdi, e.imlec, e.kaydir = nil, 0, 0
}

// ---------------------------------------------------------------- tuşlar

func (e *TamEkran) harf(r rune) {
	e.girdi, e.imlec = ekle(e.girdi, e.imlec, []rune{r})
	e.yaziyor()
}

func (e *TamEkran) yaziyor() {
	if e.soru == nil {
		e.u.girdiDegisti(string(e.girdi))
	}
}

func (e *TamEkran) yapistir(s string) {
	s = strings.TrimRight(s, "\n")
	u := e.u
	// Terminale dosya sürüklendi (yalnızca var olan dosyaların yolları): paylaşılsın mı?
	if e.soru == nil && len(e.girdi) == 0 && u.oturumVardi && u.aktifKanal != "" {
		if yollar := yollariAyir(s); len(yollar) > 0 && hepsiDosyaMi(yollar) {
			ne := fmt.Sprintf("%d dosya", len(yollar))
			if len(yollar) == 1 {
				ne = kisalt(yolAc(yollar[0])[strings.LastIndex(yolAc(yollar[0]), "/")+1:], 40)
			}
			e.Sor(fmt.Sprintf("%s #%s kanalında paylaşılsın mı? (Enter: evet · Esc: hayır)", ne, u.kanalAdi(u.aktifKanal)), true, func(c string) {
				if evetMi(c) {
					u.dosyalariPaylas(yollar)
				} else {
					e.girdi, e.imlec = []rune(s), len([]rune(s))
				}
			})
			return
		}
	}
	e.girdi, e.imlec = ekle(e.girdi, e.imlec, []rune(s))
	e.yaziyor()
}

func (e *TamEkran) gonder() {
	u := e.u
	s := string(e.girdi)
	if so := e.soru; so != nil {
		e.soru = nil
		e.girdi, e.imlec, e.kaydir = nil, 0, 0
		if so.evetHayir {
			so.cevap("e")
		} else {
			so.cevap(s)
		}
		return
	}
	if strings.TrimSpace(s) == "" {
		return
	}
	// "/kanallar" gibi bir komut: yanlışlıkla herkese gitmesin (yeniden Enter: yine de gönder).
	if strings.HasPrefix(s, "/") && e.komutUyarisi != s {
		ad, _, _ := strings.Cut(strings.TrimSpace(s[1:]), " ")
		if komutBul(ad) != nil {
			e.komutUyarisi = s
			e.bildir("Bu bir komut; sağdaki komut bölmesine yaz ("+bolmeGecisi()+"). Mesaj olarak göndermek için yeniden Enter.", false)
			return
		}
	}
	e.komutUyarisi = ""
	e.girdi, e.imlec, e.kaydir = nil, 0, 0
	e.kaydirma = 0
	u.sohbetMesaji(s)
}

// kanalaGec: yazılı kanallar arasında (fark: -1 önceki, +1 sonraki) ya da sırayla no (1'den).
func (e *TamEkran) kanalaGec(fark, no int) {
	u := e.u
	var idler []string
	simdi := -1
	for _, k := range u.kanallar {
		if k.Tur == "yazi" {
			if k.ID == u.aktifKanal {
				simdi = len(idler)
			}
			idler = append(idler, k.ID)
		}
	}
	if len(idler) == 0 {
		return
	}
	hedef := 0
	switch {
	case no > 0:
		if no > len(idler) {
			return
		}
		hedef = no - 1
	case simdi < 0:
		hedef = 0
	default:
		hedef = (simdi + fark + len(idler)) % len(idler)
	}
	if idler[hedef] != u.aktifKanal {
		u.kanalSec(idler[hedef])
	}
}

func (e *TamEkran) kaydirmaYap(n int) {
	e.kaydirma = max(0, e.kaydirma+n)
}

func (e *TamEkran) tus(ad string) {
	u := e.u
	sayfa := max(1, e.yuk-6)
	switch ad {
	case "enter":
		e.gonder()
	case "esc":
		switch {
		case e.soru != nil:
			so := e.soru
			e.soru = nil
			so.cevap("")
		case e.kaydirma > 0:
			e.kaydirma = 0
		}
	case "ctrl+c":
		// Hepsi kapanır: program, komut bölmesi, tmux.
		u.bitir(nil)
	case "ctrl+d":
		e.girdi, e.imlec, _ = duzenle(e.girdi, e.imlec, "sil")
	case "alt+m", "alt+d":
		u.tusGeldi(ad)
	case "yukari":
		e.kaydirmaYap(1)
	case "asagi":
		e.kaydirmaYap(-1)
	case "sayfa-yukari", "shift+yukari":
		e.kaydirmaYap(sayfa)
	case "sayfa-asagi", "shift+asagi":
		e.kaydirmaYap(-sayfa)
	case "ctrl+bas":
		e.kaydirmaYap(1 << 20)
	case "ctrl+son":
		e.kaydirma = 0
	case "alt+yukari", "ctrl+yukari", "shift+tab":
		e.kanalaGec(-1, 0)
	case "alt+asagi", "ctrl+asagi":
		e.kanalaGec(1, 0)
	case "alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9":
		e.kanalaGec(0, int(ad[4]-'0'))
	case "tab":
		e.adTamamla()
	case "ctrl+l":
		e.tamCiz = true
	default:
		var ok bool
		if e.girdi, e.imlec, ok = duzenle(e.girdi, e.imlec, ad); ok {
			e.yaziyor()
		}
	}
}

// adTamamla: imleçten önceki sözcük @ ile başlıyorsa kişi adını tamamla.
func (e *TamEkran) adTamamla() {
	if e.soru != nil {
		return
	}
	bas := e.imlec
	for bas > 0 && e.girdi[bas-1] != ' ' && e.girdi[bas-1] != '\n' {
		bas--
	}
	soz := string(e.girdi[bas:e.imlec])
	if !strings.HasPrefix(soz, "@") {
		return
	}
	var adaylar []string
	for _, ad := range e.u.bilinenAdlar() {
		if strings.HasPrefix(sadelestir(ad), sadelestir(soz[1:])) {
			adaylar = append(adaylar, ad)
		}
	}
	switch len(adaylar) {
	case 0:
		return
	case 1:
		yeni := []rune("@" + adaylar[0] + " ")
		e.girdi = append(append(append([]rune(nil), e.girdi[:bas]...), yeni...), e.girdi[e.imlec:]...)
		e.imlec = bas + len(yeni)
	default:
		if o := ortakBas(adaylar); len([]rune(o)) > len([]rune(soz))-1 {
			yeni := []rune("@" + o)
			e.girdi = append(append(append([]rune(nil), e.girdi[:bas]...), yeni...), e.girdi[e.imlec:]...)
			e.imlec = bas + len(yeni)
		}
		e.bildir(strings.Join(adaylar, "  "), false)
	}
}
