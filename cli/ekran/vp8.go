package ekran

// VP8 kodlayıcı (libvpx) ve renk dönüşümü/ölçekleme (libyuv); ikisi de programa gömülü.

/*
#cgo CFLAGS: -O2
#cgo LDFLAGS: -Wl,-Bstatic -lvpx -lyuv -Wl,-Bdynamic -lstdc++ -lm -lpthread
#include <stdlib.h>
#include <string.h>
#include <vpx/vpx_encoder.h>
#include <vpx/vp8cx.h>
#include <libyuv.h>

typedef struct {
	vpx_codec_ctx_t ctx;
	vpx_codec_enc_cfg_t cfg;
	vpx_image_t *img;
	int w, h;
	uint8_t *ara;      // ölçeklemede ara I420 (kaynak boyunda)
	int araw, arah;
	int64_t pts;
} vp8k;

static vp8k *vp8_kur(int w, int h, int kbps, int kare, int is, char *hata, int hatab) {
	vp8k *k = calloc(1, sizeof(vp8k));
	if (!k) return NULL;
	vpx_codec_iface_t *arayuz = vpx_codec_vp8_cx();
	if (vpx_codec_enc_config_default(arayuz, &k->cfg, 0)) { free(k); snprintf(hata, hatab, "varsayılan ayar alınamadı"); return NULL; }
	k->w = w; k->h = h;
	k->cfg.g_w = w;
	k->cfg.g_h = h;
	k->cfg.g_timebase.num = 1;
	k->cfg.g_timebase.den = 90000;
	k->cfg.rc_target_bitrate = kbps;
	k->cfg.rc_end_usage = VPX_CBR;
	k->cfg.g_lag_in_frames = 0;
	k->cfg.g_error_resilient = VPX_ERROR_RESILIENT_DEFAULT;
	k->cfg.g_threads = is;
	k->cfg.rc_min_quantizer = 2;
	k->cfg.rc_max_quantizer = 56;
	k->cfg.rc_undershoot_pct = 100;
	k->cfg.rc_overshoot_pct = 15;
	k->cfg.rc_buf_initial_sz = 500;
	k->cfg.rc_buf_optimal_sz = 600;
	k->cfg.rc_buf_sz = 1000;
	k->cfg.rc_dropframe_thresh = 30;
	k->cfg.kf_mode = VPX_KF_AUTO;
	k->cfg.kf_max_dist = 3000;
	if (vpx_codec_enc_init(&k->ctx, arayuz, &k->cfg, 0)) {
		snprintf(hata, hatab, "%s", vpx_codec_error_detail(&k->ctx) ? vpx_codec_error_detail(&k->ctx) : vpx_codec_error(&k->ctx));
		free(k);
		return NULL;
	}
	// Gerçek zamanlı: hız öncelikli (tarayıcılar masaüstünde -6..-8 kullanır).
	vpx_codec_control(&k->ctx, VP8E_SET_CPUUSED, -8);
	vpx_codec_control(&k->ctx, VP8E_SET_STATIC_THRESHOLD, 1);
	vpx_codec_control(&k->ctx, VP8E_SET_NOISE_SENSITIVITY, 0);
	vpx_codec_control(&k->ctx, VP8E_SET_TOKEN_PARTITIONS, is > 1 ? VP8_FOUR_TOKENPARTITION : VP8_ONE_TOKENPARTITION);
	vpx_codec_control(&k->ctx, VP8E_SET_MAX_INTRA_BITRATE_PCT, 300);
	k->img = vpx_img_alloc(NULL, VPX_IMG_FMT_I420, w, h, 16);
	if (!k->img) { vpx_codec_destroy(&k->ctx); free(k); snprintf(hata, hatab, "görüntü belleği ayrılamadı"); return NULL; }
	return k;
}

static void vp8_hiz(vp8k *k, int kbps) {
	if ((int)k->cfg.rc_target_bitrate == kbps) return;
	k->cfg.rc_target_bitrate = kbps;
	vpx_codec_enc_config_set(&k->ctx, &k->cfg);
}

// BGRx/BGRA (bellekte B,G,R,X; libyuv'un adıyla "ARGB") ya da RGBx (rgb=1; libyuv "ABGR") kaynağı I420'ye
// çevirir, gerekirse ölçekler.
static int vp8_doldur(vp8k *k, const uint8_t *src, int stride, int sw, int sh, int rgb) {
	vpx_image_t *im = k->img;
	if (sw == k->w && sh == k->h) {
		if (rgb) return ABGRToI420(src, stride, im->planes[0], im->stride[0], im->planes[1], im->stride[1], im->planes[2], im->stride[2], sw, sh);
		return ARGBToI420(src, stride, im->planes[0], im->stride[0], im->planes[1], im->stride[1], im->planes[2], im->stride[2], sw, sh);
	}
	int cw = (sw + 1) / 2, ch = (sh + 1) / 2;
	if (k->araw != sw || k->arah != sh) {
		free(k->ara);
		k->ara = malloc((size_t)sw * sh + 2 * (size_t)cw * ch);
		if (!k->ara) { k->araw = k->arah = 0; return -1; }
		k->araw = sw; k->arah = sh;
	}
	uint8_t *y = k->ara, *u = y + (size_t)sw * sh, *v = u + (size_t)cw * ch;
	int r = rgb ? ABGRToI420(src, stride, y, sw, u, cw, v, cw, sw, sh) : ARGBToI420(src, stride, y, sw, u, cw, v, cw, sw, sh);
	if (r) return r;
	return I420Scale(y, sw, u, cw, v, cw, sw, sh, im->planes[0], im->stride[0], im->planes[1], im->stride[1], im->planes[2], im->stride[2], k->w, k->h, kFilterBox);
}

// Kodla: dönüş: çerçeve boyu (0: kodlayıcı kareyi atladı), -1: hata. Çıktı *cikis'e (libvpx belleği; bir
// sonraki çağrıya kadar geçerli).
static int vp8_kodla(vp8k *k, int64_t pts, int anahtar, const uint8_t **cikis, int *anahtarMi) {
	vpx_enc_frame_flags_t f = anahtar ? VPX_EFLAG_FORCE_KF : 0;
	if (vpx_codec_encode(&k->ctx, k->img, pts, 3000, f, VPX_DL_REALTIME)) return -1;
	vpx_codec_iter_t it = NULL;
	const vpx_codec_cx_pkt_t *p;
	while ((p = vpx_codec_get_cx_data(&k->ctx, &it)) != NULL) {
		if (p->kind == VPX_CODEC_CX_FRAME_PKT) {
			*cikis = p->data.frame.buf;
			*anahtarMi = (p->data.frame.flags & VPX_FRAME_IS_KEY) != 0;
			return (int)p->data.frame.sz;
		}
	}
	return 0;
}

static void vp8_kapat(vp8k *k) {
	vpx_img_free(k->img);
	vpx_codec_destroy(&k->ctx);
	free(k->ara);
	free(k);
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// Kodlayici: VP8. Tek goroutine'den kullanılır.
type Kodlayici struct {
	k    *C.vp8k
	G, Y int
	kbps int
}

func YeniKodlayici(g, y, kbps, kare, is int) (*Kodlayici, error) {
	var hata [256]C.char
	k := C.vp8_kur(C.int(g), C.int(y), C.int(kbps), C.int(kare), C.int(is), &hata[0], 256)
	if k == nil {
		return nil, errors.New("VP8 kodlayıcı kurulamadı: " + C.GoString(&hata[0]))
	}
	return &Kodlayici{k: k, G: g, Y: y, kbps: kbps}, nil
}

func (k *Kodlayici) BitHizi(kbps int) {
	if kbps != k.kbps {
		k.kbps = kbps
		C.vp8_hiz(k.k, C.int(kbps))
	}
}

// Kodla: kaynak görüntüyü (BGRx ya da rgb=true ise RGBx) kodla; pts 90 kHz. Dönüş: kare (yeni dilim;
// kodlayıcı bu kareyi atladıysa nil) ve anahtar kare mi.
func (k *Kodlayici) Kodla(kaynak []byte, adim, sg, sy int, rgb bool, pts int64, anahtar bool) ([]byte, bool, error) {
	if len(kaynak) < adim*sy || sg <= 0 || sy <= 0 {
		return nil, false, errors.New("görüntü eksik")
	}
	r := C.int(0)
	if rgb {
		r = 1
	}
	if C.vp8_doldur(k.k, (*C.uint8_t)(unsafe.Pointer(&kaynak[0])), C.int(adim), C.int(sg), C.int(sy), r) != 0 {
		return nil, false, errors.New("renk dönüşümü başarısız")
	}
	var cikis *C.uint8_t
	var anahtarMi C.int
	a := C.int(0)
	if anahtar {
		a = 1
	}
	n := C.vp8_kodla(k.k, C.int64_t(pts), a, &cikis, &anahtarMi)
	if n < 0 {
		return nil, false, errors.New("VP8 kodlanamadı")
	}
	if n == 0 {
		return nil, false, nil
	}
	return C.GoBytes(unsafe.Pointer(cikis), n), anahtarMi != 0, nil
}

func (k *Kodlayici) Kapat() {
	if k.k != nil {
		C.vp8_kapat(k.k)
		k.k = nil
	}
}
