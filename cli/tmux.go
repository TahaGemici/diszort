package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Başlatıcı: kullanıcının açtığı ./diszort sohbeti (solda) ve komut konsolunu (sağda) tmux'ta yan yana
// açar. Diszort'un kendi tmux sunucusu kullanılır (-L diszort, kendi ayarlarıyla): kullanıcının tmux'u
// ve ayarları etkilenmez. Bölmeler arası Alt+←/→; pencere kapanınca (tmux'tan ayrılınca) Diszort da
// kapanır. Kullanıcı zaten tmux'un içindeyse onun penceresi yan yana bölünür.
//
// Bölmelerdeki programlar ortamdan ne olduklarını bilir: DISZORT_BOLME=sohbet|komut, DISZORT_TMUX=
// ozel (Diszort'un tmux'u) | kullanici (kullanıcının tmux'u; DISZORT_KONSOL_BOLMESI: konsolun bölmesi).

const (
	tmuxSunucu = "diszort"
	tmuxOturum = "diszort"
)

var errTmuxYok = errors.New(`tmux bulunamadı. Diszort sohbeti ve komutları tmux'ta yan yana açar; kur:
  sudo apt install tmux        (Fedora: sudo dnf install tmux · Arch: sudo pacman -S tmux)`)

// bolmede: bu süreç tmux'taki sohbet bölmesi mi.
func bolmede() bool { return os.Getenv("DISZORT_BOLME") == "sohbet" }

// baslat: tmux yoksa hata; Diszort zaten açıksa ona bağlanır; değilse (açılışta yeni sürüm varsa
// önce güncellenip yeniden başlar) iki bölmeyi açar. Başarıda geri dönmez (tmux'a geçilir).
func baslat(argv []string, ayarDosyasi string) error {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		return errTmuxYok
	}
	program, err := os.Executable()
	if err != nil {
		return err
	}
	if g, err := filepath.EvalSymlinks(program); err == nil {
		program = g
	}
	var arg []string
	for _, a := range argv {
		if strings.HasPrefix(a, "-") {
			return fmt.Errorf("bilinmeyen seçenek: %s (./diszort --yardim)", a)
		}
		if _, _, ok := adresDuzelt(a); !ok {
			return errors.New("geçersiz sunucu adresi: " + a)
		}
		arg = append(arg, a)
	}
	// Zaten açık mı (aynı klasördeki program)? Diszort'un tmux'undaysa ona bağlan.
	if acikMi(ayarDosyasi) {
		if os.Getenv("TMUX") == "" && tmuxKomutu(tmux, "has-session", "-t", "="+tmuxOturum).Run() == nil {
			if len(arg) > 0 {
				fmt.Println("Diszort zaten açık; verilen adres kullanılmadı.")
			}
			return syscall.Exec(tmux, append([]string{"tmux"}, tmuxArgumanlari("attach-session", "-t", "="+tmuxOturum)...), os.Environ())
		}
		return errors.New("Diszort bu klasörde zaten açık (başka bir terminalde ya da tmux penceresinde)")
	}
	ayar, _ := ayarOku(ayarDosyasi)
	acilistaGuncelle(ayar)

	// bolmeKomutu: tmux'un bölmede (sh -c ile) çalıştıracağı satır: ortam + program + argümanlar.
	bolmeKomutu := func(ek []string, argumanlar ...string) string {
		var b strings.Builder
		b.WriteString(tmuxOrtami())
		for _, e := range ek {
			ad, deger, _ := strings.Cut(e, "=")
			b.WriteString(ad + "=" + kabukTirnak(deger) + " ")
		}
		b.WriteString(kabukTirnak(program))
		for _, a := range argumanlar {
			b.WriteString(" " + kabukTirnak(a))
		}
		return b.String()
	}
	boy := []string{"-l", "35%"}
	if eskiTmux(tmux) {
		boy = []string{"-p", "35"}
	}
	if os.Getenv("TMUX") != "" {
		// Kullanıcının tmux'u: sağa komut konsolu açılır, bu bölmede sohbet sürer.
		konsol := bolmeKomutu([]string{"DISZORT_BOLME=komut", "DISZORT_TMUX=kullanici"}, "komut")
		bol := append(append([]string{"split-window", "-h", "-d", "-P", "-F", "#{pane_id}"}, boy...), konsol)
		out, err := exec.Command(tmux, bol...).Output()
		if err != nil {
			return fmt.Errorf("tmux bölünemedi: %v", err)
		}
		ek := []string{"DISZORT_BOLME=sohbet", "DISZORT_TMUX=kullanici", "DISZORT_KONSOL_BOLMESI=" + strings.TrimSpace(string(out))}
		return syscall.Exec(program, append([]string{program}, arg...), append(os.Environ(), ek...))
	}
	sohbet := bolmeKomutu([]string{"DISZORT_BOLME=sohbet", "DISZORT_TMUX=ozel"}, arg...)
	konsol := bolmeKomutu([]string{"DISZORT_BOLME=komut", "DISZORT_TMUX=ozel"}, "komut")
	k := tmuxArgumanlari("start-server", ";",
		"set-option", "-s", "escape-time", "10", ";", // Esc beklemesin
		"set-option", "-g", "default-terminal", "screen-256color", ";",
		"set-option", "-g", "status", "off", ";", // tmux'un alt çubuğu gerekmez
		"set-option", "-g", "destroy-unattached", "on", ";", // pencere kapanınca Diszort da kapansın
		"set-option", "-g", "set-titles", "on", ";",
		"set-option", "-g", "set-titles-string", "Diszort", ";",
		"bind-key", "-n", "M-Left", "select-pane", "-L", ";",
		"bind-key", "-n", "M-Right", "select-pane", "-R", ";",
		"new-session", "-s", tmuxOturum, "-n", "diszort", sohbet, ";",
	)
	k = append(k, append(append([]string{"split-window", "-h", "-d"}, boy...), konsol)...)
	return syscall.Exec(tmux, append([]string{"tmux"}, k...), os.Environ())
}

