package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Ayar dosyası: programın yanındaki diszort.json (giriş anahtarı da içinde: yalnızca kullanıcıya
// açık, 0600). Başka bir yere bir şey yazılmaz.

type SesAyari struct {
	Mik        string `json:"mik"`      // ses sunucusundaki adı ("" = varsayılan)
	Hoparlor   string `json:"hoparlor"` // ("" = varsayılan)
	MikSeviye  int    `json:"mikSeviye"`
	Esik       int    `json:"esik"`     // % (0 = kapalı); dBFS = -60 + %/2
	Kalite     int    `json:"kalite"`   // mikrofonun Opus tavanı (kbps): 48, 96, 128
	YayinSes   int    `json:"yayinSes"` // paylaşılan sesin bit hızı (kbps)
	MikRed     bool   `json:"mikRed"`
	YayinRed   bool   `json:"yayinRed"`
	Sesler     bool   `json:"sesler"` // giriş/çıkış sesleri
	MikKapali  bool   `json:"mikKapali"`
	Sagir      bool   `json:"sagir"`
	YankiEngel bool   `json:"yankiEngel"`
	YayinAygit string `json:"yayinAygit"` // paylaşılan sesin aygıtı ("" = uygulamaların sesi)
	Kare       int    `json:"kare"`       // ekran paylaşımının kare hızı
}

type KisiAyari struct {
	Seviye      int  `json:"seviye"`
	Sustur      bool `json:"sustur,omitempty"`
	YayinSeviye int  `json:"yayinSeviye"`
	YayinSustur bool `json:"yayinSustur,omitempty"`
}

type PaylasilanDosya struct {
	ID    string `json:"id"`
	Yol   string `json:"yol"`
	Ad    string `json:"ad"`
	Boyut int64  `json:"boyut"`
	Tur   string `json:"tur"`
}

type Ayar struct {
	Sunucu        string                `json:"sunucu"`
	Anahtar       string                `json:"anahtar,omitempty"`
	Ad            string                `json:"ad,omitempty"`
	Kanal         string                `json:"kanal,omitempty"`
	Ses           SesAyari              `json:"ses"`
	Kisiler       map[string]*KisiAyari `json:"kisiler,omitempty"`
	Paylasilanlar []PaylasilanDosya     `json:"paylasilanlar,omitempty"`
	EkranIzni     string                `json:"ekranIzni,omitempty"` // Wayland ekran seçiminin hatırlanması

	yol string
}

var yayinSesSecenekleri = []int{320, 256, 192, 128, 96}

const redSiganHiz = 192

func varsayilanSes() SesAyari {
	return SesAyari{MikSeviye: 100, Esik: 10, Kalite: 96, YayinSes: 192, MikRed: true, YayinRed: true, Sesler: true, Kare: 30}
}

func ayarYolu() string {
	if y := os.Getenv("DISZORT_AYAR"); y != "" {
		return y
	}
	exe, err := os.Executable()
	if err != nil {
		return "diszort.json"
	}
	if gercek, err := filepath.EvalSymlinks(exe); err == nil {
		exe = gercek
	}
	return filepath.Join(filepath.Dir(exe), "diszort.json")
}

func ayarOku(yol string) (*Ayar, error) {
	a := &Ayar{Ses: varsayilanSes(), yol: yol, Kisiler: map[string]*KisiAyari{}}
	b, err := os.ReadFile(yol)
	if errors.Is(err, os.ErrNotExist) {
		return a, nil
	}
	if err != nil {
		return nil, err
	}
	var ham map[string]json.RawMessage
	if err := json.Unmarshal(b, &ham); err != nil {
		return nil, errors.New("ayar dosyası bozuk: " + err.Error())
	}
	if _, eski := ham["depo"]; eski {
		eskidenGecir(a, ham)
	} else if err := json.Unmarshal(b, a); err != nil {
		return nil, errors.New("ayar dosyası bozuk: " + err.Error())
	}
	if a.Kisiler == nil {
		a.Kisiler = map[string]*KisiAyari{}
	}
	a.duzelt()
	return a, nil
}

// eskidenGecir: önceki (web sayfasını çalıştıran) CLI'ın ayar dosyası: sayfanın localStorage'ı "depo".
func eskidenGecir(a *Ayar, ham map[string]json.RawMessage) {
	json.Unmarshal(ham["sunucu"], &a.Sunucu)
	depo := map[string]string{}
	json.Unmarshal(ham["depo"], &depo)
	a.Anahtar = depo["anahtar"]
	a.Ad = depo["ad"]
	a.Kanal = depo["kanal"]
	if s := depo["ses-ayarlari"]; s != "" {
		var e struct {
			MikID      *string `json:"mikId"`
			CikisID    *string `json:"cikisId"`
			MikSeviye  *int    `json:"mikSeviye"`
			Esik       *int    `json:"esik"`
			Kalite     *int    `json:"kalite"`
			YayinSes   *int    `json:"yayinSes"`
			MikRed     *bool   `json:"mikRed"`
			YayinRed   *bool   `json:"yayinRed"`
			Sesler     *bool   `json:"sesler"`
			MikKapali  *bool   `json:"mikKapali"`
			Sagir      *bool   `json:"sagir"`
			YankiEngel *bool   `json:"yankiEngel"`
		}
		if json.Unmarshal([]byte(s), &e) == nil {
			al := func(h *string, k *string) {
				if k != nil {
					*h = *k
				}
			}
			ali := func(h *int, k *int) {
				if k != nil {
					*h = *k
				}
			}
			alb := func(h *bool, k *bool) {
				if k != nil {
					*h = *k
				}
			}
			al(&a.Ses.Mik, e.MikID)
			al(&a.Ses.Hoparlor, e.CikisID)
			ali(&a.Ses.MikSeviye, e.MikSeviye)
			ali(&a.Ses.Esik, e.Esik)
			ali(&a.Ses.Kalite, e.Kalite)
			ali(&a.Ses.YayinSes, e.YayinSes)
			alb(&a.Ses.MikRed, e.MikRed)
			alb(&a.Ses.YayinRed, e.YayinRed)
			alb(&a.Ses.Sesler, e.Sesler)
			alb(&a.Ses.MikKapali, e.MikKapali)
			alb(&a.Ses.Sagir, e.Sagir)
			alb(&a.Ses.YankiEngel, e.YankiEngel)
		}
	}
	for k, v := range depo {
		for _, on := range []string{"ses-seviye-", "ses-sustur-", "yayin-seviye-", "yayin-sustur-"} {
			if !strings.HasPrefix(k, on) {
				continue
			}
			ad := strings.TrimPrefix(k, on)
			ka := a.kisi(ad)
			n, _ := strconv.Atoi(v)
			switch on {
			case "ses-seviye-":
				ka.Seviye = n
			case "ses-sustur-":
				ka.Sustur = v == "1"
			case "yayin-seviye-":
				ka.YayinSeviye = n
			case "yayin-sustur-":
				ka.YayinSustur = v == "1"
			}
		}
	}
}

func (a *Ayar) duzelt() {
	s := &a.Ses
	s.MikSeviye = min(200, max(0, (s.MikSeviye+2)/5*5))
	if s.Kalite != 48 && s.Kalite != 96 && s.Kalite != 128 {
		s.Kalite = 96
	}
	gecerli := false
	for _, v := range yayinSesSecenekleri {
		gecerli = gecerli || v == s.YayinSes
	}
	if !gecerli {
		s.YayinSes = 192
	}
	s.Esik = min(100, max(0, s.Esik))
	if s.Kare != 15 && s.Kare != 30 && s.Kare != 60 {
		s.Kare = 30
	}
	for _, k := range a.Kisiler {
		k.Seviye = min(100, max(0, k.Seviye))
		k.YayinSeviye = min(100, max(0, k.YayinSeviye))
	}
}

// kisi: o kişinin (yalnızca bende geçerli) ses ayarları.
func (a *Ayar) kisi(ad string) *KisiAyari {
	if a.Kisiler == nil {
		a.Kisiler = map[string]*KisiAyari{}
	}
	k := a.Kisiler[ad]
	if k == nil {
		k = &KisiAyari{Seviye: 100, YayinSeviye: 100}
		a.Kisiler[ad] = k
	}
	return k
}

// Kaydet: önce geçici dosyaya, sonra yerine (yarım dosya kalmasın).
func (a *Ayar) Kaydet() error {
	for ad, k := range a.Kisiler {
		if k.Seviye == 100 && !k.Sustur && k.YayinSeviye == 100 && !k.YayinSustur {
			delete(a.Kisiler, ad)
		}
	}
	b, err := json.MarshalIndent(a, "", "\t")
	if err != nil {
		return err
	}
	gecici := a.yol + ".yeni"
	if err := os.WriteFile(gecici, append(b, '\n'), 0o600); err != nil {
		return err
	}
	os.Chmod(gecici, 0o600)
	return os.Rename(gecici, a.yol)
}

// adresDuzelt: "chat.ornek.com" → "https://chat.ornek.com"; "#anahtar=…" korunur.
func adresDuzelt(girdi string) (koken, anahtar string, ok bool) {
	s := strings.TrimSpace(girdi)
	if s == "" {
		return "", "", false
	}
	if !strings.HasPrefix(strings.ToLower(s), "http://") && !strings.HasPrefix(strings.ToLower(s), "https://") {
		s = "https://" + s
	}
	parca := ""
	if i := strings.Index(s, "#"); i >= 0 {
		parca = s[i+1:]
		s = s[:i]
	}
	u, err := urlCoz(s)
	if err != nil || u.Host == "" {
		return "", "", false
	}
	for _, p := range strings.Split(parca, "&") {
		if strings.HasPrefix(p, "anahtar=") {
			anahtar = urlAc(strings.TrimPrefix(p, "anahtar="))
		}
	}
	return u.Scheme + "://" + u.Host, anahtar, true
}
