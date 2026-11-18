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
	"time"
	"unicode"
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

	// Satir: Enter (arayüz goroutine'inden).
	Satir func(string)
	// Tus: özel tuşlar ("alt+m", "alt+d", "ctrl+c", "ctrl+d").
	Tus func(string)
	// Tamamla: Tab. Dönüş: yeni girdi (imleç sonda) ve gösterilecek seçenekler.
	Tamamla func(girdi string) (string, []string)
	// Degisti: girdi değişti (yazıyor göstergesi için).
	Degisti func(girdi string)
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
	go a.tusOku()
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

// Yaz: giriş satırının üstüne bir (ya da birkaç) satır.
func (a *Arayuz) Yaz(metin string) {
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
	if !a.betik {
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
	a.ciz()
}

// Sor: bir sonraki satır bu soruya cevaptır (ör. onay).
func (a *Arayuz) Sor(metin string, gizli bool, cevap func(string)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.soru = &soru{metin: metin, cevap: cevap, gizli: gizli}
	if a.betik {
		fmt.Println(renksiz(metin))
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
	if a.betik || a.bitti {
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
		a.mu.Lock()
		so := a.soru
		a.soru = nil
		a.mu.Unlock()
		if so != nil {
			so.cevap(satir)
		} else if a.Satir != nil {
			a.Satir(satir)
		}
	}
	if a.Tus != nil {
		a.Tus("eof")
	}
}

// tusOku: ham kipte baytları tuşlara çevir.
func (a *Arayuz) tusOku() {
	gelen := make(chan []byte, 16)
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := os.Stdin.Read(b)
			if n > 0 {
				gelen <- append([]byte(nil), b[:n]...)
			}
			if err != nil {
				close(gelen)
				return
			}
		}
	}()
	var tampon []byte
	yapistir := false
	var yapisan []byte
	for {
		var d []byte
		var ok bool
		if len(tampon) > 0 && tampon[0] == 0x1b && !tamamMi(tampon) {
			// Yarım kaçış dizisi: kısa bir süre devamını bekle (yoksa tek başına Esc).
			select {
			case d, ok = <-gelen:
			case <-time.After(40 * time.Millisecond):
				d, ok = nil, true
				a.tus("esc")
				tampon = tampon[1:]
				continue
			}
		} else if len(tampon) == 0 {
			d, ok = <-gelen
		}
		if !ok {
			if a.Tus != nil {
				a.Tus("eof")
			}
			return
		}
		tampon = append(tampon, d...)
		for len(tampon) > 0 {
			if yapistir {
				i := strings.Index(string(tampon), "\x1b[201~")
				if i < 0 {
					yapisan = append(yapisan, tampon...)
					tampon = nil
					break
				}
				yapisan = append(yapisan, tampon[:i]...)
				tampon = tampon[i+6:]
				yapistir = false
				a.yapistirildi(string(yapisan))
				yapisan = nil
				continue
			}
			if tampon[0] == 0x1b {
				if !tamamMi(tampon) {
					break
				}
				n, ad := kacisCoz(tampon)
				tampon = tampon[n:]
				if ad == "yapistir" {
					yapistir = true
					continue
				}
				a.tus(ad)
				continue
			}
			r, n := utf8.DecodeRune(tampon)
			if r == utf8.RuneError && n <= 1 && !utf8.FullRune(tampon) {
				break
			}
			tampon = tampon[n:]
			a.rune_(r)
		}
	}
}

// tamamMi: kaçış dizisi bütün mü.
func tamamMi(b []byte) bool {
	if len(b) < 2 {
		return false
	}
	switch b[1] {
	case '[':
		for i := 2; i < len(b); i++ {
			if b[i] >= 0x40 && b[i] <= 0x7e {
				return true
			}
		}
		return false
	case 'O':
		return len(b) >= 3
	}
	return true
}

func kacisCoz(b []byte) (int, string) {
	if b[1] == '[' {
		i := 2
		for i < len(b) && !(b[i] >= 0x40 && b[i] <= 0x7e) {
			i++
		}
		govde := string(b[2:i])
		son := b[i]
		n := i + 1
		switch {
		case son == 'A':
			return n, "yukari"
		case son == 'B':
			return n, "asagi"
		case son == 'C':
			if strings.Contains(govde, ";3") || strings.Contains(govde, ";5") {
				return n, "sozcuk-sag"
			}
			return n, "sag"
		case son == 'D':
			if strings.Contains(govde, ";3") || strings.Contains(govde, ";5") {
				return n, "sozcuk-sol"
			}
			return n, "sol"
		case son == 'H':
			return n, "bas"
		case son == 'F':
			return n, "son"
		case son == '~':
			switch govde {
			case "1", "7":
				return n, "bas"
			case "4", "8":
				return n, "son"
			case "3":
				return n, "sil"
			case "200":
				return n, "yapistir"
			}
		}
		return n, ""
	}
	if b[1] == 'O' {
		switch b[2] {
		case 'H':
			return 3, "bas"
		case 'F':
			return 3, "son"
		case 'A':
			return 3, "yukari"
		case 'B':
			return 3, "asagi"
		case 'C':
			return 3, "sag"
		case 'D':
			return 3, "sol"
		}
		return 3, ""
	}
	r, n := utf8.DecodeRune(b[1:])
	switch r {
	case '\r', '\n':
		return 1 + n, "alt+enter"
	case 0x7f, 0x08:
		return 1 + n, "alt+sil"
	}
	return 1 + n, "alt+" + strings.ToLower(string(r))
}

