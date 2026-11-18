// Package gurultu: mikrofonun yolu — RNNoise gürültü bastırma (hep açık) → mikrofon seviyesi →
// konuşma eşiği (kapı). Web istemcisindeki web/gurultu.js'in karşılığıdır ve aynı RNNoise'u çalıştırır:
// web/rnnoise.wasm wasm2c ile C'ye çevrilir (uret.sh), yerel hızda çalışır.
//
// RNNoise 48 kHz'de 480 örneklik (10 ms) çerçevelerle çalışır, örnekler ±32768 ölçeğinde.
// Kapı: çerçevenin seviyesi (gürültü bastırıldıktan ve kazançtan sonra) eşiği geçince hemen açılır,
// eşiğin altında 300 ms kalınca kapanır; açılış 2 ms, kapanış 20 ms'lik rampayla.
package gurultu

//go:generate sh uret.sh

/*
#cgo CFLAGS: -O3 -DWASM_RT_MEMCHECK_SIGNAL_HANDLER=0 -w
#cgo LDFLAGS: -lm
#include <stdlib.h>
#include <string.h>
#include "rnnoise_w2c.h"

// İçe aktarmalar: belleği büyüt (emscripten_resize_heap), bellek içinde kopyala.
struct w2c_a { w2c_rnnoise *ornek; };

u32 w2c_a_a(struct w2c_a *a, u32 istenen) {
	wasm_rt_memory_t *m = w2c_rnnoise_c(a->ornek);
	if ((u64)istenen > m->size) {
		u64 sayfa = ((u64)istenen - m->size + 65535) / 65536;
		if (wasm_rt_grow_memory(m, sayfa) == (u64)-1) return 0;
	}
	return 1;
}

void w2c_a_b(struct w2c_a *a, u32 hedef, u32 kaynak, u32 n) {
	wasm_rt_memory_t *m = w2c_rnnoise_c(a->ornek);
	memmove(m->data + hedef, m->data + kaynak, n);
}

typedef struct {
	w2c_rnnoise ornek;
	struct w2c_a ice;
	u32 durum, giris, cikis;
} rnn;

static void rnn_baslat(void) { if (!wasm_rt_is_initialized()) wasm_rt_init(); }

static rnn *rnn_kur(void) {
	rnn *r = calloc(1, sizeof(rnn));
	if (!r) return NULL;
	r->ice.ornek = &r->ornek;
	wasm2c_rnnoise_instantiate(&r->ornek, &r->ice);
	w2c_rnnoise_d(&r->ornek);
	r->durum = w2c_rnnoise_f(&r->ornek, 0);
	r->giris = w2c_rnnoise_g(&r->ornek, 480 * 4);
	r->cikis = w2c_rnnoise_g(&r->ornek, 480 * 4);
	if (!r->durum || !r->giris || !r->cikis) {
		wasm2c_rnnoise_free(&r->ornek);
		free(r);
		return NULL;
	}
	return r;
}

// Bir çerçeve (480 örnek, ±1 ölçeği): gürültüsü bastırılmış çıkış; dönüş: konuşma olasılığı.
static float rnn_isle(rnn *r, float *cikis, const float *giris) {
	wasm_rt_memory_t *m = w2c_rnnoise_c(&r->ornek);
	float *g = (float *)(m->data + r->giris);
	for (int i = 0; i < 480; i++) g[i] = giris[i] * 32768.0f;
	float p = w2c_rnnoise_j(&r->ornek, r->durum, r->cikis, r->giris);
	m = w2c_rnnoise_c(&r->ornek);
	float *c = (float *)(m->data + r->cikis);
	for (int i = 0; i < 480; i++) cikis[i] = c[i] / 32768.0f;
	return p;
}

static void rnn_kapat(rnn *r) {
	w2c_rnnoise_h(&r->ornek, r->durum);
	w2c_rnnoise_i(&r->ornek, r->giris);
	w2c_rnnoise_i(&r->ornek, r->cikis);
	wasm2c_rnnoise_free(&r->ornek);
	free(r);
}
*/
import "C"

import (
	"errors"
	"math"
	"sync"
	"unsafe"
)

// Cerceve: RNNoise'un çerçevesi (10 ms).
const Cerceve = 480

var baslat sync.Once

