package ses

// Yankı engelleme (web'deki "yankı engelleme" seçeneği; tarayıcı bunu kendi yankı engelleyicisiyle
// yapar): hoparlörle konuşan birinin mikrofonu kanaldakilerin sesini de alır; engellenmezse onlar
// kendi seslerini geri duyar. CLI ne çaldığını tam olarak bilir: çalınan ses (karıştırıcının çıkışı)
// gecikmesine göre hizalanıp mikrofondan uyarlamalı süzgeçle çıkarılır (SpeexDSP, 200 ms kuyruk),
// kalan yankı ayrıca bastırılır. Varsayılan kapalı (kulaklıkta gerekmez, kapalıyken ses daha doğal).

/*
#cgo LDFLAGS: -Wl,-Bstatic -lspeexdsp -Wl,-Bdynamic -lm
#include <stdlib.h>
#include <speex/speex_echo.h>
#include <speex/speex_preprocess.h>

typedef struct { SpeexEchoState *e; SpeexPreprocessState *p; } yanki;

static yanki *yanki_kur(int cerceve, int kuyruk, int hiz) {
	yanki *y = (yanki *)calloc(1, sizeof(yanki));
	if (!y) return NULL;
	y->e = speex_echo_state_init(cerceve, kuyruk);
	y->p = speex_preprocess_state_init(cerceve, hiz);
	if (!y->e || !y->p) return NULL;
	speex_echo_ctl(y->e, SPEEX_ECHO_SET_SAMPLING_RATE, &hiz);
	int kapali = 0;
	speex_preprocess_ctl(y->p, SPEEX_PREPROCESS_SET_DENOISE, &kapali); // gürültüyü RNNoise bastırır
	speex_preprocess_ctl(y->p, SPEEX_PREPROCESS_SET_AGC, &kapali);
	speex_preprocess_ctl(y->p, SPEEX_PREPROCESS_SET_ECHO_STATE, y->e);
	return y;
}

static void yanki_isle(yanki *y, const short *mik, const short *uzak, short *cikis) {
	speex_echo_cancellation(y->e, mik, uzak, cikis);
	speex_preprocess_run(y->p, cikis);
}

static void yanki_kapat(yanki *y) {
	speex_echo_state_destroy(y->e);
	speex_preprocess_state_destroy(y->p);
	free(y);
}
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"
)

const yankiCerceve = 480 // 10 ms

// yankiEngeli: çalınan sesin halkası + Speex durumu.
type yankiEngeli struct {
	mu               sync.Mutex
	y                *C.yanki
	halka            [][]int16 // son ~1 sn'de çalınan bloklar (tek kanal)
	yazilan          int       // toplam yazılan blok
	gecikme          int       // mikrofonla çalınan arasındaki gecikme (blok)
	mik, uzak, cikis []int16
}

func yeniYankiEngeli() (*yankiEngeli, error) {
	y := C.yanki_kur(yankiCerceve, 48000/5, 48000)
	if y == nil {
		return nil, errors.New("yankı engelleyici kurulamadı")
	}
	e := &yankiEngeli{y: y, halka: make([][]int16, 100), gecikme: 5}
	for i := range e.halka {
		e.halka[i] = make([]int16, yankiCerceve)
	}
	e.mik = make([]int16, yankiCerceve)
	e.uzak = make([]int16, yankiCerceve)
	e.cikis = make([]int16, yankiCerceve)
	return e, nil
}

func kirp16(v float32) int16 {
	x := v * 32767
	if x > 32767 {
		return 32767
	}
	if x < -32768 {
		return -32768
	}
	return int16(x)
}

// calindi: hoparlöre yazılan 10 ms (iki kanal, 480 çerçeve); gecikmeMs: çıkışla girişin toplam gecikmesi.
func (e *yankiEngeli) calindi(blok []float32, gecikmeMs int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	h := e.halka[e.yazilan%len(e.halka)]
	for i := 0; i < yankiCerceve && 2*i+1 < len(blok); i++ {
		h[i] = kirp16((blok[2*i] + blok[2*i+1]) / 2)
	}
	e.yazilan++
	// Süzgeç yankıyı 0-200 ms arasında arar: verilen çalınan ses yankıdan biraz önce olsun (20 ms pay).
	e.gecikme = max(0, min(len(e.halka)-2, (gecikmeMs-20)/10))
}

// isle: mikrofonun 10 ms'si (tek kanal, yerinde).
func (e *yankiEngeli) isle(mik []float32) {
	if len(mik) != yankiCerceve {
		return
	}
	e.mu.Lock()
	i := e.yazilan - 1 - e.gecikme
	if i >= 0 && e.yazilan-i < len(e.halka) {
		copy(e.uzak, e.halka[i%len(e.halka)])
	} else {
		clear(e.uzak)
	}
	e.mu.Unlock()
	for k, v := range mik {
		e.mik[k] = kirp16(v)
	}
	C.yanki_isle(e.y, (*C.short)(unsafe.Pointer(&e.mik[0])), (*C.short)(unsafe.Pointer(&e.uzak[0])), (*C.short)(unsafe.Pointer(&e.cikis[0])))
	for k, v := range e.cikis {
		mik[k] = float32(v) / 32768
	}
}

func (e *yankiEngeli) kapat() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.y != nil {
		C.yanki_kapat(e.y)
		e.y = nil
	}
}
