#!/bin/sh
# Diszort'u Docker konteyneri olarak kurar, başlatır ve günceller. Hepsi aynı komut:
#
#   curl -fsSL https://github.com/TahaGemici/diszort/releases/latest/download/kur.sh | sudo sh
#
# İmajı ghcr.io'dan çeker (GitHub Actions her push'ta yayınlar), ayarları korur ve konteyneri açar.
#   ... | sudo sh -s v42                    belirli bir sürüme dön (imaj etiketi)
#   sudo IMAJ=<imaj>:<etiket> sh kur.sh     yerel imajla dene (geliştirme)
#
# Sunucuya yazdıkları:
#   /var/lib/chat/.env                 ayarlar (konteynerde /veri/.env). Güncellemede dokunulmaz.
#   /var/lib/chat/docker-compose.yml   konteyner tanımı (her çalıştırmada yeniden yazılır)
set -eu

# GitHub deposu (kullanici/depo). GitHub sürümü oluşturulurken workflow buraya gerçek adı yazar.
DEPO=

KONTEYNER=diszort
VERI=/var/lib/chat
ETIKET=latest

hata() {
	echo "kur.sh: $*" >&2
	exit 1
}

ipv4mu() {
	echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

# Sunucunun dış IPv4 adresi: önce bulut meta verisi (GCP), sonra dışarıdan sor.
dis_ip_bul() {
	IP=$(curl -fsS --max-time 2 -H 'Metadata-Flavor: Google' \
		http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null) || IP=
	ipv4mu "$IP" || IP=$(curl -fsS -4 --max-time 5 https://api.ipify.org 2>/dev/null) || IP=
	ipv4mu "$IP" || IP=$(curl -fsS -4 --max-time 5 https://ifconfig.me 2>/dev/null) || IP=
	ipv4mu "$IP" && echo "$IP"
}

main() {
	while [ $# -gt 0 ]; do
		case "$1" in
			-s)
				[ -n "${2:-}" ] || hata "-s bir sürüm etiketi ister: sudo sh -s v3"
				ETIKET=$2
				shift 2
				;;
			v*)
				ETIKET=$1
				shift
				;;
			*)
				hata "bilinmeyen argüman: $1"
				;;
		esac
	done

	[ "$(id -u)" = 0 ] || hata "root olarak çalıştır (sudo)."
	command -v docker >/dev/null 2>&1 ||
		hata "Docker yok. Kur:  sudo apt install docker.io docker-compose-v2   ya da  curl -fsSL https://get.docker.com | sudo sh"
	docker info >/dev/null 2>&1 || hata "Docker çalışmıyor: sudo systemctl start docker"
	docker compose version >/dev/null 2>&1 ||
		hata "docker compose eklentisi yok. Kur: sudo apt install docker-compose-v2"
	command -v curl >/dev/null 2>&1 || hata "curl yok. Kur: sudo apt install curl"

	IMAJ=${IMAJ:-}
	if [ -n "$IMAJ" ]; then
		IMAJ_VERILDI=1
	else
		IMAJ_VERILDI=
		[ -n "$DEPO" ] || hata "hangi imajı çekeceğimi bilmiyorum; geliştirme için: sudo IMAJ=<imaj>:<etiket> sh $0"
		# İmaj adı depo adından bağımsız: ghcr.io/<sahip>/diszort
		IMAJ=ghcr.io/$(printf '%s' "${DEPO%%/*}" | tr 'A-Z' 'a-z')/$KONTEYNER:$ETIKET
	fi
	# Güncelleme ipucu: sürüm dosyası (kur.sh) anonim indirilebiliyorsa curl satırı yazılır.
	# Depo özel ise o dosya 404 verir; o zaman SSH ile taze klon + aynı imajı çeken satır yazılır.
	if [ -n "$IMAJ_VERILDI" ]; then
		GUNCELLE="sudo IMAJ=$IMAJ sh $0"
	elif curl -fsS -o /dev/null --max-time 5 "https://github.com/$DEPO/releases/latest/download/kur.sh" 2>/dev/null; then
		GUNCELLE="curl -fsSL https://github.com/$DEPO/releases/latest/download/kur.sh | sudo sh"
	else
		GUNCELLE="rm -rf /tmp/$KONTEYNER && git clone --depth 1 git@github.com:$DEPO.git /tmp/$KONTEYNER && sed 's|^DEPO=.*|DEPO=$DEPO|' /tmp/$KONTEYNER/kurulum/kur.sh | sudo sh"
	fi

	# 1) Ayarlar: varsa dokunma; yoksa oluştur ve dış IP'yi bul
	mkdir -p "$VERI"
	if [ ! -f "$VERI/.env" ]; then
		cat >"$VERI/.env" <<'AYARLAR'
# Diszort ayarları. kur.sh ilk kurulumda oluşturur; sonra istediğin gibi düzenle.
# Yalnızca konteyner başlarken okunur; değiştirince:  sudo docker restart diszort
# Hepsi isteğe bağlı; boş bırakılan varsayılanı kullanır.

# Sunucunun dış (public) IPv4 adresi. BOŞ BIRAK: bulut meta verisinden (GCP/AWS) kendiliğinden
# okunur ve 5 dakikada bir kontrol edilir. Elle yazarsan o değer sabitlenir (IP değişirse TURN ölür).
DIS_IP=

# Sunucunun ağ kartındaki IPv4 adresi (GCP'de 10.x.x.x). Boşsa kendiliğinden bulunur.
IC_IP=

# Tarayıcıların STUN/TURN için bağlanacağı adres. Boşsa DIS_IP, o da boşsa sayfanın adresi.
# Alan adı Cloudflare gibi bir vekilin arkasındaysa burası IP olmalı (vekil UDP taşımaz).
TURN_ADRESI=

# Bir sesli kanalda en fazla kaç kişi olur. Herkes herkese bağlandığı için (mesh) 10'dan fazlası zorlar.
MAX_KISI=10

# Beyaz liste: en fazla kaç kişi (ad) olabilir. Her kişinin kendi anahtarı vardır; yeni kişi
# içeridekilerin onayıyla eklenir. İçeridekiler arayüzden (− / +) çalışırken değiştirebilir.
MAX_KULLANICI=10

# Giriş freni: TÜM giriş denemeleri sunucu genelinde tek bir jeton kovasından düşer; kova her
# GIRIS_ARALIK_MS'de bir dolar, en fazla GIRIS_KOVA birikir (10000 + 1 = 10 saniyede 1 deneme,
# üretimde böyle kalmalı). Testler için arttırılabilir (GIRIS_KOVA=N: N deneme birikir).
# GIRIS_ARALIK_MS=10000
# GIRIS_KOVA=1

# Sesli kanaldayken bağlantısı kopanın yeri bu kadar ms askıda kalır (geri gelirse ses kesilmez).
# SES_ASKI_MS=60000

# Beyaz liste boşken ilk anahtarı alacak kişinin adı (anahtar: /var/lib/chat/ilk-anahtar.txt).
YONETICI_ADI=taha

# STUN/TURN portu (UDP + TCP yedeği) ve TURN aktarım portları (UDP). Güvenlik duvarında açık olmalı:
# UDP 3478, TCP 3478 ve UDP 49152-61000.
TURN_PORT=3478
RELAY_MIN_PORT=49152
RELAY_MAX_PORT=61000

# Web sayfası ve signaling'in dinlediği adres. Konteyner sunucunun ağını paylaşır
# (network_mode: host); Caddy buraya yönlendirir.
# 127.0.0.1 kalsın ki sayfaya dışarıdan yalnızca HTTPS üzerinden ulaşılsın.
HOST=127.0.0.1
PORT=8080
AYARLAR
		if IP=$(dis_ip_bul); then
			echo "Ayar dosyası oluşturuldu: $VERI/.env (dış IP: $IP — kendiliğinden bulundu)"
		else
			echo "Ayar dosyası oluşturuldu: $VERI/.env (dış IP bulunamadı; TURN için DIS_IP'yi elle yaz)"
		fi
	else
		echo "Ayarlar korunuyor: $VERI/.env"
	fi
	# Test/kurulum kolaylığı: bu değişkenler verilmişse .env'e yaz (CI uçtan uca denemede kullanır).
	for cift in "ILK_ANAHTAR=${ILK_ANAHTAR:-}" "MAX_KULLANICI=${MAX_KULLANICI:-}" "GIRIS_ARALIK_MS=${GIRIS_ARALIK_MS:-}" \
		"GIRIS_KOVA=${GIRIS_KOVA:-}" "SES_ASKI_MS=${SES_ASKI_MS:-}" "TURN_ADRESI=${TURN_ADRESI:-}" "TURN_IZINLI_IP=${TURN_IZINLI_IP:-}"; do
		ad=${cift%%=*}
		deger=${cift#*=}
		[ -n "$deger" ] || continue
		if grep -q "^$ad=" "$VERI/.env"; then
			sed -i "s|^$ad=.*|$ad=$deger|" "$VERI/.env"
		else
			printf '%s=%s\n' "$ad" "$deger" >>"$VERI/.env"
		fi
	done
	chmod 0700 "$VERI"
	chmod 0600 "$VERI/.env"
	# Konteynerdeki ayrıcalıksız kullanıcı (imaj: uid 1000) okuyabilsin
	chown -R 1000:1000 "$VERI" 2>/dev/null || true

	# 2) Konteyner tanımı: her çalıştırmada seçilen imaj etiketiyle yeniden yazılır (geri dönüş = etiket)
	cat >"$VERI/docker-compose.yml" <<COMPOSE
services:
  $KONTEYNER:
    image: $IMAJ
    container_name: $KONTEYNER
    # TURN çok sayıda UDP portu kullanır ve gerçek IP'yi duyurması gerekir; köprü ağı olmaz.
    network_mode: host
    restart: unless-stopped
    volumes:
      - $VERI:/veri
COMPOSE

	# 3) İmajı çek (yerel imaj verilmişse onu kullan)
	if [ -n "$IMAJ_VERILDI" ]; then
		docker image inspect "$IMAJ" >/dev/null 2>&1 || hata "yerel imaj yok: $IMAJ"
		echo "İmaj yerelde var: $IMAJ"
	else
		echo "İmaj çekiliyor: $IMAJ"
		( cd "$VERI" && docker compose pull ) || hata "imaj çekilemedi ($IMAJ).
Paket özelse ya public yap: GitHub -> profilin -> Packages -> $KONTEYNER -> Package settings -> Change visibility
ya da sunucuda bir kez giriş yap (token: GitHub -> Settings -> Developer settings ->
Personal access tokens -> yalnızca read:packages):
    echo <token> | sudo docker login ghcr.io -u ${DEPO%%/*} --password-stdin"
	fi

	# 4) Konteyneri aç
	( cd "$VERI" && docker compose up -d --force-recreate --remove-orphans ) || hata "konteyner açılamadı."

	# 5) Sağlık: sunucu ve coturn ayağa kalkana kadar bekle
	PORT=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$VERI/.env" | tail -n 1)
	PORT=${PORT:-8080}
	CALISTI=
	i=0
	while [ "$i" -lt 30 ]; do
		i=$((i + 1))
		sleep 1
		if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/saglik" >/dev/null 2>&1; then
			CALISTI=1
			break
		fi
	done
	if [ -z "$CALISTI" ]; then
		echo "" >&2
		docker logs --tail 30 "$KONTEYNER" >&2 2>&1 || true
		hata "konteyner sağlıklı yanıt vermiyor. Yukarıdaki hatayı düzelt (çoğunlukla $VERI/.env), sonra:
    sudo docker restart $KONTEYNER"
	fi
	SURUM=$(curl -fsS "http://127.0.0.1:$PORT/saglik" | sed -n 's/.*"surum":"\([^"]*\)".*/\1/p')

	echo ""
	echo "Diszort ${SURUM:-$ETIKET} Docker konteynerinde çalışıyor; sunucu açılınca kendiliğinden başlar."
	cat <<EOF
  Günlük     sudo docker logs -f $KONTEYNER
  Ayarlar    sudo nano $VERI/.env   sonra   sudo docker restart $KONTEYNER
  Güncelle   $GUNCELLE
EOF
}

main "$@"
