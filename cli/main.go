// Diszort terminal istemcisi (CLI): tarayıcı açmadan Diszort. Tek dosya, kurulum yok; ayarlar
// programın yanındaki diszort.json'da. Web istemcisiyle aynı protokolü konuşur: yazılı ve sesli
// kanallar, RNNoise ve konuşma eşiği, kayıplara karşı yedek (RED), ekran ve ses paylaşımı, P2P
// dosya, giriş istekleri, beyaz liste, kanal ve sunucu yönetimi. Fare yok; başkalarının ekranı
// gösterilmez. ./diszort tmux'ta iki bölme açar: solda sohbet (yazılan mesaj olarak gider), sağda
// komut konsolu (tmux.go). Açılışta yeni sürüm varsa kendini günceller. Terminal değilken (betik,
// deneme) satır satır okur ve yazar.
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
	"runtime/pprof"
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

  ./diszort                      tmux'ta açılır: solda sohbet (yazdığın mesaj olarak gider), sağda
                                 komutlar; ayar dosyasındaki sunucuya bağlanır (ilk açılışta sorulur)
  ./diszort https://sunucu/…     o sunucuya bağlanır (giriş bağlantısı, #anahtar=… da olur)
  ./diszort --guncelle           son sürüme günceller (açılışta zaten kendiliğinden güncellenir)
  ./diszort --surum              sürümü yazar

tmux gerekir (sudo apt install tmux). Ayarlar: %s
Bölmeler arası Alt+←/→. Komut bölmesinde "yardım" komutları listeler. Sohbette: Alt+↑/↓ kanal,
↑/↓ ve PgUp/PgDn kaydır, Esc en alta, Alt+M mikrofon, Alt+D sağırlaştır. Ctrl+C: hepsini kapatır.
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
	case len(argv) > 0 && argv[0] == "komut":
		// tmux'taki komut bölmesi (başlatıcı açar; elle de açılabilir).
		if err := konsolIstemcisi(ayarDosyasi); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	case bayrak("--surum", "-v", "--version"):
		fmt.Println(surumYazisi())
		return
	case bayrak("--yardim", "-h", "--help"):
		fmt.Printf(yardimMetni, surumYazisi(), ayarDosyasi)
		return
	case bayrak("--guncelle"):
		yeni, err := guncelle(nil, func(m string) { fmt.Println(m) })
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
	// Az iş parçacığı: goroutine'ler çoğunlukla bekler; çok çekirdekte boşuna dönen iş parçacıkları
	// (zamanlayıcı) işlemci harcamasın. Ekran kodlayıcısının kendi (C) iş parçacıkları bundan etkilenmez.
	runtime.GOMAXPROCS(min(2, runtime.NumCPU()))
	if runtime.GOOS != "linux" {
		fmt.Fprintln(os.Stderr, "Diszort CLI yalnızca Linux'ta çalışır.")
		os.Exit(1)
	}
	betik := os.Getenv("DISZORT_BETIK") == "1" || !terminalMi()
	if !betik && !bolmede() {
		// Kullanıcının açtığı ./diszort: tmux'ta iki bölme (başarıda buraya dönülmez).
		if err := baslat(argv, ayarDosyasi); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	// Geliştirme: işlemci profili (DISZORT_PROFIL=dosya).
	if y := os.Getenv("DISZORT_PROFIL"); y != "" {
		if f, err := os.Create(y); err == nil {
			pprof.StartCPUProfile(f)
			defer pprof.StopCPUProfile()
		}
	}
	err := calistir(argv, ayarDosyasi, betik)
	if errors.Is(err, errYenidenBaslat) {
		pprof.StopCPUProfile()
		err = yenidenBaslat()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if bolmede() {
			// Bölme kapanınca hata görünmez kalmasın.
			satirOku("\nKapatmak için Enter… ")
		}
	}
	if bolmede() {
		tmuxKapat()
	}
	if err != nil {
		os.Exit(1)
	}
}

// errYenidenBaslat: /güncelle: program yeni sürümle aynı terminalde yeniden başlar.
var errYenidenBaslat = errors.New("yeniden başlatılacak")

func calistir(argv []string, ayarDosyasi string, betik bool) error {
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
	tamEkran := !betik
	// Komut konsolunun soketi: aynı ayar dosyasıyla açık bir Diszort varsa ikincisi açılmaz (ayar
	// dosyasına da dokunulmaz).
	dinleyici, err := konsolDinle(konsolAdi(ayarDosyasi))
	if errors.Is(err, errZatenAcik) {
		return errors.New("Diszort bu klasörde zaten açık")
	}
	if err != nil {
		if tamEkran {
			return fmt.Errorf("komut konsolunun soketi açılamadı: %w", err)
		}
		dinleyici = nil
	}
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
	u := yeniUygulama(ayar, betik, tamEkran, dinleyici)
	return u.Calis()
}

// ---------------------------------------------------------------- güncelleme

type surumBilgisi struct {
	Surum  string            `json:"surum"`
	Commit string            `json:"commit"`
	Sha256 map[string]string `json:"sha256"`
}

