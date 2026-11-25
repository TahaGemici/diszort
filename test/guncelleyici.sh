#!/bin/sh
# Sunucunun otomatik güncelleyicisi (kur.sh yazar): betik ve systemd birimleri geçerli mi; hangi
# durumda güncelleyip hangisinde dokunmadığı. Docker yerine sahte bir docker, GitHub ve sunucunun
# /saglik'i yerine yerel bir HTTP sunucusu kullanılır; kur.sh yerine işaret bırakan bir betik iner.
#   sh test/guncelleyici.sh
set -eu
KOK=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
HTTP_PID=
trap 'kill $HTTP_PID 2>/dev/null || true; rm -rf "$T"' EXIT INT TERM

KUR_KUTUPHANE=1 . "$KOK/kurulum/kur.sh"
DEPO=deneme/diszort
guncelleyici_yaz "$T/guncelle"
mkdir -p "$T/birim"
birimleri_yaz "$T/birim" "$T/guncelle"
sh -n "$T/guncelle"
head -n 4 "$T/guncelle" | grep -q "^DEPO='deneme/diszort'$"
grep -q "^ExecStart=$T/guncelle$" "$T/birim/diszort-guncelle.service"
if command -v systemd-analyze >/dev/null 2>&1; then
	systemd-analyze verify "$T/birim/diszort-guncelle.service" "$T/birim/diszort-guncelle.timer"
	echo "ok   systemd birimleri geçerli (systemd-analyze verify)"
fi
echo "ok   güncelleyici betiği yazıldı, sözdizimi tamam"

# Sahte docker: "inspect" konteynerin çalışıp çalışmadığını DOCKER_CALISIYOR'dan söyler.
mkdir -p "$T/bin" "$T/veri" "$T/www/indir"
cat >"$T/bin/docker" <<'DOCKER'
#!/bin/sh
[ "$1" = inspect ] && echo "${DOCKER_CALISIYOR:-true}"
DOCKER
chmod +x "$T/bin/docker"
# İnen "kur.sh": çalıştığını işaretler.
printf '#!/bin/sh\ntouch "%s/kur-calisti"\n' "$T" >"$T/www/indir/kur.sh"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
(cd "$T/www" && exec python3 -m http.server "$PORT" --bind 127.0.0.1) >/dev/null 2>&1 &
HTTP_PID=$!
i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$PORT/indir/kur.sh" 2>/dev/null; do
	i=$((i + 1))
	[ "$i" -lt 50 ] || { echo "HATA yerel HTTP sunucusu açılmadı"; exit 1; }
	sleep 0.1
done

calis() {
	rm -f "$T/kur-calisti"
	PATH="$T/bin:$PATH" DISZORT_VERI="$T/veri" DISZORT_INDIRME="http://127.0.0.1:$PORT/indir" DISZORT_KILIT="$T/kilit" \
		sh "$T/guncelle" 2>&1
}
durum() { # $1: çalışan sürüm, $2: sesli kanaldaki kişi
	printf '{"durum":"tamam","surum":"%s","kisi":%s,"cevrimici":0}\n' "$1" "$2" >"$T/www/saglik"
}
son() { printf '{\n\t"surum": "%s",\n\t"commit": "%s",\n\t"sha256": {}\n}\n' "$1" "$2" >"$T/www/indir/surum.json"; }
ayarlar() { printf 'PORT=%s\nOTOMATIK_GUNCELLEME=%s\n' "$PORT" "${1:-1}" >"$T/veri/.env"; }
basarisiz=0
bekle() { # $1: açıklama, $2: kur.sh çalışmalı mı (1/0), $3: çıktıda aranacak (isteğe bağlı)
	cikti=$(calis)
	calisti=0
	[ -f "$T/kur-calisti" ] && calisti=1
	if [ "$calisti" = "$2" ] && { [ -z "${3:-}" ] || printf '%s' "$cikti" | grep -q "$3"; }; then
		echo "ok   $1"
	else
		echo "HATA $1 (kur.sh çalıştı mı: $calisti, beklenen $2; çıktı: $cikti)"
		basarisiz=1
	fi
}

ayarlar 1
son v26.11.25 bbbbbbb
durum v26.11.24-aaaaaaa 0
bekle "yeni sürüm, sesli kanal boş: günceller" 1 "güncelleniyor: v26.11.24-aaaaaaa -> v26.11.25-bbbbbbb"
durum v26.11.25-bbbbbbb 0
bekle "zaten son sürüm: dokunmaz" 0
son v26.11.25 ccccccc
bekle "aynı gün yeniden yayınlanan sürüm (commit farklı): günceller" 1
durum v26.11.24-aaaaaaa 3
bekle "sesli kanalda 3 kişi varken güncellemez" 0 "sesli kanalda 3 kişi"
durum v26.11.24-aaaaaaa 0
ayarlar 0
bekle "OTOMATIK_GUNCELLEME=0 iken güncellemez" 0 "kapalı"
ayarlar 1
DOCKER_CALISIYOR=false
export DOCKER_CALISIYOR
bekle "elle durdurulmuş konteynere dokunmaz" 0 "konteyner çalışmıyor"
DOCKER_CALISIYOR=true
rm -f "$T/www/saglik"
bekle "sunucu yanıt vermezken dokunmaz" 0 "yanıt vermiyor"
durum v26.11.24-aaaaaaa 0
rm -f "$T/www/indir/surum.json"
bekle "son sürüm bilgisi alınamazsa dokunmaz" 0 "alınamadı"
son v26.11.25 bbbbbbb
# Aynı anda ikinci güncelleyici: kilit tutuluyken hemen çıkar.
exec 8>"$T/kilit"
flock -n 8
bekle "biri çalışırken ikincisi beklemeden çıkar" 0
flock -u 8

[ "$basarisiz" = 0 ] && echo "Otomatik güncelleyici denemeleri geçti." || { echo "Otomatik güncelleyici denemeleri BAŞARISIZ."; exit 1; }