// tmuxArgumanlari: Diszort'un tmux sunucusu (kendi soketi; kullanıcının ayar dosyası okunmaz).
func tmuxArgumanlari(k ...string) []string {
	return append([]string{"-L", tmuxSunucu, "-f", "/dev/null"}, k...)
}

func tmuxKomutu(tmux string, k ...string) *exec.Cmd {
	return exec.Command(tmux, tmuxArgumanlari(k...)...)
}

// acikMi: aynı ayar dosyasıyla açık bir Diszort var mı (komut konsolunun soketine bağlanılabiliyor mu).
func acikMi(ayarDosyasi string) bool {
	c, err := net.DialUnix("unix", nil, konsolAdresi(konsolAdi(ayarDosyasi)))
	if err != nil {
		return false
	}
	defer c.Close()
	uid, err := karsiKullanici(c)
	return err == nil && uid == os.Getuid()
}

// tmuxKapat: sohbet bitince: Diszort'un tmux'undaysa oturum (iki bölme de) kapanır; kullanıcının
// tmux'undaysa yalnızca komut konsolunun bölmesi (sohbetin bölmesinde kullanıcının kabuğu kalır).
func tmuxKapat() {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		return
	}
	switch os.Getenv("DISZORT_TMUX") {
	case "ozel":
		tmuxKomutu(tmux, "kill-session", "-t", "="+tmuxOturum).Run()
	case "kullanici":
		if b := os.Getenv("DISZORT_KONSOL_BOLMESI"); strings.HasPrefix(b, "%") {
			exec.Command(tmux, "kill-pane", "-t", b).Run()
		}
	}
}

// tmuxOrtami: bölmelerdeki programa geçecek ortam: tmux sunucusu başka bir oturumdan başlatılmışsa
// onun ortamı (ör. WAYLAND_DISPLAY olmadan) kullanılmasın.
func tmuxOrtami() string {
	var b strings.Builder
	b.WriteString("env ")
	for _, ad := range []string{"DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
		"DBUS_SESSION_BUS_ADDRESS", "PULSE_SERVER", "PULSE_SINK", "PULSE_SOURCE", "PIPEWIRE_REMOTE", "LANG", "LC_ALL",
		"LC_CTYPE", "NO_COLOR", "COLORTERM", "DISZORT_AYAR", "DISZORT_GUNLUK", "HOME"} {
		if v, ok := os.LookupEnv(ad); ok && v != "" {
			b.WriteString(ad + "=" + kabukTirnak(v) + " ")
		}
	}
	return b.String()
}

func kabukTirnak(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// eskiTmux: 3.1'den eski tmux bölme boyunu yüzdeyle -l'de değil -p'de alır.
func eskiTmux(tmux string) bool {
	out, err := exec.Command(tmux, "-V").Output()
	if err != nil {
		return false
	}
	var ana, alt int
	if _, err := fmt.Sscanf(strings.TrimPrefix(strings.TrimSpace(string(out)), "tmux "), "%d.%d", &ana, &alt); err != nil {
		return false
	}
	return ana < 3 || (ana == 3 && alt < 1)
}
