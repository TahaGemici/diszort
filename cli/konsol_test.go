package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

// Komut konsolu: program tarafı gerçek bir soketle: karşılama, satırlar, Tab, soru, kapanış; ikinci
// bir program aynı adla açılamaz.
func TestKonsolSunucu(t *testing.T) {
	ad := konsolAdi(fmt.Sprintf("/deneme/%d/diszort.json", time.Now().UnixNano()))
	l, err := konsolDinle(ad)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := konsolDinle(ad); !errors.Is(err, errZatenAcik) {
		t.Fatalf("ikinci açılış: %v", err)
	}
	ui := yeniArayuz(true)
	ui.uzak = true
	satirlar := make(chan string, 8)
	ui.KonsolSatir = func(s string) { satirlar <- s }
	k := yeniKonsolSunucu(l, ui)
	k.tamamla = func(g string) (string, []string) { return g + "lar ", []string{"kanallar"} }
	sayi := make(chan int, 8)
	k.Sayi = func(n int) { sayi <- n }
	ui.konsol = k
	ui.Yaz("önceki satır")
	ui.Istem("#genel> ")
	k.baslat()

	c, err := net.DialUnix("unix", nil, konsolAdresi(ad))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	oku := bufio.NewScanner(c)
	al := func() konsolIleti {
		c.SetReadDeadline(time.Now().Add(2 * time.Second))
		if !oku.Scan() {
			t.Fatalf("ileti gelmedi: %v", oku.Err())
		}
		var m konsolIleti
		json.Unmarshal(oku.Bytes(), &m)
		return m
	}
	gonder := func(m konsolIleti) {
		b, _ := json.Marshal(m)
		c.Write(append(b, '\n'))
	}
	if m := al(); m.T != "hos" || m.S != "#genel> " || len(m.Satirlar) != 1 || m.Satirlar[0] != "önceki satır" {
		t.Fatalf("karşılama: %+v", m)
	}
	if n := <-sayi; n != 1 {
		t.Fatalf("konsol sayısı %d", n)
	}
	gonder(konsolIleti{T: "satir", S: "kanallar"})
	if s := <-satirlar; s != "kanallar" {
		t.Fatalf("satır: %q", s)
	}
	gonder(konsolIleti{T: "tamamla", N: 7, S: "/kana"})
	if m := al(); m.T != "tamam" || m.N != 7 || m.S != "/kanalar " {
		t.Fatalf("tamamla: %+v", m)
	}
	ui.Yaz("çıktı")
	if m := al(); m.T != "yaz" || m.S != "çıktı" {
		t.Fatalf("yaz: %+v", m)
	}
	// Soru: konsoldan cevaplanır, komut olarak işlenmez.
	cevap := make(chan string, 1)
	ui.Sor("Emin misin? (e/h) ", false, func(s string) { cevap <- s })
	if m := al(); m.T != "sor" {
		t.Fatalf("sor: %+v", m)
	}
	gonder(konsolIleti{T: "satir", S: "e"})
	select {
	case s := <-cevap:
		if s != "e" {
			t.Fatalf("cevap %q", s)
		}
	case s := <-satirlar:
		t.Fatalf("cevap komut sanıldı: %q", s)
	case <-time.After(2 * time.Second):
		t.Fatal("cevap gelmedi")
	}
	if m := al(); m.T != "sorbitti" {
		t.Fatalf("sorbitti: %+v", m)
	}
	// Ctrl+C komut bölmesinde: "cik" programı kapatır.
	cik := make(chan bool, 1)
	k.cik = func() { cik <- true }
	gonder(konsolIleti{T: "cik"})
	select {
	case <-cik:
	case <-time.After(2 * time.Second):
		t.Fatal("cik iletisi programı kapatmadı")
	}
	k.kapat("bitti")
	if m := al(); m.T != "bitti" {
		t.Fatalf("kapanış: %+v", m)
	}
	// Ad yeniden kullanılabilir (soyut soket, dosya kalmaz).
	l2, err := konsolDinle(ad)
	if err != nil {
		t.Fatalf("kapandıktan sonra açılmadı: %v", err)
	}
	l2.Close()
}
