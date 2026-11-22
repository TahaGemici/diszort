package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Komut konsolu: sohbet tam ekranken komutlar başka bir terminalden verilir (./diszort komut).
// Ana program yerel bir soket dinler: Linux'un soyut ad alanında (dosya oluşmaz); adı kullanıcı
// kimliğinden ve ayar dosyasının yolundan türer, yani her kurulumun kendi konsolu olur. İki uç da
// karşısının aynı kullanıcı olduğunu denetler (SO_PEERCRED). İletiler satır satır JSON:
//
//	program → konsol: hos (son satırlar + istem), yaz, istem, sor, sorbitti, tamam, bitti, yeniden
//	konsol → program: satir, tamamla, tus

type konsolIleti struct {
	T        string   `json:"t"`
	S        string   `json:"s,omitempty"`
	N        int      `json:"n,omitempty"`
	Gizli    bool     `json:"gizli,omitempty"`
	Oneriler []string `json:"oneriler,omitempty"`
	Satirlar []string `json:"satirlar,omitempty"`
}

var errZatenAcik = errors.New("zaten açık")

// konsolAdi: soketin adı (başındaki @: soyut ad alanı).
func konsolAdi(ayarDosyasi string) string {
	yol, err := filepath.Abs(ayarDosyasi)
	if err != nil {
		yol = ayarDosyasi
	}
	h := sha256.Sum256([]byte(yol))
	return fmt.Sprintf("@diszort-%d-%x", os.Getuid(), h[:8])
}

func konsolAdresi(ad string) *net.UnixAddr { return &net.UnixAddr{Name: ad, Net: "unix"} }

// karsiKullanici: soketin öbür ucundaki sürecin kullanıcısı.
func karsiKullanici(c *net.UnixConn) (int, error) {
	ham, err := c.SyscallConn()
	if err != nil {
		return -1, err
	}
	var uc *unix.Ucred
	var e error
	if err := ham.Control(func(fd uintptr) { uc, e = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) }); err != nil {
		return -1, err
	}
	if e != nil {
		return -1, e
	}
	return int(uc.Uid), nil
}

// ---------------------------------------------------------------- program tarafı

type konsolSunucu struct {
	ui        *Arayuz
	dinleyici *net.UnixListener
	tamamla   func(girdi string) (string, []string)
	tus       func(ad string)
	// Sayi: bağlı konsol sayısı değişti (dinleyici goroutine'inden).
	Sayi func(n int)

	mu         sync.Mutex
	istemciler map[*konsolIstemci]bool
	gecmis     []string
	sonIstem   string
	soru       *konsolIleti
	kapandi    bool
	yazicilar  sync.WaitGroup
}

type konsolIstemci struct {
	c      *net.UnixConn
	mu     sync.Mutex
	gid    chan []byte
	kapali bool
}

// gonder: kuyruğa koy; kuyruk dolarsa (konsol okumuyor) bağlantı kapanır, program beklemez.
func (ist *konsolIstemci) gonder(m konsolIleti) {
	b, _ := json.Marshal(m)
	ist.mu.Lock()
	defer ist.mu.Unlock()
	if ist.kapali {
		return
	}
	select {
	case ist.gid <- append(b, '\n'):
	default:
		ist.kapali = true
		close(ist.gid)
	}
}

func (ist *konsolIstemci) kapat() {
	ist.mu.Lock()
	defer ist.mu.Unlock()
	if !ist.kapali {
		ist.kapali = true
		close(ist.gid)
	}
}

// konsolDinle: dinlemeye başla. Aynı ayar dosyasıyla açık bir Diszort varsa errZatenAcik.
func konsolDinle(ad string) (*net.UnixListener, error) {
	l, err := net.ListenUnix("unix", konsolAdresi(ad))
	if err == nil {
		return l, nil
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		if c, e := net.DialUnix("unix", nil, konsolAdresi(ad)); e == nil {
			uid, e2 := karsiKullanici(c)
			c.Close()
			if e2 == nil && uid == os.Getuid() {
				return nil, errZatenAcik
			}
		}
	}
	return nil, err
}

func yeniKonsolSunucu(l *net.UnixListener, ui *Arayuz) *konsolSunucu {
	return &konsolSunucu{dinleyici: l, ui: ui, istemciler: map[*konsolIstemci]bool{}}
}

func (k *konsolSunucu) baslat() { go k.kabulEt() }

