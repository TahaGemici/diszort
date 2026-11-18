package ekran

// Wayland'de ekran yakalama: masaüstü portalı (org.freedesktop.portal.ScreenCast, D-Bus) kullanıcıya
// ne paylaşılacağını sorar (ekran ya da pencere; seçim hatırlanır), seçilen görüntü PipeWire akışı
// olarak gelir. PipeWire kitaplığı programa bağlanmaz: paylaşım başlarken sistemdeki
// libpipewire-0.3.so.0 açılır (Wayland masaüstlerinde her zaman vardır; ekran paylaşımı onunla olur).

/*
#cgo CFLAGS: -O2 -I/usr/include/pipewire-0.3 -I/usr/include/spa-0.2 -D_REENTRANT -Wno-deprecated-declarations
#cgo LDFLAGS: -ldl -lpthread
#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/buffers.h>
#include <spa/pod/builder.h>

static void (*p_init)(int *, char ***);
static struct pw_thread_loop *(*p_tl_new)(const char *, const struct spa_dict *);
static struct pw_loop *(*p_tl_get_loop)(struct pw_thread_loop *);
static int (*p_tl_start)(struct pw_thread_loop *);
static void (*p_tl_stop)(struct pw_thread_loop *);
static void (*p_tl_lock)(struct pw_thread_loop *);
static void (*p_tl_unlock)(struct pw_thread_loop *);
static void (*p_tl_destroy)(struct pw_thread_loop *);
static struct pw_context *(*p_ctx_new)(struct pw_loop *, struct pw_properties *, size_t);
static void (*p_ctx_destroy)(struct pw_context *);
static struct pw_core *(*p_connect_fd)(struct pw_context *, int, struct pw_properties *, size_t);
static int (*p_core_disconnect)(struct pw_core *);
static struct pw_properties *(*p_props_new)(const char *, ...);
static struct pw_stream *(*p_stream_new)(struct pw_core *, const char *, struct pw_properties *);
static void (*p_stream_add_listener)(struct pw_stream *, struct spa_hook *, const struct pw_stream_events *, void *);
static int (*p_stream_connect)(struct pw_stream *, enum spa_direction, uint32_t, enum pw_stream_flags, const struct spa_pod **, uint32_t);
static struct pw_buffer *(*p_dequeue)(struct pw_stream *);
static int (*p_queue)(struct pw_stream *, struct pw_buffer *);
static int (*p_update_params)(struct pw_stream *, const struct spa_pod **, uint32_t);
static int (*p_stream_disconnect)(struct pw_stream *);
static void (*p_stream_destroy)(struct pw_stream *);

static int pw_yuklendi = 0;

static int pw_yukle(char *hata, int n) {
	if (pw_yuklendi) return 0;
	void *h = dlopen("libpipewire-0.3.so.0", RTLD_NOW | RTLD_LOCAL);
	if (!h) { snprintf(hata, n, "libpipewire açılamadı: %s", dlerror()); return -1; }
#define AL(d, ad) if (!(*(void **)&d = dlsym(h, ad))) { snprintf(hata, n, "libpipewire'da %s yok", ad); return -1; }
	AL(p_init, "pw_init") AL(p_tl_new, "pw_thread_loop_new") AL(p_tl_get_loop, "pw_thread_loop_get_loop")
	AL(p_tl_start, "pw_thread_loop_start") AL(p_tl_stop, "pw_thread_loop_stop") AL(p_tl_lock, "pw_thread_loop_lock")
	AL(p_tl_unlock, "pw_thread_loop_unlock") AL(p_tl_destroy, "pw_thread_loop_destroy") AL(p_ctx_new, "pw_context_new")
	AL(p_ctx_destroy, "pw_context_destroy") AL(p_connect_fd, "pw_context_connect_fd") AL(p_core_disconnect, "pw_core_disconnect")
	AL(p_props_new, "pw_properties_new") AL(p_stream_new, "pw_stream_new") AL(p_stream_add_listener, "pw_stream_add_listener")
	AL(p_stream_connect, "pw_stream_connect") AL(p_dequeue, "pw_stream_dequeue_buffer") AL(p_queue, "pw_stream_queue_buffer")
	AL(p_update_params, "pw_stream_update_params") AL(p_stream_disconnect, "pw_stream_disconnect") AL(p_stream_destroy, "pw_stream_destroy")
#undef AL
	p_init(NULL, NULL);
	pw_yuklendi = 1;
	return 0;
}

typedef struct {
	struct pw_thread_loop *dongu;
	struct pw_context *baglam;
	struct pw_core *cekirdek;
	struct pw_stream *akis;
	struct spa_hook dinleyici;
	pthread_mutex_t mu;
	uint8_t *kare;
	size_t kapasite;
	int g, y, adim, bicim, var;
	int bitti;
	char hata[160];
	struct spa_video_info_raw bilgi;
} pwa;

static void pw_durum(void *v, enum pw_stream_state eski, enum pw_stream_state yeni, const char *hata) {
	pwa *a = v;
	if (yeni == PW_STREAM_STATE_ERROR) {
		pthread_mutex_lock(&a->mu);
		snprintf(a->hata, sizeof(a->hata), "%s", hata ? hata : "PipeWire akışı hata verdi");
		a->bitti = 1;
		pthread_mutex_unlock(&a->mu);
	} else if (yeni == PW_STREAM_STATE_UNCONNECTED && eski != PW_STREAM_STATE_CONNECTING) {
		pthread_mutex_lock(&a->mu);
		a->bitti = 1;
		pthread_mutex_unlock(&a->mu);
	}
}

static void pw_param(void *v, uint32_t id, const struct spa_pod *param) {
	pwa *a = v;
	if (param == NULL || id != SPA_PARAM_Format) return;
	uint32_t tur, alt;
	if (spa_format_parse(param, &tur, &alt) < 0 || tur != SPA_MEDIA_TYPE_video || alt != SPA_MEDIA_SUBTYPE_raw) return;
	struct spa_video_info_raw b;
	if (spa_format_video_raw_parse(param, &b) < 0) return;
	pthread_mutex_lock(&a->mu);
	a->bilgi = b;
	pthread_mutex_unlock(&a->mu);
	uint8_t tampon[256];
	struct spa_pod_builder bld = SPA_POD_BUILDER_INIT(tampon, sizeof(tampon));
	const struct spa_pod *p[1];
	p[0] = spa_pod_builder_add_object(&bld, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
		SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd)));
	p_update_params(a->akis, p, 1);
}

// Gelen kare kopyalanır (Go tarafı o sırada okuyorsa bu kare atlanır: yakalama hiç beklemez).
static void pw_isle(void *v) {
	pwa *a = v;
	struct pw_buffer *b = p_dequeue(a->akis);
	if (!b) return;
	struct spa_buffer *sb = b->buffer;
	struct spa_data *d = &sb->datas[0];
	if (d->data && d->chunk && d->chunk->size > 0 && pthread_mutex_trylock(&a->mu) == 0) {
		int g = a->bilgi.size.width, y = a->bilgi.size.height;
		int adim = d->chunk->stride > 0 ? d->chunk->stride : g * 4;
		size_t boy = (size_t)adim * y;
		if (g > 0 && y > 0 && boy <= d->maxsize && (size_t)d->chunk->offset + boy <= d->maxsize) {
			if (a->kapasite < boy) {
				free(a->kare);
				a->kare = malloc(boy);
				a->kapasite = a->kare ? boy : 0;
			}
			if (a->kare) {
				memcpy(a->kare, (uint8_t *)d->data + d->chunk->offset, boy);
				a->g = g; a->y = y; a->adim = adim; a->bicim = a->bilgi.format; a->var = 1;
			}
		}
		pthread_mutex_unlock(&a->mu);
	}
	p_queue(a->akis, b);
}

static const struct pw_stream_events pw_olaylar = {
	PW_VERSION_STREAM_EVENTS,
	.state_changed = pw_durum,
	.param_changed = pw_param,
	.process = pw_isle,
};

static pwa *pw_ac(int fd, uint32_t dugum, int kare, char *hata, int n) {
	if (pw_yukle(hata, n)) return NULL;
	pwa *a = calloc(1, sizeof(pwa));
	if (!a) return NULL;
	pthread_mutex_init(&a->mu, NULL);
	a->dongu = p_tl_new("diszort-ekran", NULL);
	a->baglam = a->dongu ? p_ctx_new(p_tl_get_loop(a->dongu), NULL, 0) : NULL;
	if (!a->baglam || p_tl_start(a->dongu) < 0) { snprintf(hata, n, "PipeWire döngüsü başlatılamadı"); return NULL; }
	p_tl_lock(a->dongu);
	a->cekirdek = p_connect_fd(a->baglam, fcntl(fd, F_DUPFD_CLOEXEC, 5), NULL, 0);
	if (!a->cekirdek) { p_tl_unlock(a->dongu); snprintf(hata, n, "PipeWire'a bağlanılamadı"); return NULL; }
	a->akis = p_stream_new(a->cekirdek, "Diszort ekran", p_props_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_MEDIA_ROLE, "Screen", NULL));
	if (!a->akis) { p_tl_unlock(a->dongu); snprintf(hata, n, "PipeWire akışı kurulamadı"); return NULL; }
	p_stream_add_listener(a->akis, &a->dinleyici, &pw_olaylar, a);
	uint8_t tampon[1024];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(tampon, sizeof(tampon));
	const struct spa_pod *p[1];
	struct spa_rectangle boy = SPA_RECTANGLE(1920, 1080), enaz = SPA_RECTANGLE(1, 1), encok = SPA_RECTANGLE(16384, 16384);
	struct spa_fraction hiz = SPA_FRACTION(kare, 1), hizEnaz = SPA_FRACTION(0, 1), hizEncok = SPA_FRACTION(240, 1);
	p[0] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
		SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
		SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
		SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRA, SPA_VIDEO_FORMAT_RGBx, SPA_VIDEO_FORMAT_RGBA),
		SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&boy, &enaz, &encok),
		SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&hiz, &hizEnaz, &hizEncok));
	int r = p_stream_connect(a->akis, PW_DIRECTION_INPUT, dugum, PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS, p, 1);
	p_tl_unlock(a->dongu);
	if (r < 0) { snprintf(hata, n, "PipeWire akışına bağlanılamadı (%d)", r); return NULL; }
	return a;
}

// pw_kilitle: son kareyi okumak için kilitle. Dönüş: 1 kare var, 0 henüz yok, -1 bitti.
static int pw_kilitle(pwa *a, uint8_t **veri, int *g, int *y, int *adim, int *rgb) {
	pthread_mutex_lock(&a->mu);
	if (a->bitti) return -1;
	if (!a->var) return 0;
	*veri = a->kare; *g = a->g; *y = a->y; *adim = a->adim;
	*rgb = a->bicim == SPA_VIDEO_FORMAT_RGBx || a->bicim == SPA_VIDEO_FORMAT_RGBA;
	return 1;
}
static void pw_birak(pwa *a) { pthread_mutex_unlock(&a->mu); }
static const char *pw_hata(pwa *a) { return a->hata; }

static void pw_kapat(pwa *a) {
	if (!a) return;
	if (a->dongu) p_tl_stop(a->dongu);
	if (a->akis) { p_stream_disconnect(a->akis); p_stream_destroy(a->akis); }
	if (a->cekirdek) p_core_disconnect(a->cekirdek);
	if (a->baglam) p_ctx_destroy(a->baglam);
	if (a->dongu) p_tl_destroy(a->dongu);
	free(a->kare);
	free(a);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"
	"unsafe"

	"github.com/godbus/dbus/v5"
)

type wayland struct {
	a        *C.pwa
	conn     *dbus.Conn
	oturum   dbus.ObjectPath
	belirtec string
	adi      string
	kilitli  bool
}

const portalAdi = "org.freedesktop.portal.Desktop"
const portalYolu = dbus.ObjectPath("/org/freedesktop/portal/desktop")
const ekranArayuzu = "org.freedesktop.portal.ScreenCast"

// portalIstegi: portal yöntemini çağır ve isteğin yanıtını (Response sinyali) bekle.
func portalIstegi(conn *dbus.Conn, metod string, sure time.Duration, secenek map[string]dbus.Variant, args ...any) (map[string]dbus.Variant, error) {
	belirtec := fmt.Sprintf("diszort%d", rand.Int63())
	secenek["handle_token"] = dbus.MakeVariant(belirtec)
	gonderen := strings.ReplaceAll(strings.TrimPrefix(conn.Names()[0], ":"), ".", "_")
	yol := dbus.ObjectPath("/org/freedesktop/portal/desktop/request/" + gonderen + "/" + belirtec)
	kural := []dbus.MatchOption{dbus.WithMatchObjectPath(yol), dbus.WithMatchInterface("org.freedesktop.portal.Request"), dbus.WithMatchMember("Response")}
	if err := conn.AddMatchSignal(kural...); err != nil {
		return nil, err
	}
	defer conn.RemoveMatchSignal(kural...)
	sinyaller := make(chan *dbus.Signal, 8)
	conn.Signal(sinyaller)
	defer conn.RemoveSignal(sinyaller)
	cagri := conn.Object(portalAdi, portalYolu).Call(ekranArayuzu+"."+metod, 0, append(args, secenek)...)
	if cagri.Err != nil {
		return nil, cagri.Err
	}
	zaman := time.After(sure)
	for {
		select {
		case s := <-sinyaller:
			if s.Path != yol || len(s.Body) < 2 {
				continue
			}
			kod, _ := s.Body[0].(uint32)
			sonuc, _ := s.Body[1].(map[string]dbus.Variant)
			switch kod {
			case 0:
				return sonuc, nil
			case 1:
				return nil, errors.New("ekran seçimi iptal edildi")
			default:
				return nil, errors.New("ekran paylaşımına izin verilmedi")
			}
		case <-zaman:
			return nil, errors.New("ekran seçimi zaman aşımına uğradı")
		}
	}
}

func waylandAc(s Secim) (*wayland, error) {
	var hata [200]C.char
	if C.pw_yukle(&hata[0], 200) != 0 {
		return nil, errors.New(C.GoString(&hata[0]) + " (Wayland'de ekran paylaşımı PipeWire ister)")
	}
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return nil, fmt.Errorf("oturum D-Bus'ına bağlanılamadı: %w", err)
	}
	w := &wayland{conn: conn}
	basarili := false
	defer func() {
		if !basarili {
			conn.Close()
		}
	}()
	nesne := conn.Object(portalAdi, portalYolu)
	surum := uint32(1)
	if v, err := nesne.GetProperty(ekranArayuzu + ".version"); err == nil {
		surum, _ = v.Value().(uint32)
	} else {
		return nil, errors.New("masaüstü portalında ekran paylaşımı yok (xdg-desktop-portal ve masaüstünüzün portal arka ucu kurulu mu?)")
	}
	imlecKipleri := uint32(0)
	if v, err := nesne.GetProperty(ekranArayuzu + ".AvailableCursorModes"); err == nil {
		imlecKipleri, _ = v.Value().(uint32)
	}
	sonuc, err := portalIstegi(conn, "CreateSession", 15*time.Second, map[string]dbus.Variant{"session_handle_token": dbus.MakeVariant(fmt.Sprintf("diszort%d", rand.Int63()))})
	if err != nil {
		return nil, fmt.Errorf("portal oturumu açılamadı: %w", err)
	}
	if v, ok := sonuc["session_handle"]; ok {
		if s, ok := v.Value().(string); ok {
			w.oturum = dbus.ObjectPath(s)
		} else if p, ok := v.Value().(dbus.ObjectPath); ok {
			w.oturum = p
		}
	}
	if w.oturum == "" {
		return nil, errors.New("portal oturum vermedi")
	}
	secenek := map[string]dbus.Variant{"types": dbus.MakeVariant(uint32(1 | 2)), "multiple": dbus.MakeVariant(false)}
	if imlecKipleri&2 != 0 {
		secenek["cursor_mode"] = dbus.MakeVariant(uint32(2)) // imleç görüntünün içinde
	}
	if surum >= 4 {
		secenek["persist_mode"] = dbus.MakeVariant(uint32(2)) // seçim, geri alınana kadar hatırlansın
		if s.IzinBelirteci != "" {
			secenek["restore_token"] = dbus.MakeVariant(s.IzinBelirteci)
		}
	}
	if _, err := portalIstegi(conn, "SelectSources", 15*time.Second, secenek, w.oturum); err != nil {
		return nil, fmt.Errorf("kaynak seçilemedi: %w", err)
	}
	sonuc, err = portalIstegi(conn, "Start", 3*time.Minute, map[string]dbus.Variant{}, w.oturum, "")
	if err != nil {
		return nil, err
	}
	var akislar []struct {
		Dugum      uint32
		Ozellikler map[string]dbus.Variant
	}
	if v, ok := sonuc["streams"]; ok {
		dbus.Store([]any{v.Value()}, &akislar)
	}
	if len(akislar) == 0 {
		return nil, errors.New("portal akış vermedi")
	}
	if v, ok := sonuc["restore_token"]; ok {
		w.belirtec, _ = v.Value().(string)
	}
	var fd dbus.UnixFD
	if err := nesne.Call(ekranArayuzu+".OpenPipeWireRemote", 0, w.oturum, map[string]dbus.Variant{}).Store(&fd); err != nil {
		return nil, fmt.Errorf("PipeWire bağlantısı alınamadı: %w", err)
	}
	a := C.pw_ac(C.int(fd), C.uint32_t(akislar[0].Dugum), C.int(max(1, s.Kare)), &hata[0], 200)
	closeFd(int(fd))
	if a == nil {
		return nil, errors.New(C.GoString(&hata[0]))
	}
	w.a = a
	w.adi = "Wayland (portal)"
	if v, ok := akislar[0].Ozellikler["size"]; ok {
		var boy struct{ G, Y int32 }
		if dbus.Store([]any{v.Value()}, &boy) == nil && boy.G > 0 {
			w.adi += fmt.Sprintf(" %d×%d", boy.G, boy.Y)
		}
	}
	basarili = true
	return w, nil
}

func (w *wayland) ad() string { return w.adi }

func (w *wayland) kare() ([]byte, int, int, int, bool, error) {
	var veri *C.uint8_t
	var g, y, adim, rgb C.int
	r := C.pw_kilitle(w.a, &veri, &g, &y, &adim, &rgb)
	w.kilitli = true
	switch r {
	case -1:
		h := C.GoString(C.pw_hata(w.a))
		w.birak()
		if h == "" {
			h = "ekran paylaşımı sistemden durduruldu"
		}
		return nil, 0, 0, 0, false, errors.New(h)
	case 0:
		w.birak()
		return nil, 0, 0, 0, false, errKareYok
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(veri)), int(adim)*int(y)), int(adim), int(g), int(y), rgb != 0, nil
}

func (w *wayland) birak() {
	if w.kilitli {
		w.kilitli = false
		C.pw_birak(w.a)
	}
}

func (w *wayland) kapat() {
	w.birak()
	C.pw_kapat(w.a)
	w.a = nil
	if w.oturum != "" {
		w.conn.Object(portalAdi, w.oturum).Call("org.freedesktop.portal.Session.Close", 0)
	}
	w.conn.Close()
}
