// Diszort terminal istemcisi (CLI): tarayıcı açmadan Diszort. Tek dosya, kurulum yok; ayarlar
// programın yanındaki diszort.json'da. Web istemcisiyle aynı protokolü konuşur: yazılı ve sesli
// kanallar, RNNoise ve konuşma eşiği, kayıplara karşı yedek (RED), ekran ve ses paylaşımı, P2P
// dosya, giriş istekleri, beyaz liste, kanal ve sunucu yönetimi. Arayüz satır tabanlıdır: yazılan
// mesaj olarak gider, işler /komutlarla yapılır (fare yok). Başkalarının ekranı gösterilmez.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Derlemede verilir (-ldflags -X).
var (
	surum  = "yerel"
	commit = ""
	depo   = "TahaGemici/diszort"
)

func surumYazisi() string {
	if commit != "" {
		return fmt.Sprintf("Diszort %s (%s)", surum, commit)
	}
	return "Diszort " + surum
}

const yardimMetni = `%s — terminalden Diszort

  ./diszort                      ayar dosyasındaki sunucuya bağlanır (ilk açılışta adres sorulur)
  ./diszort https://sunucu/…     o sunucuya bağlanır (giriş bağlantısı, #anahtar=… da olur)
  ./diszort --guncelle           son sürüme günceller
  ./diszort --surum              sürümü yazar

Ayarlar: %s
Program içinde /yardım komutların listesini verir. Kısayollar: Alt+M mikrofon, Alt+D sağırlaştır,
Tab tamamlar, ↑/↓ önceki satırlar, Ctrl+C (boş satırda) çıkar.
`