func (a *Arayuz) yapistirildi(s string) {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	a.mu.Lock()
	defer a.mu.Unlock()
	rs := []rune(strings.TrimRight(s, "\n"))
	a.girdi = append(a.girdi[:a.imlec], append(rs, a.girdi[a.imlec:]...)...)
	a.imlec += len(rs)
	a.ciz()
	if a.Degisti != nil {
		g := string(a.girdi)
		go a.Degisti(g)
	}
}

func (a *Arayuz) rune_(r rune) {
	switch r {
	case '\r', '\n':
		a.gonder()
		return
	case 0x7f, 0x08:
		a.tus("geri")
		return
	case 0x03:
		a.tus("ctrl+c")
		return
	case 0x04:
		a.tus("ctrl+d")
		return
	case 0x09:
		a.tus("tab")
		return
	case 0x01:
		a.tus("bas")
		return
	case 0x05:
		a.tus("son")
		return
	case 0x02:
		a.tus("sol")
		return
	case 0x06:
		a.tus("sag")
		return
	case 0x0b:
		a.tus("ctrl+k")
		return
	case 0x15:
		a.tus("ctrl+u")
		return
	case 0x17:
		a.tus("ctrl+w")
		return
	case 0x0c:
		a.tus("ctrl+l")
		return
	case 0x10:
		a.tus("yukari")
		return
	case 0x0e:
		a.tus("asagi")
		return
	}
	if r < 32 {
		return
	}
	a.mu.Lock()
	a.girdi = append(a.girdi[:a.imlec], append([]rune{r}, a.girdi[a.imlec:]...)...)
	a.imlec++
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
	so := a.soru
	a.soru = nil
	if so == nil && strings.TrimSpace(satir) != "" && (len(a.gecmis) == 0 || a.gecmis[len(a.gecmis)-1] != satir) {
		a.gecmis = append(a.gecmis, satir)
		if len(a.gecmis) > 200 {
			a.gecmis = a.gecmis[len(a.gecmis)-200:]
		}
	}
	a.gecmisI = len(a.gecmis)
	a.girdi, a.imlec, a.kaydir, a.taslak = nil, 0, 0, nil
	a.ciz()
	a.mu.Unlock()
	if so != nil {
		so.cevap(satir)
	} else if a.Satir != nil {
		a.Satir(satir)
	}
}

func sozcukMu(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

func (a *Arayuz) tus(ad string) {
	switch ad {
	case "alt+m", "alt+d", "ctrl+c", "ctrl+d", "esc":
		if ad == "ctrl+c" || ad == "esc" {
			a.mu.Lock()
			bos := len(a.girdi) == 0 && a.soru == nil
			so := a.soru
			a.soru = nil
			a.girdi, a.imlec, a.kaydir = nil, 0, 0
			a.ciz()
			a.mu.Unlock()
			if so != nil {
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
			a.Yaz(a.Soluk(strings.Join(oneriler, "  ")))
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
	case "geri":
		if a.imlec > 0 {
			a.girdi = append(g[:a.imlec-1], g[a.imlec:]...)
			a.imlec--
		}
	case "sil":
		if a.imlec < len(g) {
			a.girdi = append(g[:a.imlec], g[a.imlec+1:]...)
		}
	case "sol":
		a.imlec = max(0, a.imlec-1)
	case "sag":
		a.imlec = min(len(g), a.imlec+1)
	case "bas":
		a.imlec = 0
	case "son":
		a.imlec = len(g)
	case "sozcuk-sol", "alt+b":
		i := a.imlec
		for i > 0 && !sozcukMu(g[i-1]) {
			i--
		}
		for i > 0 && sozcukMu(g[i-1]) {
			i--
		}
		a.imlec = i
	case "sozcuk-sag", "alt+f":
		i := a.imlec
		for i < len(g) && !sozcukMu(g[i]) {
			i++
		}
		for i < len(g) && sozcukMu(g[i]) {
			i++
		}
		a.imlec = i
	case "ctrl+k":
		a.girdi = g[:a.imlec]
	case "ctrl+u":
		a.girdi = append([]rune(nil), g[a.imlec:]...)
		a.imlec = 0
	case "ctrl+w", "alt+sil":
		i := a.imlec
		for i > 0 && !sozcukMu(g[i-1]) {
			i--
		}
		for i > 0 && sozcukMu(g[i-1]) {
			i--
		}
		a.girdi = append(g[:i], g[a.imlec:]...)
		a.imlec = i
	case "alt+enter":
		a.girdi = append(g[:a.imlec], append([]rune{'\n'}, g[a.imlec:]...)...)
		a.imlec++
	case "yukari":
		if a.soru != nil || a.gecmisI == 0 {
			break
		}
		if a.gecmisI == len(a.gecmis) {
			a.taslak = append([]rune(nil), g...)
		}
		a.gecmisI--
		a.girdi = []rune(a.gecmis[a.gecmisI])
		a.imlec = len(a.girdi)
	case "asagi":
		if a.soru != nil || a.gecmisI >= len(a.gecmis) {
			break
		}
		a.gecmisI++
		if a.gecmisI == len(a.gecmis) {
			a.girdi = a.taslak
		} else {
			a.girdi = []rune(a.gecmis[a.gecmisI])
		}
		a.imlec = len(a.girdi)
	default:
		return
	}
	a.ciz()
}