func (k *konsolSunucu) kabulEt() {
	for {
		c, err := k.dinleyici.AcceptUnix()
		if err != nil {
			return
		}
		if uid, err := karsiKullanici(c); err != nil || uid != os.Getuid() {
			c.Close()
			continue
		}
		ist := &konsolIstemci{c: c, gid: make(chan []byte, 1024)}
		k.mu.Lock()
		if k.kapandi {
			k.mu.Unlock()
			c.Close()
			return
		}
		k.istemciler[ist] = true
		ist.gonder(konsolIleti{T: "hos", Satirlar: append([]string(nil), k.gecmis...), S: k.sonIstem})
		if k.soru != nil {
			ist.gonder(*k.soru)
		}
		n := len(k.istemciler)
		k.yazicilar.Add(1)
		k.mu.Unlock()
		go k.yazici(ist)
		go k.okuyucu(ist)
		if k.Sayi != nil {
			k.Sayi(n)
		}
	}
}

func (k *konsolSunucu) yazici(ist *konsolIstemci) {
	defer k.yazicilar.Done()
	for b := range ist.gid {
		ist.c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := ist.c.Write(b); err != nil {
			break
		}
	}
	ist.c.Close()
}

func (k *konsolSunucu) okuyucu(ist *konsolIstemci) {
	defer k.cikar(ist)
	s := bufio.NewScanner(ist.c)
	s.Buffer(make([]byte, 64*1024), 1<<20)
	for s.Scan() {
		var m konsolIleti
		if json.Unmarshal(s.Bytes(), &m) != nil {
			continue
		}
		switch m.T {
		case "satir":
			k.ui.UzakSatir(m.S)
		case "tamamla":
			yeni, oneriler := m.S, []string(nil)
			if k.tamamla != nil {
				yeni, oneriler = k.tamamla(m.S)
			}
			ist.gonder(konsolIleti{T: "tamam", N: m.N, S: yeni, Oneriler: oneriler})
		case "tus":
			if (m.S == "alt+m" || m.S == "alt+d") && k.tus != nil {
				k.tus(m.S)
			}
		}
	}
}

func (k *konsolSunucu) cikar(ist *konsolIstemci) {
	ist.kapat()
	k.mu.Lock()
	_, vardi := k.istemciler[ist]
	delete(k.istemciler, ist)
	n := len(k.istemciler)
	kapandi := k.kapandi
	k.mu.Unlock()
	if vardi && !kapandi && k.Sayi != nil {
		k.Sayi(n)
	}
}

// yayinla: bütün konsollara (kilit altında).
func (k *konsolSunucu) yayinla(m konsolIleti) {
	for ist := range k.istemciler {
		ist.gonder(m)
	}
}

func (k *konsolSunucu) yaz(metin string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.gecmis = append(k.gecmis, strings.Split(strings.TrimRight(metin, "\n"), "\n")...)
	if len(k.gecmis) > 400 {
		k.gecmis = append([]string(nil), k.gecmis[len(k.gecmis)-300:]...)
	}
	k.yayinla(konsolIleti{T: "yaz", S: metin})
}

func (k *konsolSunucu) istem(s string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.sonIstem = s
	k.yayinla(konsolIleti{T: "istem", S: s})
}

func (k *konsolSunucu) sor(metin string, gizli bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.soru = &konsolIleti{T: "sor", S: metin, Gizli: gizli}
	k.yayinla(*k.soru)
}

func (k *konsolSunucu) sorBitti() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.soru == nil {
		return
	}
	k.soru = nil
	k.yayinla(konsolIleti{T: "sorbitti"})
}

func (k *konsolSunucu) sayi() int {
	k.mu.Lock()
	defer k.mu.Unlock()
	return len(k.istemciler)
}

// kapat: konsollara neden ("bitti": program kapandı, "yeniden": güncellenip yeniden başlıyor) söylenir,
// gidenler en çok yarım saniye beklenir.
func (k *konsolSunucu) kapat(neden string) {
	k.mu.Lock()
	if k.kapandi {
		k.mu.Unlock()
		return
	}
	k.kapandi = true
	k.dinleyici.Close()
	for ist := range k.istemciler {
		ist.gonder(konsolIleti{T: neden})
		ist.kapat()
	}
	k.mu.Unlock()
	bitti := make(chan struct{})
	go func() {
		k.yazicilar.Wait()
		close(bitti)
	}()
	select {
	case <-bitti:
	case <-time.After(500 * time.Millisecond):
	}
}

// ---------------------------------------------------------------- konsol tarafı (./diszort komut)

