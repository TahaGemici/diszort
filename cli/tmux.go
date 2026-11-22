package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// tmuxAc: ./diszort --tmux: sohbet ve komut konsolu tmux'ta tek pencerede (üstte sohbet, altta
// komutlar). tmux'un içindeyken bu pencere bölünür; değilse "diszort" adlı bir oturum açılır (varsa
// ona bağlanılır). Bölmeler arası geçiş tmux'un kendi tuşuyla: Ctrl+B ve ok.
func tmuxAc(argv []string) error {
	tmux, err := exec.LookPath("tmux")
	if err != nil {
		return errors.New("tmux bulunamadı (ör. sudo apt install tmux). tmux'suz da olur: bir terminalde ./diszort, başka birinde ./diszort komut")
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
		if a != "--tmux" {
			arg = append(arg, a)
		}
	}
	ortam := tmuxOrtami()
	ana := ortam + kabukTirnak(program)
	for _, a := range arg {
		ana += " " + kabukTirnak(a)
	}
	konsol := ortam + kabukTirnak(program) + " komut"
	boy := []string{"-l", "30%"}
	if eskiTmux(tmux) {
		boy = []string{"-p", "30"}
	}
	if os.Getenv("TMUX") != "" {
		// tmux'un içinde: alta komut konsolu açılır, bu bölmede sohbet sürer.
		bol := append(append([]string{"split-window", "-d", "-v"}, boy...), konsol)
		if out, err := exec.Command(tmux, bol...).CombinedOutput(); err != nil {
			return fmt.Errorf("tmux bölünemedi: %v %s", err, strings.TrimSpace(string(out)))
		}
		return syscall.Exec(program, append([]string{program}, arg...), os.Environ())
	}
	if exec.Command(tmux, "has-session", "-t", "=diszort").Run() == nil {
		return syscall.Exec(tmux, []string{"tmux", "attach-session", "-t", "=diszort"}, os.Environ())
	}
	komut := append([]string{"tmux", "new-session", "-s", "diszort", "-n", "diszort", ana, ";", "split-window", "-d", "-v"}, boy...)
	komut = append(komut, konsol)
	return syscall.Exec(tmux, komut, os.Environ())
}

// tmuxOrtami: bölmelerdeki programa geçecek ortam: tmux sunucusu daha önce başka bir oturumdan
// başlatıldıysa onun ortamı (ör. WAYLAND_DISPLAY olmadan) kullanılmasın.
func tmuxOrtami() string {
	var b strings.Builder
	for _, ad := range []string{"DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
		"DBUS_SESSION_BUS_ADDRESS", "PULSE_SERVER", "PULSE_SINK", "PULSE_SOURCE", "PIPEWIRE_REMOTE", "LANG", "LC_ALL",
		"LC_CTYPE", "NO_COLOR", "DISZORT_AYAR", "DISZORT_GUNLUK"} {
		if v, ok := os.LookupEnv(ad); ok && v != "" {
			if b.Len() == 0 {
				b.WriteString("env ")
			}
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
