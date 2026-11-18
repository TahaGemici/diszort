package ses

// Opus kodlayıcı ve çözücü (libopus, programa gömülü).

/*
#cgo CFLAGS: -I/usr/include/opus
#cgo LDFLAGS: -Wl,-Bstatic -lopus -Wl,-Bdynamic -lm
#include <opus.h>

static int kod_bit_hizi(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_BITRATE(v)); }
static int kod_karmasiklik(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_COMPLEXITY(v)); }
static int kod_fec(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_INBAND_FEC(v)); }
static int kod_kayip(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_PACKET_LOSS_PERC(v)); }
static int kod_dtx(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_DTX(v)); }
static int kod_vbr(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_VBR(v)); }
static int kod_bant(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_MAX_BANDWIDTH(v)); }
static int kod_sinyal(OpusEncoder *e, int v) { return opus_encoder_ctl(e, OPUS_SET_SIGNAL(v)); }
static int coz_sifirla(OpusDecoder *d) { return opus_decoder_ctl(d, OPUS_RESET_STATE); }
*/
import "C"

import (
	"errors"
	"fmt"
	"unsafe"
)

func opusHatasi(kod C.int) error {
	return fmt.Errorf("opus: %s", C.GoString(C.opus_strerror(kod)))
}

// Kodlayici: Opus kodlayıcı (48 kHz). Tek goroutine'den kullanılır.
type Kodlayici struct {
	e      *C.OpusEncoder
	kanal  int
	tampon []byte
	hiz    int
	kayip  int
}

// YeniKodlayici: muzik=false konuşma (VOIP, tarayıcıların mikrofonu gibi), true müzik (AUDIO).
func YeniKodlayici(kanal int, muzik bool) (*Kodlayici, error) {
	uygulama := C.OPUS_APPLICATION_VOIP
	if muzik {
		uygulama = C.OPUS_APPLICATION_AUDIO
	}
	var hata C.int
	e := C.opus_encoder_create(48000, C.int(kanal), C.int(uygulama), &hata)
	if hata != C.OPUS_OK || e == nil {
		return nil, opusHatasi(hata)
	}
	k := &Kodlayici{e: e, kanal: kanal, tampon: make([]byte, 1500)}
	// Tarayıcıların (libwebrtc) ayarları: değişken bit hızı, kayba karşı kendi yedeği (FEC) açık,
	// sessizlikte kesme (DTX) kapalı (web: usedtx=0), tam bant.
	C.kod_karmasiklik(e, 10)
	C.kod_vbr(e, 1)
	C.kod_fec(e, 1)
	C.kod_dtx(e, 0)
	C.kod_bant(e, C.OPUS_BANDWIDTH_FULLBAND)
	if muzik {
		C.kod_sinyal(e, C.OPUS_SIGNAL_MUSIC)
	}
	return k, nil
}

// BitHizi: hedef bit hızı (bit/sn).
func (k *Kodlayici) BitHizi(v int) {
	if k == nil || k.e == nil || v == k.hiz {
		return
	}
	k.hiz = v
	C.kod_bit_hizi(k.e, C.int(v))
}

// Kayip: ağdaki kayıp yüzdesi (kodlayıcı yedeği buna göre ayarlar).
func (k *Kodlayici) Kayip(yuzde int) {
	yuzde = min(30, max(0, yuzde))
	if k == nil || k.e == nil || yuzde == k.kayip {
		return
	}
	k.kayip = yuzde
	C.kod_kayip(k.e, C.int(yuzde))
}

// Kodla: 20 ms'lik (960 örnek × kanal) araya geçmiş ses → Opus çerçevesi (yeni dilim).
func (k *Kodlayici) Kodla(ornek []float32) ([]byte, error) {
	if k.e == nil {
		return nil, errors.New("opus: kapalı")
	}
	n := len(ornek) / k.kanal
	r := C.opus_encode_float(k.e, (*C.float)(unsafe.Pointer(&ornek[0])), C.int(n), (*C.uchar)(unsafe.Pointer(&k.tampon[0])), C.opus_int32(len(k.tampon)))
	if r < 0 {
		return nil, opusHatasi(r)
	}
	return append([]byte(nil), k.tampon[:r]...), nil
}

func (k *Kodlayici) Kapat() {
	if k != nil && k.e != nil {
		C.opus_encoder_destroy(k.e)
		k.e = nil
	}
}

// Cozucu: Opus çözücü; her zaman iki kanal verir (tek kanallı akış iki kanala yayılır).
type Cozucu struct {
	d *C.OpusDecoder
}

func YeniCozucu() (*Cozucu, error) {
	var hata C.int
	d := C.opus_decoder_create(48000, 2, &hata)
	if hata != C.OPUS_OK || d == nil {
		return nil, opusHatasi(hata)
	}
	return &Cozucu{d: d}, nil
}

// Coz: paketi çöz; cikis en az 5760×2 örnek almalı. veri boşsa kayıp çerçeve uydurulur (PLC),
// fec=true ise paketin içindeki önceki çerçevenin yedeği çözülür. sure: uydurulacak/çözülecek örnek.
// Dönüş: kanal başına örnek sayısı.
func (c *Cozucu) Coz(veri []byte, cikis []float32, sure int, fec bool) (int, error) {
	if c.d == nil {
		return 0, errors.New("opus: kapalı")
	}
	var p *C.uchar
	if len(veri) > 0 {
		p = (*C.uchar)(unsafe.Pointer(&veri[0]))
	}
	f := C.int(0)
	if fec {
		f = 1
	}
	if sure <= 0 || sure > len(cikis)/2 {
		sure = len(cikis) / 2
	}
	r := C.opus_decode_float(c.d, p, C.opus_int32(len(veri)), (*C.float)(unsafe.Pointer(&cikis[0])), C.int(sure), f)
	if r < 0 {
		return 0, opusHatasi(r)
	}
	return int(r), nil
}

// Sure: paketin süresi (kanal başına örnek); bozuksa 0.
func PaketSuresi(veri []byte) int {
	if len(veri) == 0 {
		return 0
	}
	r := C.opus_packet_get_nb_samples((*C.uchar)(unsafe.Pointer(&veri[0])), C.opus_int32(len(veri)), 48000)
	if r < 0 {
		return 0
	}
	return int(r)
}

func (c *Cozucu) Sifirla() {
	if c.d != nil {
		C.coz_sifirla(c.d)
	}
}

func (c *Cozucu) Kapat() {
	if c != nil && c.d != nil {
		C.opus_decoder_destroy(c.d)
		c.d = nil
	}
}