func konsolIstemcisi(ayarDosyasi string) error {
	ad := konsolAdi(ayarDosyasi)
	betik := os.Getenv("DISZORT_BETIK") == "1" || !terminalMi()
	a := yeniArayuz(betik)

	var mu sync.Mutex
	var c *net.UnixConn
	tamamlar := map[int]chan konsolIleti{}
	sayac := 0
	gonder := func(m konsolIleti) {
		mu.Lock()
		cc := c
		mu.Unlock()
		if cc == nil {
			return
		}
		b, _ := json.Marshal(m)
		cc.Write(append(b, '\n'))
	}
	cikis := make(chan struct{})
	var cikisOnce sync.Once
	cik := func() { cikisOnce.Do(func() { close(cikis) }) }

	a.Satir = func(s string) {
		mu.Lock()
		bagli := c != nil
		mu.Unlock()
		if !bagli && strings.TrimSpace(s) != "" {
			a.Yaz(a.Kirmizi("Diszort'a bağlı değil; komut gitmedi."))
			return
		}
		gonder(konsolIleti{T: "satir", S: s})
	}
	a.Tus = func(t string) {
		switch t {
		case "alt+m", "alt+d":
			gonder(konsolIleti{T: "tus", S: t})
		case "ctrl+c", "ctrl+d", "eof":
			cik()
		}
	}
	a.Tamamla = func(g string) (string, []string) {
		mu.Lock()
		if c == nil {
			mu.Unlock()
			return g, nil
		}
		sayac++
		n := sayac
		ch := make(chan konsolIleti, 1)
		tamamlar[n] = ch
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(tamamlar, n)
			mu.Unlock()
		}()
		gonder(konsolIleti{T: "tamamla", N: n, S: g})
		select {
		case m := <-ch:
			return m.S, m.Oneriler
		case <-time.After(time.Second):
			return g, nil
		}
	}
	if err := a.Baslat(); err != nil {
		return err
	}
	defer a.Bitir()
	a.Yaz(a.Kalin("Diszort komut konsolu") + a.Soluk(" · yazdığın komut olarak gider (başına / gerekmez) · yardım: komutlar · Ctrl+C: konsoldan çık"))
	a.Istem(a.Soluk("[bağlanıyor…] "))

	// oku: bağlantı kapanana kadar; dönüş: programın söylediği neden ("" = bağlantı koptu).
	oku := func(cc *net.UnixConn) string {
		s := bufio.NewScanner(cc)
		s.Buffer(make([]byte, 64*1024), 4<<20)
		for s.Scan() {
			var m konsolIleti
			if json.Unmarshal(s.Bytes(), &m) != nil {
				continue
			}
			switch m.T {
			case "hos":
				satirlar := m.Satirlar
				if len(satirlar) > 40 {
					satirlar = satirlar[len(satirlar)-40:]
				}
				if len(satirlar) > 0 {
					a.Yaz(strings.Join(satirlar, "\n"))
				}
				a.Istem(m.S)
			case "yaz":
				a.Yaz(m.S)
			case "istem":
				a.Istem(m.S)
			case "sor":
				a.Sor(m.S, m.Gizli, func(cevap string) { gonder(konsolIleti{T: "satir", S: cevap}) })
			case "sorbitti":
				a.SoruBitir()
			case "tamam":
				mu.Lock()
				ch := tamamlar[m.N]
				mu.Unlock()
				if ch != nil {
					ch <- m
				}
			case "bitti", "yeniden":
				return m.T
			}
		}
		return ""
	}

	go func() {
		dendi := false
		ilk := true
		for {
			select {
			case <-cikis:
				return
			default:
			}
			cc, err := net.DialUnix("unix", nil, konsolAdresi(ad))
			if err != nil {
				if !dendi {
					a.Yaz(a.Sari("Diszort açık değil.") + a.Soluk(" Başka bir terminalde ./diszort çalıştırınca buraya kendiliğinden bağlanır (çıkmak: Ctrl+C)."))
					a.Istem(a.Soluk("[bekleniyor…] "))
					dendi = true
				}
				time.Sleep(400 * time.Millisecond)
				continue
			}
			if uid, err := karsiKullanici(cc); err != nil || uid != os.Getuid() {
				cc.Close()
				a.Yaz(a.Kirmizi("Soketi başka bir kullanıcının programı tutuyor; bağlanılmadı."))
				time.Sleep(3 * time.Second)
				continue
			}
			mu.Lock()
			c = cc
			mu.Unlock()
			if !ilk || dendi {
				a.Yaz(a.Yesil("Diszort'a bağlandı."))
			}
			neden := oku(cc)
			ilk = false
			mu.Lock()
			c = nil
			mu.Unlock()
			cc.Close()
			a.SoruBitir()
			switch neden {
			case "bitti":
				a.Yaz(a.Soluk("Diszort kapandı."))
				cik()
				return
			case "yeniden":
				a.Yaz(a.Soluk("Diszort yeniden başlıyor…"))
			default:
				a.Yaz(a.Sari("Diszort'la bağlantı koptu;") + a.Soluk(" yeniden açılınca kendiliğinden bağlanır."))
			}
			a.Istem(a.Soluk("[bekleniyor…] "))
			dendi = true
			time.Sleep(200 * time.Millisecond)
		}
	}()
	<-cikis
	mu.Lock()
	if c != nil {
		c.Close()
	}
	mu.Unlock()
	return nil
}
