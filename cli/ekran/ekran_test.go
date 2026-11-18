package ekran

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// X sunucusu gerekir (EKRAN_DENE=1, DISPLAY): bütün ekranı yakalayıp VP8'e kodlar.
func TestX11Yakala(t *testing.T) {
	if os.Getenv("EKRAN_DENE") != "1" || !X11Var() {
		t.Skip("EKRAN_DENE=1 ve DISPLAY ile çalışır")
	}
	ml, err := X11Monitorler()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("monitörler: %v", ml)
	var kareler, anahtar, bayt int
	p, err := Baslat(Secim{Kare: 30})
	if err != nil {
		t.Fatal(err)
	}
	p.IzleyenVar = func() bool { return true }
	p.Gonder = func(k []byte, _ time.Duration) {
		kareler++
		bayt += len(k)
		if len(k) > 0 && k[0]&1 == 0 {
			anahtar++
		}
	}
	time.Sleep(2 * time.Second)
	p.Durdur()
	<-p.Bitti
	t.Logf("%s: %d kare, %d anahtar, %d KB", p.Bilgi(), kareler, anahtar, bayt/1024)
	if p.Hata != nil {
		t.Fatal(p.Hata)
	}
	if kareler < 30 || anahtar < 1 {
		t.Fatalf("yeterli kare yok: %d (anahtar %d)", kareler, anahtar)
	}
}

// Wayland masaüstü ve ekran paylaşım portalı gerekir (EKRAN_DENE=1, WAYLAND_DISPLAY): portal üzerinden
// PipeWire akışını yakalayıp VP8'e kodlar; ikinci açılış hatırlanan seçimle (sormadan) olmalı.
func TestWaylandYakala(t *testing.T) {
	if os.Getenv("EKRAN_DENE") != "1" || Oturum() != "wayland" {
		t.Skip("EKRAN_DENE=1 ve Wayland oturumu ile çalışır")
	}
	belirtec := ""
	for kez := 1; kez <= 2; kez++ {
		var kareler, bayt int
		p, err := Baslat(Secim{Kare: 30, IzinBelirteci: belirtec})
		if err != nil {
			t.Fatal(kez, err)
		}
		p.IzleyenVar = func() bool { return true }
		p.Gonder = func(k []byte, _ time.Duration) {
			kareler++
			bayt += len(k)
		}
		time.Sleep(2 * time.Second)
		p.Durdur()
		<-p.Bitti
		t.Logf("%d. açılış: %s: %d kare, %d KB, hatırlama belirteci %q", kez, p.Bilgi(), kareler, bayt/1024, p.IzinBelirteci)
		if p.Hata != nil {
			t.Fatal(p.Hata)
		}
		if kareler < 20 {
			t.Fatalf("yeterli kare yok: %d", kareler)
		}
		belirtec = p.IzinBelirteci
	}
}

// PipeWire okuyucusu (portalsız): PW_DUGUM'deki görüntü kaynağına bağlanıp kareleri kodlar.
func TestPipeWireOkuyucu(t *testing.T) {
	d := os.Getenv("PW_DUGUM")
	if d == "" {
		t.Skip("PW_DUGUM ile çalışır")
	}
	var dugum uint32
	fmt.Sscanf(d, "%d", &dugum)
	w, err := pipewireDogrudan(dugum, 30)
	if err != nil {
		t.Fatal(err)
	}
	var kareler, bayt int
	p := kaynaktan(w, Secim{Kare: 30}, "")
	p.IzleyenVar = func() bool { return true }
	p.Gonder = func(k []byte, _ time.Duration) {
		kareler++
		bayt += len(k)
	}
	time.Sleep(2 * time.Second)
	p.Durdur()
	<-p.Bitti
	t.Logf("%s: %d kare, %d KB", p.Bilgi(), kareler, bayt/1024)
	if p.Hata != nil {
		t.Fatal(p.Hata)
	}
	if kareler < 20 {
		t.Fatalf("yeterli kare yok: %d", kareler)
	}
}

// Portalın Start yanıtı gerçek bir D-Bus iletisi gibi kodlanıp çözülür (yapılar orada []any olur),
// sonra wayland.go'nun ayrıştırmasından geçer. Ekran ya da D-Bus gerekmez.
func TestPortalBaslatYaniti(t *testing.T) {
	type akis struct {
		Dugum uint32
		Oz    map[string]dbus.Variant
	}
	govde := map[string]dbus.Variant{
		"streams": dbus.MakeVariant([]akis{{42, map[string]dbus.Variant{
			"size":        dbus.MakeVariant(struct{ G, Y int32 }{2560, 1440}),
			"source_type": dbus.MakeVariant(uint32(1)),
		}}}),
		"restore_token": dbus.MakeVariant("belirtec-123"),
	}
	m := &dbus.Message{Type: dbus.TypeSignal, Headers: map[dbus.HeaderField]dbus.Variant{
		dbus.FieldPath:      dbus.MakeVariant(dbus.ObjectPath("/org/freedesktop/portal/desktop/request/1_2/diszort1")),
		dbus.FieldInterface: dbus.MakeVariant("org.freedesktop.portal.Request"),
		dbus.FieldMember:    dbus.MakeVariant("Response"),
		dbus.FieldSignature: dbus.MakeVariant(dbus.SignatureOf(uint32(0), govde)),
	}, Body: []any{uint32(0), govde}}
	var b bytes.Buffer
	if err := m.EncodeTo(&b, binary.LittleEndian); err != nil {
		t.Fatal(err)
	}
	c, err := dbus.DecodeMessage(&b)
	if err != nil {
		t.Fatal(err)
	}
	sonuc, _ := c.Body[1].(map[string]dbus.Variant)
	dugum, boyut, belirtec, err := baslatYaniti(sonuc)
	if err != nil || dugum != 42 || boyut != "2560×1440" || belirtec != "belirtec-123" {
		t.Fatalf("düğüm %d, boy %q, belirteç %q, hata %v", dugum, boyut, belirtec, err)
	}
	if _, _, _, err := baslatYaniti(map[string]dbus.Variant{}); err == nil {
		t.Fatal("akışsız yanıt hata vermeli")
	}
}
