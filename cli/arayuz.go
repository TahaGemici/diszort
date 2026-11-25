package main

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"

	"github.com/mattn/go-runewidth"
	"golang.org/x/term"
)

// Terminal arayüzü: tek bir giriş satırı, iletiler onun üstüne akar (terminalin kendi kaydırması
// geçmişi tutar). Fare yok. Terminal değilse (betik/deneme) satır satır okur ve düz yazar.

func terminalMi() bool {
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

// satirOku: ham kipten önce (ilk açılış sorusu) düz bir satır.
func satirOku(istem string) (string, error) {
	fmt.Print(istem)
	s := bufio.NewScanner(os.Stdin)
	if !s.Scan() {
		return "", fmt.Errorf("girdi kapandı")
	}
	return strings.TrimSpace(s.Text()), nil
}

type soru struct {
	metin string
	cevap func(string)
	gizli bool
}

type Arayuz struct {
	mu        sync.Mutex
	betik     bool
	renk      bool
	tamRenk   bool
	girdi     []rune
	imlec     int
	kaydir    int
	gecmis    []string
	gecmisI   int
	taslak    []rune
	genislik  int
	istem     string
	soru      *soru
	eskiDurum *term.State
	bitti     bool

	// konsol: yazılanların komut konsollarına (tmux'un sağ bölmesi) giden kopyası (ana programda).
	konsol konsolBag
	// uzak: bu terminalde satır arayüzü yok (tam ekran sohbet açık): çıktı yalnızca konsollara gider.
	uzak bool
	// HemenCik: Ctrl+C satırda yazı ya da soru olsa da hemen Tus("ctrl+c") (komut bölmesi: hepsi kapanır).
	HemenCik bool

	// Satir: Enter (arayüz goroutine'inden).
	Satir func(string)
	// KonsolSatir: komut konsolundan gelen satır.
	KonsolSatir func(string)
	// Tus: özel tuşlar ("alt+m", "alt+d", "ctrl+c", "ctrl+d", "eof").
	Tus func(string)
	// Tamamla: Tab. Dönüş: yeni girdi (imleç sonda) ve gösterilecek seçenekler.
	Tamamla func(girdi string) (string, []string)
	// Degisti: girdi değişti (yazıyor göstergesi için).
	Degisti func(girdi string)
}

// konsolBag: komut konsollarına giden yol (konsol.go).
type konsolBag interface {
	yaz(metin string)
	istem(s string)
	sor(metin string, gizli bool)
	sorBitti()
}

func yeniArayuz(betik bool) *Arayuz {
	a := &Arayuz{betik: betik, genislik: 80}
	if !betik {
		a.renk = os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
		ct := strings.ToLower(os.Getenv("COLORTERM"))
		a.tamRenk = ct == "truecolor" || ct == "24bit"
	}
	return a
}

// Baslat: ham kipe geç ve tuşları okumaya başla.
func (a *Arayuz) Baslat() error {
	if a.uzak {
		return nil
	}
	if a.betik {
		go a.betikOku()
		return nil
	}
	durum, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		return err
	}
	a.eskiDurum = durum
	a.boyutAl()
	// Yapıştırılan metin tek parça gelsin (bracketed paste).
	os.Stdout.WriteString("\x1b[?2004h")
	isaret := make(chan os.Signal, 4)
	signal.Notify(isaret, syscall.SIGWINCH)
	go func() {
		for range isaret {
			a.mu.Lock()
			a.boyutAl()
			a.ciz()
			a.mu.Unlock()
		}
	}()
	go tuslariOku(os.Stdin, tusAlici{
		Tus:      a.tus,
		Harf:     a.harf,
		Yapistir: a.yapistirildi,
		Bitti: func() {
			if a.Tus != nil {
				a.Tus("eof")
			}
		},
	})
	a.mu.Lock()
	a.ciz()
	a.mu.Unlock()
	return nil
}

func (a *Arayuz) boyutAl() {
	if g, _, err := term.GetSize(int(os.Stdout.Fd())); err == nil && g > 10 {
		a.genislik = g
	}
}

// Bitir: terminali eski haline getir.
func (a *Arayuz) Bitir() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.bitti {
		return
	}
	a.bitti = true
	if a.eskiDurum != nil {
		os.Stdout.WriteString("\r\x1b[K\x1b[?2004l")
		term.Restore(int(os.Stdin.Fd()), a.eskiDurum)
	}
}

