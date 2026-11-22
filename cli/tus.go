package main

import (
	"io"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Tuş okuma: ham kipteki terminalden gelen baytları tuş adlarına, harflere ve yapıştırılan metne
// çevirir. Satır arayüzü, tam ekran sohbet ve komut konsolu bunu ortak kullanır.
//
// Tuş adları: enter, tab, shift+tab, esc, geri, sil, sol, sag, yukari, asagi, bas, son,
// sayfa-yukari, sayfa-asagi, sozcuk-sol, sozcuk-sag; değiştiricili olanlar alt+, ctrl+, shift+
// önekiyle (ör. alt+yukari, ctrl+son); Alt ile harf: alt+m, alt+1; denetim harfleri: ctrl+c,
// ctrl+d, ctrl+k, ctrl+l, ctrl+u, ctrl+w (Ctrl+A/E/B/F/P/N: bas/son/sol/sag/yukari/asagi).

type tusAlici struct {
	Tus      func(ad string)
	Harf     func(r rune) // yazılabilir harf
	Yapistir func(s string)
	Bitti    func() // girdi kapandı
}

// tuslariOku: r kapanana kadar okur (kendi goroutine'inde çağrılır).
func tuslariOku(r io.Reader, a tusAlici) {
	gelen := make(chan []byte, 16)
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
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
	bitti := func() {
		if a.Bitti != nil {
			a.Bitti()
		}
	}
	for {
		// Döngü başında tampon ya boştur ya da yarım bir şey tutar (kaçış dizisi ya da UTF-8 harf).
		if !yapistir && len(tampon) > 0 && tampon[0] == 0x1b && !tamamMi(tampon) {
			// Yarım kaçış dizisi: kısa bir süre devamını bekle (gelmezse tek başına Esc).
			select {
			case d, ok := <-gelen:
				if !ok {
					bitti()
					return
				}
				tampon = append(tampon, d...)
			case <-time.After(40 * time.Millisecond):
				a.Tus("esc")
				tampon = tampon[1:]
			}
		} else {
			d, ok := <-gelen
			if !ok {
				bitti()
				return
			}
			tampon = append(tampon, d...)
		}
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
				s := strings.ReplaceAll(strings.ReplaceAll(string(yapisan), "\r\n", "\n"), "\r", "\n")
				yapisan = nil
				if a.Yapistir != nil {
					a.Yapistir(s)
				}
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
				if ad != "" {
					a.Tus(ad)
				}
				continue
			}
			r, n := utf8.DecodeRune(tampon)
			if r == utf8.RuneError && n <= 1 && !utf8.FullRune(tampon) {
				break
			}
			tampon = tampon[n:]
			if ad := denetimAdi(r); ad != "" {
				a.Tus(ad)
			} else if r >= 32 && r != 0x7f && a.Harf != nil {
				a.Harf(r)
			}
		}
	}
}

// denetimAdi: denetim harfinin tuş adı ("" = yazılabilir harf ya da yok sayılan).
func denetimAdi(r rune) string {
	switch r {
	case '\r', '\n':
		return "enter"
	case 0x7f, 0x08:
		return "geri"
	case 0x09:
		return "tab"
	case 0x01:
		return "bas"
	case 0x05:
		return "son"
	case 0x02:
		return "sol"
	case 0x06:
		return "sag"
	case 0x10:
		return "yukari"
	case 0x0e:
		return "asagi"
	case 0x03, 0x04, 0x0b, 0x0c, 0x15, 0x17:
		return "ctrl+" + string(rune('a'+r-1))
	}
	return ""
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
	case 0x1b:
		// Esc + kaçış dizisi (bazı terminallerde Alt+ok): içteki dizi bütün mü.
		return len(b) >= 3 && (b[2] != '[' && b[2] != 'O' || tamamMi(b[1:]))
	}
	return true
}

// degistirici: CSI parametresindeki değiştirici (1;3A → "alt+").
func degistirici(govde string) string {
	_, m, ok := strings.Cut(govde, ";")
	if !ok {
		return ""
	}
	var on string
	switch m {
	case "2":
		on = "shift+"
	case "3":
		on = "alt+"
	case "4":
		on = "alt+shift+"
	case "5":
		on = "ctrl+"
	case "6":
		on = "ctrl+shift+"
	case "7", "8":
		on = "ctrl+alt+"
	}
	return on
}

