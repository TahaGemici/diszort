# Ses Kanalı'nın çalışma imajı. GitHub Actions bunu derleyip ghcr.io'ya yükler;
# sunucuda "docker compose" ile çalışır (kurulumu kur.sh yapar). Tek süreç:
# node sunucu/sunucu.js web sayfasını sunar ve /rtc signaling'ini yönetir,
# coturn'ü (STUN/TURN) kendisi başlatıp izler.
FROM debian:trixie-slim

# Sürüm: /saglik yanıtında ve açılış günlüğünde görünür (derlerken verilir, isteğe bağlı).
ARG SURUM=yerel
ENV SURUM=$SURUM

# node (sunucu + web), node-ws (WebSocket kütüphanesi, Debian paketi) ve coturn (STUN/TURN).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends nodejs node-ws coturn \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* /usr/share/doc/* /usr/share/man/* /usr/share/info/*

COPY sunucu/ /usr/share/chat/sunucu/
COPY web/ /usr/share/chat/web/

# Ayrıcalıksız kullanıcı: dinlenen tüm portlar (8080, 3478, 49152-61000) 1024'ün üstünde,
# root gerekmez. chmod: depodan gelen dosyalar dar izinli olabilir; kullanıcı okuyabilsin.
RUN useradd --system --uid 1000 --home /nonexistent --shell /usr/sbin/nologin seskanali \
	&& chmod -R u=rwX,go=rX /usr/share/chat \
	&& node -e "require('ws')" \
	&& turnserver --version >/dev/null

# Ayarlar: sunucudaki /var/lib/chat buraya bağlanır; sunucu /veri/.env dosyasını okur.
ENV AYAR_DOSYASI=/veri/.env
VOLUME /veri

# Portlar yalnızca --network host ile anlam kazanır (TURN çok sayıda UDP portu kullanır);
# burada belgeleme amaçlı yazılı.
EXPOSE 8080/tcp 3478/udp 49152-61000/udp

USER seskanali
WORKDIR /usr/share/chat
CMD ["node", "sunucu/sunucu.js"]