// indirmeAdresi: son sürümün dosyaları (DISZORT_INDIRME: başka bir yansı ya da deneme sunucusu).
func indirmeAdresi() string {
	if a := os.Getenv("DISZORT_INDIRME"); a != "" {
		return strings.TrimRight(a, "/")
	}
	return "https://github.com/" + depo + "/releases/latest/download"
}

func sonSurum() (*surumBilgisi, error) { return sonSurumSureli(15 * time.Second) }

func sonSurumSureli(sure time.Duration) (*surumBilgisi, error) {
	if depo == "" || surum == "yerel" {
		return nil, errors.New("geliştirme kopyası güncellenmez (git pull)")
	}
	ist := &http.Client{Timeout: sure}
	y, err := ist.Get(indirmeAdresi() + "/surum.json")
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

// guncelle: programı son sürümle değiştir (s: önceden alınmış sürüm bilgisi; nil: şimdi sorulur).
// Dönüş: yeni sürümün adı ("" = zaten son sürüm).
func guncelle(s *surumBilgisi, bildir func(string)) (string, error) {
	if s == nil {
		var err error
		if s, err = sonSurum(); err != nil {
			return "", err
		}
	}
	if !yeniMi(s) {
		return "", nil
	}
	program, err := os.Executable()
	if err != nil {
		return "", err
	}
	if g, err := filepath.EvalSymlinks(program); err == nil {
		program = g
	}
	if err := dosyayiGuncelle(s, program, bildir); err != nil {
		return "", err
	}
	return s.Surum, nil
}

// dosyayiGuncelle: sürümün dosyasını indir, özetini denetle, program dosyasının yerine koy (yarım
// kalırsa eski dosya yerinde kalır).
func dosyayiGuncelle(s *surumBilgisi, program string, bildir func(string)) error {
	ad := varlikAdi()
	if s.Sha256[ad] == "" {
		return errors.New("sürüm bilgisinde dosyanın özeti yok; güncellenmedi")
	}
	bildir("İndiriliyor: " + s.Surum + "…")
	ist := &http.Client{Timeout: 10 * time.Minute}
	y, err := ist.Get(indirmeAdresi() + "/" + ad)
	if err != nil {
		return err
	}
	defer y.Body.Close()
	if y.StatusCode != 200 {
		return fmt.Errorf("indirilemedi (HTTP %d)", y.StatusCode)
	}
	gecici := filepath.Join(filepath.Dir(program), ".diszort.yeni")
	f, err := os.OpenFile(gecici, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), y.Body)
	f.Close()
	if err != nil {
		os.Remove(gecici)
		return err
	}
	if beklenen := s.Sha256[ad]; beklenen != hex.EncodeToString(h.Sum(nil)) {
		os.Remove(gecici)
		return errors.New("indirilen dosyanın özeti tutmuyor; güncellenmedi")
	}
	if err := os.Rename(gecici, program); err != nil {
		os.Remove(gecici)
		return err
	}
	return nil
}

// yenidenBaslat: güncellenen programı aynı terminalde, aynı argümanlarla yeniden başlat. Yeni süreç
// açılışta yeniden güncellemeye bakmaz (bir şey ters giderse döngüye girmesin).
func yenidenBaslat() error {
	program, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(program, append([]string{program}, os.Args[1:]...), append(os.Environ(), "DISZORT_GUNCELLENDI=1"))
}

// acilistaGuncelle: başlatıcıda, tmux açılmadan: yeni sürüm yayınlandıysa indirir, özetini denetler,
// kendini değiştirip yeniden başlar (başarıda geri dönmez). Ağ yoksa ya da bir şey ters giderse eski
// sürümle açılır. Kapatmak: komut bölmesinde "ayar güncelleme kapalı" (ya da DISZORT_GUNCELLEME=0).
func acilistaGuncelle(ayar *Ayar) {
	if surum == "yerel" || depo == "" || os.Getenv("DISZORT_GUNCELLEME") == "0" || os.Getenv("DISZORT_GUNCELLENDI") == "1" ||
		(ayar != nil && ayar.OtoGuncellemeKapali) {
		return
	}
	s, err := sonSurumSureli(5 * time.Second)
	if err != nil || !yeniMi(s) {
		return
	}
	fmt.Printf("Diszort güncelleniyor: %s → %s\n", surum, s.Surum)
	if _, err := guncelle(s, func(m string) { fmt.Println(m) }); err != nil {
		fmt.Fprintln(os.Stderr, "Güncellenemedi ("+err.Error()+"); bu sürümle açılıyor.")
		return
	}
	if err := yenidenBaslat(); err != nil {
		fmt.Fprintln(os.Stderr, "Yeniden başlatılamadı:", err)
	}
}

// ---------------------------------------------------------------- küçük yardımcılar

func urlCoz(s string) (*url.URL, error) { return url.Parse(s) }

func urlAc(s string) string {
	if v, err := url.QueryUnescape(s); err == nil {
		return v
	}
	return s
}