// Olcum: ~100 ms'nin ortalaması (web: {tur:'olcum'}).
type Olcum struct {
	Konusma float64 // konuşma olasılığı (0-1)
	GirisDb float64 // bastırmadan önce
	RnnDb   float64 // bastırmadan sonra, kazançsız
	CikisDb float64 // kazançtan sonra, kapıdan önce
	Acik    bool    // kapı açık (ses gidiyor)
}

// Yol: bir mikrofonun yolu. Aynı anda tek goroutine'den kullanılır (Isle); Ayarla ve SonOlcum her yerden.
type Yol struct {
	r           *C.rnn
	mu          sync.Mutex
	kazanc      float64
	esik        float64 // dBFS; NaN: kapı yok
	kapi        float64
	tutma       int
	acilisAdim  float64
	kapanisAdim float64
	sonSes      int
	sayac       int
	gir, cik    []float32
	top         struct {
		n                          int
		konusma, giris, rnn, cikis float64
	}
	olcum Olcum
}

// Yeni: kazanc (1 = %100), esikDb (NaN: eşik kapalı).
func Yeni(kazanc, esikDb float64) (*Yol, error) {
	baslat.Do(func() { C.rnn_baslat() })
	r := C.rnn_kur()
	if r == nil {
		return nil, errors.New("RNNoise kurulamadı")
	}
	y := &Yol{r: r, kazanc: kazanc, esik: esikDb, tutma: int(0.3 * 48000), acilisAdim: 1 / (0.002 * 48000), kapanisAdim: 1 / (0.02 * 48000), sonSes: math.MinInt32 / 2,
		gir: make([]float32, Cerceve), cik: make([]float32, Cerceve)}
	if math.IsNaN(esikDb) {
		y.kapi = 1
	}
	return y, nil
}

// Ayarla: seviye ve eşik (konuşurken de hemen geçerli).
func (y *Yol) Ayarla(kazanc, esikDb float64) {
	y.mu.Lock()
	y.kazanc, y.esik = kazanc, esikDb
	y.mu.Unlock()
}

// SonOlcum: son ~100 ms'nin ölçümü.
func (y *Yol) SonOlcum() Olcum {
	y.mu.Lock()
	defer y.mu.Unlock()
	return y.olcum
}

// Isle: 480 örneklik çerçeveyi yerinde işle (giriş tek kanal, ±1).
func (y *Yol) Isle(x []float32) {
	if len(x) != Cerceve || y.r == nil {
		return
	}
	y.mu.Lock()
	kazanc, esik := y.kazanc, y.esik
	y.mu.Unlock()
	var ge float64
	for _, v := range x {
		ge += float64(v) * float64(v)
	}
	copy(y.gir, x)
	konusma := float64(C.rnn_isle(y.r, (*C.float)(unsafe.Pointer(&y.cik[0])), (*C.float)(unsafe.Pointer(&y.gir[0]))))
	var re, ce float64
	for i, v := range y.cik {
		re += float64(v) * float64(v)
		v2 := float64(v) * kazanc
		x[i] = float32(v2)
		ce += v2 * v2
	}
	cikisDb := 10 * math.Log10(ce/Cerceve+1e-12)
	hedef := 1.0
	if !math.IsNaN(esik) {
		if cikisDb >= esik {
			y.sonSes = y.sayac
		}
		if y.sayac-y.sonSes > y.tutma {
			hedef = 0
		}
	}
	for i := range x {
		if y.kapi < hedef {
			y.kapi = math.Min(hedef, y.kapi+y.acilisAdim)
		} else if y.kapi > hedef {
			y.kapi = math.Max(hedef, y.kapi-y.kapanisAdim)
		}
		x[i] = float32(float64(x[i]) * y.kapi)
	}
	y.sayac += Cerceve
	t := &y.top
	t.n++
	t.konusma += konusma
	t.giris += ge / Cerceve
	t.rnn += re / Cerceve
	t.cikis += ce / Cerceve
	if t.n >= 10 {
		db := func(v float64) float64 { return math.Round(10*math.Log10(v/float64(t.n)+1e-12)*10) / 10 }
		o := Olcum{Konusma: math.Round(t.konusma/float64(t.n)*100) / 100, GirisDb: db(t.giris), RnnDb: db(t.rnn), CikisDb: db(t.cikis), Acik: hedef == 1}
		y.mu.Lock()
		y.olcum = o
		y.mu.Unlock()
		*t = struct {
			n                          int
			konusma, giris, rnn, cikis float64
		}{}
	}
}

func (y *Yol) Kapat() {
	if y.r != nil {
		C.rnn_kapat(y.r)
		y.r = nil
	}
}
