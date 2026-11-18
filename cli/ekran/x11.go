package ekran

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/shm"
	"github.com/jezek/xgb/xfixes"
	"github.com/jezek/xgb/xproto"
	"golang.org/x/sys/unix"
)

// X11'de ekran yakalama: X sunucusuyla doğrudan (saf Go, kitaplık yok). Görüntü paylaşımlı bellekten
// (MIT-SHM) okunur; yoksa soket üzerinden (yavaş). Fare imleci XFixes'ten alınıp kareye çizilir.
// Monitörler RandR'dan: varsayılan birincil monitör.

// Monitor: bir ekran.
type Monitor struct {
	No          int
	Ad          string
	X, Y, G, Y_ int
	Birincil    bool
}

func (m Monitor) String() string {
	b := ""
	if m.Birincil {
		b = " (birincil)"
	}
	return fmt.Sprintf("%d. %s %d×%d%s", m.No, m.Ad, m.G, m.Y_, b)
}

type x11 struct {
	c      *xgb.Conn
	kok    xproto.Window
	m      Monitor
	shmVar bool
	seg    shm.Seg
	bellek []byte
	imlec  bool
	adi    string
}

// xgb kendi günlüğünü stderr'e yazar (terminal arayüzünü bozar): susturulur.
func init() { xgb.Logger = log.New(io.Discard, "", 0) }

// X11Var: X sunucusu var mı (DISPLAY).
func X11Var() bool { return os.Getenv("DISPLAY") != "" }

func x11Monitorler(c *xgb.Conn, kok xproto.Window, ekran *xproto.ScreenInfo) []Monitor {
	var liste []Monitor
	if randr.Init(c) == nil {
		if _, err := randr.QueryVersion(c, 1, 5).Reply(); err == nil {
			if r, err := randr.GetMonitors(c, kok, true).Reply(); err == nil {
				for i, m := range r.Monitors {
					ad := fmt.Sprintf("Monitör %d", i+1)
					if a, err := xproto.GetAtomName(c, m.Name).Reply(); err == nil && a.Name != "" {
						ad = a.Name
					}
					liste = append(liste, Monitor{No: i + 1, Ad: ad, X: int(m.X), Y: int(m.Y), G: int(m.Width), Y_: int(m.Height), Birincil: m.Primary})
				}
			}
		}
	}
	if len(liste) == 0 {
		liste = []Monitor{{No: 1, Ad: "Ekran", G: int(ekran.WidthInPixels), Y_: int(ekran.HeightInPixels), Birincil: true}}
	}
	return liste
}

// X11Monitorler: paylaşılabilecek monitörler.
func X11Monitorler() ([]Monitor, error) {
	c, err := xgb.NewConn()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	ekran := xproto.Setup(c).DefaultScreen(c)
	return x11Monitorler(c, ekran.Root, ekran), nil
}

// x11Ac: no: monitör numarası (0 = birincil; -1 = bütün ekran).
func x11Ac(no int) (*x11, error) {
	c, err := xgb.NewConn()
	if err != nil {
		return nil, fmt.Errorf("X sunucusuna bağlanılamadı: %w", err)
	}
	kurulum := xproto.Setup(c)
	ekran := kurulum.DefaultScreen(c)
	derinlikTamam := false
	for _, b := range kurulum.PixmapFormats {
		if b.Depth == ekran.RootDepth && b.BitsPerPixel == 32 {
			derinlikTamam = true
		}
	}
	if !derinlikTamam || (ekran.RootDepth != 24 && ekran.RootDepth != 32) {
		c.Close()
		return nil, fmt.Errorf("desteklenmeyen renk derinliği (%d bit)", ekran.RootDepth)
	}
	x := &x11{c: c, kok: ekran.Root}
	monitorler := x11Monitorler(c, ekran.Root, ekran)
	switch {
	case no < 0:
		x.m = Monitor{No: 0, Ad: "Bütün ekran", G: int(ekran.WidthInPixels), Y_: int(ekran.HeightInPixels)}
	case no == 0:
		x.m = monitorler[0]
		for _, m := range monitorler {
			if m.Birincil {
				x.m = m
				break
			}
		}
	default:
		if no > len(monitorler) {
			c.Close()
			return nil, fmt.Errorf("%d numaralı monitör yok (%d monitör var)", no, len(monitorler))
		}
		x.m = monitorler[no-1]
	}
	if x.m.G <= 0 || x.m.Y_ <= 0 {
		c.Close()
		return nil, errors.New("ekran boyutu alınamadı")
	}
	x.shmKur()
	yol := "X11"
	if !x.shmVar {
		yol = "X11 (paylaşımlı bellek yok: yavaş)"
	}
	x.adi = fmt.Sprintf("%s · %s %d×%d", yol, x.m.Ad, x.m.G, x.m.Y_)
	if xfixes.Init(c) == nil {
		if _, err := xfixes.QueryVersion(c, 4, 0).Reply(); err == nil {
			x.imlec = true
		}
	}
	return x, nil
}