func main() {
	argv := os.Args[1:]
	bayrak := func(adlar ...string) bool {
		for _, a := range argv {
			for _, ad := range adlar {
				if a == ad {
					return true
				}
			}
		}
		return false
	}
	ayarDosyasi := ayarYolu()
	switch {
	case bayrak("--surum", "-v", "--version"):
		fmt.Println(surumYazisi())
		return
	case bayrak("--yardim", "-h", "--help"):
		fmt.Printf(yardimMetni, surumYazisi(), ayarDosyasi)
		return
	case bayrak("--guncelle"):
		yeni, err := guncelle(func(m string) { fmt.Println(m) })
		if err != nil {
			fmt.Fprintln(os.Stderr, "Güncellenemedi:", err)
			os.Exit(1)
		}
		if yeni == "" {
			fmt.Println("Zaten son sürüm:", surum)
		} else {
			fmt.Println("Güncellendi:", yeni)
		}
		return
	}
	if runtime.GOOS != "linux" {
		fmt.Fprintln(os.Stderr, "Diszort CLI yalnızca Linux'ta çalışır.")
		os.Exit(1)
	}
	if err := calistir(argv, ayarDosyasi); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func calistir(argv []string, ayarDosyasi string) error {
	ayar, err := ayarOku(ayarDosyasi)
	if err != nil {
		return fmt.Errorf("ayar dosyası okunamadı (%s): %w", ayarDosyasi, err)
	}
	var adresArg string
	for _, a := range argv {
		if !strings.HasPrefix(a, "-") {
			adresArg = a
			break
		}
	}
	betik := os.Getenv("DISZORT_BETIK") == "1" || !terminalMi()
	sunucu, anahtar := ayar.Sunucu, ""
	if adresArg != "" {
		k, an, ok := adresDuzelt(adresArg)
		if !ok {
			return errors.New("geçersiz sunucu adresi: " + adresArg)
		}
		sunucu, anahtar = k, an
	}
	if sunucu == "" {
		if betik {
			return errors.New("sunucu adresi verilmeli: ./diszort https://sunucu")
		}
		fmt.Println("Diszort — ilk açılış.\nSunucunun adresini ya da sana verilen giriş bağlantısını yapıştır (ör. https://chat.ornek.com).")
		satir, err := satirOku("Adres: ")
		if err != nil {
			return err
		}
		k, an, ok := adresDuzelt(satir)
		if !ok {
			return errors.New("adres verilmedi")
		}
		sunucu, anahtar = k, an
	}
	k, _, _ := adresDuzelt(ayar.Sunucu)
	if k != sunucu {
		// Başka bir sunucu: eski sunucunun anahtarı ve kişileri taşınmaz.
		ayar.Anahtar, ayar.Ad, ayar.Kanal, ayar.Paylasilanlar = "", "", "", nil
	}
	ayar.Sunucu = sunucu
	if anahtar != "" {
		ayar.Anahtar = anahtar
	}
	if err := ayar.Kaydet(); err != nil {
		return fmt.Errorf("ayar dosyası yazılamıyor (%s): %w\nProgramı yazabildiğin bir klasöre taşı (ayarlar programın yanında tutulur)", ayarDosyasi, err)
	}
	u := yeniUygulama(ayar, betik)
	return u.Calis()
}

// ---------------------------------------------------------------- güncelleme

type surumBilgisi struct {
	Surum  string            `json:"surum"`
	Commit string            `json:"commit"`
	Sha256 map[string]string `json:"sha256"`
}

func sonSurum() (*surumBilgisi, error) {
	if depo == "" || surum == "yerel" {
		return nil, errors.New("geliştirme kopyası güncellenmez (git pull)")
	}
	ist := &http.Client{Timeout: 15 * time.Second}
	y, err := ist.Get("https://github.com/" + depo + "/releases/latest/download/surum.json")
	if err != nil {
		return nil, err
	}
	defer y.Body.Close()
	if y.StatusCode != 200 {
		return nil, fmt.Errorf("sürüm bilgisi alınamadı (HTTP %d)", y.StatusCode)
	}
	var s surumBilgisi
	if err := json.NewDecoder(io.LimitReader(y.Body, 1<<16)).Decode(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

func yeniMi(s *surumBilgisi) bool { return s != nil && s.Commit != "" && s.Commit != commit }

func varlikAdi() string {
	if runtime.GOARCH == "arm64" {
		return "diszort-linux-arm64"
	}
	return "diszort-linux-x64"
}

// guncelle: programı son sürümle değiştir. Dönüş: yeni sürümün adı ("" = zaten son sürüm).
func guncelle(bildir func(string)) (string, error) {
	s, err := sonSurum()
	if err != nil {
		return "", err
	}
	if !yeniMi(s) {
		return "", nil
	}
	ad := varlikAdi()
	bildir("İndiriliyor: " + s.Surum + "…")
	ist := &http.Client{Timeout: 10 * time.Minute}
	y, err := ist.Get("https://github.com/" + depo + "/releases/latest/download/" + ad)
	if err != nil {
		return "", err
	}
	defer y.Body.Close()
	if y.StatusCode != 200 {
		return "", fmt.Errorf("indirilemedi (HTTP %d)", y.StatusCode)
	}
	program, err := os.Executable()
	if err != nil {
		return "", err
	}
	if g, err := filepath.EvalSymlinks(program); err == nil {
		program = g
	}
	gecici := filepath.Join(filepath.Dir(program), ".diszort.yeni")
	f, err := os.OpenFile(gecici, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), y.Body)
	f.Close()
	if err != nil {
		os.Remove(gecici)
		return "", err
	}
	if beklenen := s.Sha256[ad]; beklenen != "" && beklenen != hex.EncodeToString(h.Sum(nil)) {
		os.Remove(gecici)
		return "", errors.New("indirilen dosyanın özeti tutmuyor; güncellenmedi")
	}
	if err := os.Rename(gecici, program); err != nil {
		os.Remove(gecici)
		return "", err
	}
	return s.Surum, nil
}

// yenidenBaslat: güncellenen programı aynı terminalde, aynı argümanlarla yeniden başlat.
func yenidenBaslat() error {
	program, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(program, append([]string{program}, os.Args[1:]...), os.Environ())
}

// ---------------------------------------------------------------- küçük yardımcılar

func urlCoz(s string) (*url.URL, error) { return url.Parse(s) }

func urlAc(s string) string {
	if v, err := url.QueryUnescape(s); err == nil {
		return v
	}
	return s
}