// ---------------------------------------------------------------- çıktı

// Yaz: giriş satırının üstüne bir (ya da birkaç) satır; komut konsollarına da.
func (a *Arayuz) Yaz(metin string) {
	if a.konsol != nil {
		a.konsol.yaz(metin)
	}
	if !a.uzak {
		a.yerelYaz(metin)
	}
}

// yerelYaz: yalnızca bu terminale (ör. Tab'ın seçenekleri).
func (a *Arayuz) yerelYaz(metin string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.betik {
		fmt.Println(renksiz(metin))
		return
	}
	if a.bitti {
		fmt.Println(metin)
		return
	}
	var b strings.Builder
	b.WriteString("\r\x1b[K")
	b.WriteString(strings.ReplaceAll(strings.TrimRight(metin, "\n"), "\n", "\r\n\x1b[K"))
	b.WriteString("\r\n")
	os.Stdout.WriteString(b.String())
	a.ciz()
}

// Zil: terminal zili (adın geçince, kapı çalınınca).
func (a *Arayuz) Zil() {
	if !a.betik && !a.uzak {
		a.mu.Lock()
		os.Stdout.WriteString("\a")
		a.mu.Unlock()
	}
}

// Istem: giriş satırının başı (durum + kanal).
func (a *Arayuz) Istem(s string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.istem == s {
		return
	}
	a.istem = s
	if a.konsol != nil {
		a.konsol.istem(s)
	}
	a.ciz()
}

// Sor: bir sonraki satır bu soruya cevaptır (ör. onay); komut konsolundan da cevaplanabilir.
func (a *Arayuz) Sor(metin string, gizli bool, cevap func(string)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.soru = &soru{metin: metin, cevap: cevap, gizli: gizli}
	if a.betik && !a.uzak {
		fmt.Println(renksiz(metin))
	}
	if a.konsol != nil {
		a.konsol.sor(metin, gizli)
	}
	a.ciz()
}

