package main

import (
	"strings"

	"github.com/clipperhouse/uax29/v2/graphemes"
	"github.com/mattn/go-runewidth"
)

// Renkli (ANSI) metin: tam ekranda satırlara bölme, kırpma, hizalama. Genişlik harf kümesine
// (grapheme) göre ölçülür: Türkçe harfler 1, Çince/Japonca ve emojiler 2 sütun. Renk (SGR) dışındaki
// kaçış dizileri (ör. bağlantılar) ve denetim karakterleri atılır: ekranın düzeni bozulmasın.

// kume: SGR kaçışı (g < 0), satır sonu ("\n", g = 0) ya da bir harf kümesi (g = genişliği).
type kume struct {
	s string
	g int
}

func parcala(s string) []kume {
	var ps []kume
	for len(s) > 0 {
		if s[0] == 0x1b {
			n, sgr := kacisBoyu(s)
			if sgr {
				ps = append(ps, kume{s[:n], -1})
			}
			s = s[n:]
			continue
		}
		i := strings.IndexByte(s, 0x1b)
		if i < 0 {
			i = len(s)
		}
		k := graphemes.FromString(s[:i])
		for k.Next() {
			h := k.Value()
			switch {
			case h == "\n" || h == "\r\n":
				ps = append(ps, kume{"\n", 0})
			case h == "\t":
				ps = append(ps, kume{"    ", 4})
			case denetimMi(h):
			default:
				ps = append(ps, kume{h, runewidth.StringWidth(h)})
			}
		}
		s = s[i:]
	}
	return ps
}

// denetimMi: ekrana yazılmayacak tek karakter (C0, DEL, C1).
func denetimMi(h string) bool {
	r := []rune(h)
	if len(r) != 1 {
		return false
	}
	return r[0] < 0x20 || (r[0] >= 0x7f && r[0] < 0xa0)
}

// kacisBoyu: s[0] == ESC. Dönüş: dizinin bayt boyu ve renk (SGR) olup olmadığı.
func kacisBoyu(s string) (int, bool) {
	if len(s) < 2 {
		return len(s), false
	}
	switch s[1] {
	case '[':
		for i := 2; i < len(s); i++ {
			if s[i] >= 0x40 && s[i] <= 0x7e {
				return i + 1, s[i] == 'm'
			}
		}
		return len(s), false
	case ']':
		for i := 2; i < len(s); i++ {
			if s[i] == 0x07 {
				return i + 1, false
			}
			if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
				return i + 2, false
			}
		}
		return len(s), false
	}
	return 2, false
}

// sgrDurumu: bas'tan sonra ps'deki renk kaçışları işlenince geçerli olan renk (sıfırlamada boşalır).
func sgrDurumu(bas string, ps []kume) string {
	d := bas
	for _, p := range ps {
		if p.g < 0 {
			if p.s == "\x1b[0m" || p.s == "\x1b[m" {
				d = ""
			} else {
				d += p.s
			}
		}
	}
	return d
}

func genislik(ps []kume) int {
	g := 0
	for _, p := range ps {
		if p.g > 0 {
			g += p.g
		}
	}
	return g
}

// sar: renkli metni en çok w sütunluk satırlara böl (sözcük arasından; sözcük sığmıyorsa harften).
// İlk satırdan sonrakiler girinti kadar boşlukla başlar; renk satırdan satıra taşınır.
func sar(s string, w, girinti int) []string {
	if w < 2 {
		w = 2
	}
	if girinti > w/2 {
		girinti = 0
	}
	var satirlar []string
	durum := ""
	ilk := true
	var cur []kume
	curW := 0
	limit := func() int {
		if ilk {
			return w
		}
		return w - girinti
	}
	yaz := func(ps []kume) {
		var b strings.Builder
		if !ilk {
			b.WriteString(strings.Repeat(" ", girinti))
		}
		b.WriteString(durum)
		renkli := durum != ""
		for _, p := range ps {
			b.WriteString(p.s)
			if p.g < 0 {
				renkli = true
			}
		}
		if renkli {
			b.WriteString("\x1b[0m")
		}
		satirlar = append(satirlar, strings.TrimRight(b.String(), " "))
		durum = sgrDurumu(durum, ps)
		ilk = false
	}
	// tasir: satır sığmıyorsa böl (sözcük arasından ya da harften), sığana kadar.
	tasir := func() {
		for curW > limit() {
			// Sığan en uzun baş ve onun içindeki son boşluk.
			g, kes, bosluk := 0, 0, -1
			for i, p := range cur {
				if p.g > 0 && g+p.g > limit() {
					break
				}
				if p.g > 0 {
					g += p.g
				}
				kes = i + 1
				if p.s == " " && i > 0 {
					bosluk = i
				}
			}
			if bosluk > 0 {
				yaz(cur[:bosluk])
				durum = sgrDurumu(durum, cur[bosluk:bosluk+1])
				cur = append([]kume(nil), cur[bosluk+1:]...)
			} else {
				if kes == 0 {
					kes = 1 // tek harf bile sığmıyor (çok dar): yine de ilerle
				}
				yaz(cur[:kes])
				cur = append([]kume(nil), cur[kes:]...)
			}
			curW = genislik(cur)
		}
	}
	for _, p := range parcala(s) {
		if p.s == "\n" {
			yaz(cur)
			cur, curW = nil, 0
			continue
		}
		cur = append(cur, p)
		if p.g > 0 {
			curW += p.g
			if curW > limit() {
				tasir()
			}
		}
	}
	if len(cur) > 0 || len(satirlar) == 0 {
		yaz(cur)
	}
	return satirlar
}

// kes: renkli metni w sütuna kırp (sığmazsa sonuna …); satır sonları boşluk olur.
func kes(s string, w int) string {
	if w <= 0 {
		return ""
	}
	ps := parcala(s)
	toplam := 0
	for _, p := range ps {
		if p.g > 0 {
			toplam += p.g
		} else if p.s == "\n" {
			toplam++
		}
	}
	sinir := w
	if toplam > w {
		sinir = w - 1
	}
	var b strings.Builder
	g := 0
	renkli := false
	for _, p := range ps {
		if p.g < 0 {
			b.WriteString(p.s)
			renkli = true
			continue
		}
		h, hg := p.s, p.g
		if h == "\n" {
			h, hg = " ", 1
		}
		if g+hg > sinir {
			break
		}
		b.WriteString(h)
		g += hg
	}
	if toplam > w {
		b.WriteString("…")
	}
	if renkli {
		b.WriteString("\x1b[0m")
	}
	return b.String()
}

// gorunur: renkli metnin ekrandaki genişliği.
func gorunur(s string) int {
	g := 0
	for _, p := range parcala(s) {
		if p.g > 0 {
			g += p.g
		} else if p.s == "\n" {
			g++
		}
	}
	return g
}

// doldur: tam w sütun (kırp ya da sağına boşluk).
func doldur(s string, w int) string {
	s = kes(s, w)
	if n := w - gorunur(s); n > 0 {
		s += strings.Repeat(" ", n)
	}
	return s
}

// iki: sol ve sağ parça w sütunda (sağdaki sağa yaslı; sığmazsa sol kırpılır).
func iki(sol, sag string, w int) string {
	sg := gorunur(sag)
	if sg >= w {
		return kes(sag, w)
	}
	sol = kes(sol, w-sg-1)
	return sol + strings.Repeat(" ", max(1, w-gorunur(sol)-sg)) + sag
}