// kacisCoz: bütün bir kaçış dizisini çöz. Dönüş: bayt sayısı ve tuş adı ("" = bilinmiyor).
func kacisCoz(b []byte) (int, string) {
	if b[1] == 0x1b && len(b) >= 3 && (b[2] == '[' || b[2] == 'O') {
		n, ad := kacisCoz(b[1:])
		if ad == "" || strings.HasPrefix(ad, "alt+") {
			return 1 + n, ad
		}
		return 1 + n, "alt+" + ad
	}
	if b[1] == '[' {
		i := 2
		for i < len(b) && !(b[i] >= 0x40 && b[i] <= 0x7e) {
			i++
		}
		govde := string(b[2:i])
		son := b[i]
		n := i + 1
		on := degistirici(govde)
		switch son {
		case 'A':
			return n, on + "yukari"
		case 'B':
			return n, on + "asagi"
		case 'C':
			if on == "alt+" || on == "ctrl+" {
				return n, "sozcuk-sag"
			}
			return n, on + "sag"
		case 'D':
			if on == "alt+" || on == "ctrl+" {
				return n, "sozcuk-sol"
			}
			return n, on + "sol"
		case 'H':
			return n, on + "bas"
		case 'F':
			return n, on + "son"
		case 'Z':
			return n, "shift+tab"
		case '~':
			ad, _, _ := strings.Cut(govde, ";")
			switch ad {
			case "1", "7":
				return n, on + "bas"
			case "4", "8":
				return n, on + "son"
			case "3":
				return n, on + "sil"
			case "5":
				return n, on + "sayfa-yukari"
			case "6":
				return n, on + "sayfa-asagi"
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
	case 0x1b:
		// Esc'nin ardından başka bir tuş: önce Esc.
		return 1, "esc"
	case '\r', '\n':
		return 1 + n, "alt+enter"
	case 0x7f, 0x08:
		return 1 + n, "alt+sil"
	}
	if r < 32 {
		return 1 + n, ""
	}
	return 1 + n, "alt+" + strings.ToLower(string(r))
}

func sozcukMu(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

// duzenle: giriş satırındaki düzenleme tuşları (imleç, silme, sözcük işleri). Dönüş: yeni satır,
// imleç ve tuşun bir düzenleme tuşu olup olmadığı.
func duzenle(g []rune, i int, ad string) ([]rune, int, bool) {
	switch ad {
	case "geri":
		if i > 0 {
			g = append(g[:i-1], g[i:]...)
			i--
		}
	case "sil":
		if i < len(g) {
			g = append(g[:i], g[i+1:]...)
		}
	case "sol":
		i = max(0, i-1)
	case "sag":
		i = min(len(g), i+1)
	case "bas":
		i = 0
	case "son":
		i = len(g)
	case "sozcuk-sol", "alt+b":
		for i > 0 && !sozcukMu(g[i-1]) {
			i--
		}
		for i > 0 && sozcukMu(g[i-1]) {
			i--
		}
	case "sozcuk-sag", "alt+f":
		for i < len(g) && !sozcukMu(g[i]) {
			i++
		}
		for i < len(g) && sozcukMu(g[i]) {
			i++
		}
	case "ctrl+k":
		g = g[:i]
	case "ctrl+u":
		g = append([]rune(nil), g[i:]...)
		i = 0
	case "ctrl+w", "alt+sil":
		j := i
		for j > 0 && !sozcukMu(g[j-1]) {
			j--
		}
		for j > 0 && sozcukMu(g[j-1]) {
			j--
		}
		g = append(g[:j], g[i:]...)
		i = j
	case "alt+enter":
		g = append(g[:i], append([]rune{'\n'}, g[i:]...)...)
		i++
	default:
		return g, i, false
	}
	return g, i, true
}

// ekle: imlecin yerine metin.
func ekle(g []rune, i int, rs []rune) ([]rune, int) {
	g = append(g[:i], append(append([]rune(nil), rs...), g[i:]...)...)
	return g, i + len(rs)
}