var ansiKalibi = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07`)

func renksiz(s string) string { return ansiKalibi.ReplaceAllString(s, "") }

func gorunenGenislik(s string) int { return runewidth.StringWidth(renksiz(s)) }

func runeGenislik(r rune) int {
	switch {
	case r == '\n':
		return 1
	case r < 32:
		return 2
	}
	return runewidth.RuneWidth(r)
}

// ciz: giriş satırını yeniden çiz (kilit altında).
func (a *Arayuz) ciz() {
	if a.betik || a.bitti || a.uzak {
		return
	}
	istem := a.istem
	if a.soru != nil {
		istem = a.soru.metin
	}
	pw := gorunenGenislik(istem)
	if pw > a.genislik-10 {
		// Çok uzun istem: kırp.
		istem = renksiz(istem)
		for gorunenGenislik(istem) > a.genislik-12 {
			_, n := utf8.DecodeLastRuneInString(istem)
			istem = istem[:len(istem)-n]
		}
		istem += "… "
		pw = gorunenGenislik(istem)
	}
	alan := max(5, a.genislik-pw-1)
	girdi := a.girdi
	gizli := a.soru != nil && a.soru.gizli
	// Kaydırma: imleç görünsün.
	if a.imlec < a.kaydir {
		a.kaydir = a.imlec
	}
	for {
		w := 0
		for _, r := range girdi[a.kaydir:a.imlec] {
			w += runeGenislik(r)
		}
		if w < alan || a.kaydir >= a.imlec {
			break
		}
		a.kaydir++
	}
	var b strings.Builder
	b.WriteString("\r\x1b[K")
	b.WriteString(istem)
	w, imlecW := 0, 0
	for i := a.kaydir; i < len(girdi); i++ {
		r := girdi[i]
		rw := runeGenislik(r)
		if w+rw > alan {
			break
		}
		if i == a.imlec {
			imlecW = w
		}
		switch {
		case gizli:
			b.WriteRune('•')
		case r == '\n':
			b.WriteString("\x1b[2m↵\x1b[22m")
		case r < 32:
			b.WriteString("^" + string(rune(r+64)))
		default:
			b.WriteRune(r)
		}
		w += rw
	}
	if a.imlec >= len(girdi) || a.imlec < a.kaydir {
		imlecW = w
		if a.imlec < a.kaydir {
			imlecW = 0
		}
	}
	b.WriteString("\r")
	if pw+imlecW > 0 {
		fmt.Fprintf(&b, "\x1b[%dC", pw+imlecW)
	}
	os.Stdout.WriteString(b.String())
}

// ---------------------------------------------------------------- renkler

// adRengi: web'deki renkBul ile aynı ton (hsl(ton 70% 74%)).
func adTonu(ad string) int {
	h := 0
	for _, r := range ad {
		h = (h*31 + int(r)) % 360
	}
	return int(math.Round(25 + float64(h)*0.85))
}

func hslRgb(h, s, l float64) (int, int, int) {
	c := (1 - math.Abs(2*l-1)) * s
	x := c * (1 - math.Abs(math.Mod(h/60, 2)-1))
	m := l - c/2
	var r, g, b float64
	switch {
	case h < 60:
		r, g, b = c, x, 0
	case h < 120:
		r, g, b = x, c, 0
	case h < 180:
		r, g, b = 0, c, x
	case h < 240:
		r, g, b = 0, x, c
	case h < 300:
		r, g, b = x, 0, c
	default:
		r, g, b = c, 0, x
	}
	return int((r + m) * 255), int((g + m) * 255), int((b + m) * 255)
}

func (a *Arayuz) renkKodu(r, g, b int) string {
	if a.tamRenk {
		return fmt.Sprintf("\x1b[38;2;%d;%d;%dm", r, g, b)
	}
	k := func(v int) int { return int(math.Round(float64(v) / 255 * 5)) }
	return fmt.Sprintf("\x1b[38;5;%dm", 16+36*k(r)+6*k(g)+k(b))
}

func (a *Arayuz) Ad(ad string) string {
	if !a.renk {
		return ad
	}
	r, g, b := hslRgb(float64(adTonu(ad)), 0.7, 0.74)
	return a.renkKodu(r, g, b) + "\x1b[1m" + ad + "\x1b[0m"
}

func (a *Arayuz) sar(kod, s string) string {
	if !a.renk {
		return s
	}
	return kod + s + "\x1b[0m"
}

func (a *Arayuz) Soluk(s string) string   { return a.sar("\x1b[2m", s) }
func (a *Arayuz) Kalin(s string) string   { return a.sar("\x1b[1m", s) }
func (a *Arayuz) Kirmizi(s string) string { return a.sar("\x1b[31m", s) }
func (a *Arayuz) Yesil(s string) string   { return a.sar("\x1b[32m", s) }
func (a *Arayuz) Sari(s string) string    { return a.sar("\x1b[33m", s) }
func (a *Arayuz) Mavi(s string) string    { return a.sar("\x1b[36m", s) }
func (a *Arayuz) Vurgu(s string) string   { return a.sar("\x1b[1;43;30m", s) }
func (a *Arayuz) Baglanti(s string) string {
	if !a.renk {
		return s
	}
	return "\x1b]8;;" + s + "\x07\x1b[4;36m" + s + "\x1b[0m\x1b]8;;\x07"
}

// ---------------------------------------------------------------- girdi

func (a *Arayuz) betikOku() {
	s := bufio.NewScanner(os.Stdin)
	s.Buffer(make([]byte, 64*1024), 1<<20)
	for s.Scan() {
		satir := s.Text()
		if so := a.soruyuAl(); so != nil {
			so.cevap(satir)
		} else if a.Satir != nil {
			a.Satir(satir)
		}
	}
	if a.Tus != nil {
		a.Tus("eof")
	}
}

// soruyuAl: bekleyen soruyu al (cevabı çağıran verir); komut konsoluna da sorunun bittiği söylenir.
func (a *Arayuz) soruyuAl() *soru {
	a.mu.Lock()
	so := a.soru
	a.soru = nil
	if so != nil {
		a.ciz()
	}
	a.mu.Unlock()
	if so != nil && a.konsol != nil {
		a.konsol.sorBitti()
	}
	return so
}

// UzakSatir: komut konsolundan gelen satır: bekleyen soru varsa onun cevabı, yoksa KonsolSatir.
func (a *Arayuz) UzakSatir(s string) {
	if so := a.soruyuAl(); so != nil {
		so.cevap(s)
		return
	}
	if a.KonsolSatir != nil {
		a.KonsolSatir(s)
	}
}

// SoruBitir: bekleyen soruyu cevaplamadan kaldır (komut konsolunda: soru başka yerde cevaplandı).
func (a *Arayuz) SoruBitir() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.soru != nil {
		a.soru = nil
		a.ciz()
	}
}

func (a *Arayuz) yapistirildi(s string) {
	a.mu.Lock()
	a.girdi, a.imlec = ekle(a.girdi, a.imlec, []rune(strings.TrimRight(s, "\n")))
	a.ciz()
	g := string(a.girdi)
	a.mu.Unlock()
	if a.Degisti != nil {
		a.Degisti(g)
	}
}

func (a *Arayuz) harf(r rune) {
	a.mu.Lock()
	a.girdi, a.imlec = ekle(a.girdi, a.imlec, []rune{r})
	a.ciz()
	g := string(a.girdi)
	a.mu.Unlock()
	if a.Degisti != nil {
		a.Degisti(g)
	}
}

func (a *Arayuz) gonder() {
	a.mu.Lock()
	satir := string(a.girdi)
	if a.soru == nil && strings.TrimSpace(satir) != "" && (len(a.gecmis) == 0 || a.gecmis[len(a.gecmis)-1] != satir) {
		a.gecmis = append(a.gecmis, satir)
		if len(a.gecmis) > 200 {
			a.gecmis = a.gecmis[len(a.gecmis)-200:]
		}
	}
	a.gecmisI = len(a.gecmis)
	a.girdi, a.imlec, a.kaydir, a.taslak = nil, 0, 0, nil
	a.ciz()
	a.mu.Unlock()
	if so := a.soruyuAl(); so != nil {
		so.cevap(satir)
	} else if a.Satir != nil {
		a.Satir(satir)
	}
}

func (a *Arayuz) tus(ad string) {
	switch ad {
	case "enter":
		a.gonder()
		return
	case "alt+m", "alt+d", "ctrl+c", "ctrl+d", "esc":
		if ad == "ctrl+c" && a.HemenCik {
			if a.Tus != nil {
				a.Tus(ad)
			}
			return
		}
		if ad == "ctrl+c" || ad == "esc" {
			a.mu.Lock()
			bos := len(a.girdi) == 0 && a.soru == nil
			a.girdi, a.imlec, a.kaydir = nil, 0, 0
			a.ciz()
			a.mu.Unlock()
			if so := a.soruyuAl(); so != nil {
				so.cevap("")
				return
			}
			if !bos || ad == "esc" {
				return
			}
		}
		if ad == "ctrl+d" {
			a.mu.Lock()
			bos := len(a.girdi) == 0
			a.mu.Unlock()
			if !bos {
				a.tus("sil")
				return
			}
		}
		if a.Tus != nil {
			a.Tus(ad)
		}
		return
	case "tab":
		if a.Tamamla == nil {
			return
		}
		a.mu.Lock()
		if a.soru != nil {
			a.mu.Unlock()
			return
		}
		girdi := string(a.girdi[:a.imlec])
		kalan := string(a.girdi[a.imlec:])
		a.mu.Unlock()
		yeni, oneriler := a.Tamamla(girdi)
		if len(oneriler) > 1 {
			a.yerelYaz(a.Soluk(strings.Join(oneriler, "  ")))
		}
		a.mu.Lock()
		a.girdi = []rune(yeni + kalan)
		a.imlec = len([]rune(yeni))
		a.ciz()
		a.mu.Unlock()
		return
	case "ctrl+l":
		a.mu.Lock()
		os.Stdout.WriteString("\x1b[H\x1b[2J")
		a.ciz()
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	g := a.girdi
	switch ad {
	case "yukari":
		if a.soru != nil || a.gecmisI == 0 {
			return
		}
		if a.gecmisI == len(a.gecmis) {
			a.taslak = append([]rune(nil), g...)
		}
		a.gecmisI--
		a.girdi = []rune(a.gecmis[a.gecmisI])
		a.imlec = len(a.girdi)
	case "asagi":
		if a.soru != nil || a.gecmisI >= len(a.gecmis) {
			return
		}
		a.gecmisI++
		if a.gecmisI == len(a.gecmis) {
			a.girdi = a.taslak
		} else {
			a.girdi = []rune(a.gecmis[a.gecmisI])
		}
		a.imlec = len(a.girdi)
	default:
		var ok bool
		if a.girdi, a.imlec, ok = duzenle(g, a.imlec, ad); !ok {
			return
		}
	}
	a.ciz()
}