func (x *x11) shmKur() {
	if shm.Init(x.c) != nil {
		return
	}
	boy := x.m.G * x.m.Y_ * 4
	id, err := unix.SysvShmGet(unix.IPC_PRIVATE, boy, unix.IPC_CREAT|0o600)
	if err != nil {
		return
	}
	bellek, err := unix.SysvShmAttach(id, 0, 0)
	if err != nil {
		unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		return
	}
	seg, err := shm.NewSegId(x.c)
	if err == nil {
		err = shm.AttachChecked(x.c, seg, uint32(id), false).Check()
	}
	// İki taraf da bağlandı: bölüm, ikisi de bırakınca silinsin.
	unix.SysvShmCtl(id, unix.IPC_RMID, nil)
	if err != nil {
		unix.SysvShmDetach(bellek)
		return
	}
	x.seg, x.bellek, x.shmVar = seg, bellek, true
}

func (x *x11) ad() string { return x.adi }

func (x *x11) kare() ([]byte, int, int, int, bool, error) {
	g, y := x.m.G, x.m.Y_
	var veri []byte
	if x.shmVar {
		if _, err := shm.GetImage(x.c, xproto.Drawable(x.kok), int16(x.m.X), int16(x.m.Y), uint16(g), uint16(y), 0xffffffff, xproto.ImageFormatZPixmap, x.seg, 0).Reply(); err != nil {
			return nil, 0, 0, 0, false, fmt.Errorf("ekran yakalanamadı: %w", err)
		}
		veri = x.bellek[:g*y*4]
	} else {
		r, err := xproto.GetImage(x.c, xproto.ImageFormatZPixmap, xproto.Drawable(x.kok), int16(x.m.X), int16(x.m.Y), uint16(g), uint16(y), 0xffffffff).Reply()
		if err != nil {
			return nil, 0, 0, 0, false, fmt.Errorf("ekran yakalanamadı: %w", err)
		}
		veri = r.Data
	}
	if x.imlec {
		x.imlecCiz(veri, g*4)
	}
	return veri, g * 4, g, y, false, nil
}

// imlecCiz: fare imlecini (önceden çarpılmış ARGB) kareye karıştır.
func (x *x11) imlecCiz(veri []byte, adim int) {
	r, err := xfixes.GetCursorImage(x.c).Reply()
	if err != nil || r.Width == 0 || r.Height == 0 {
		return
	}
	ox := int(r.X) - int(r.Xhot) - x.m.X
	oy := int(r.Y) - int(r.Yhot) - x.m.Y
	w, h := int(r.Width), int(r.Height)
	for j := 0; j < h; j++ {
		py := oy + j
		if py < 0 || py >= x.m.Y_ {
			continue
		}
		for i := 0; i < w; i++ {
			px := ox + i
			if px < 0 || px >= x.m.G {
				continue
			}
			p := r.CursorImage[j*w+i]
			a := p >> 24
			if a == 0 {
				continue
			}
			o := py*adim + px*4
			ters := 255 - a
			veri[o] = byte(min(255, (p&0xff)+uint32(veri[o])*ters/255))
			veri[o+1] = byte(min(255, (p>>8&0xff)+uint32(veri[o+1])*ters/255))
			veri[o+2] = byte(min(255, (p>>16&0xff)+uint32(veri[o+2])*ters/255))
		}
	}
}

func (x *x11) birak() {}

func (x *x11) kapat() {
	if x.shmVar {
		shm.Detach(x.c, x.seg)
		unix.SysvShmDetach(x.bellek)
		x.shmVar = false
	}
	x.c.Close()
}
