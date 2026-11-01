# Ses Kanalı

Hesapsız, tarayıcıdan girilen sesli oda. Discord'un sesli kanalı gibi, ama yalnızca ses, kurulum yok.

- **Giriş:** Adını ve oda adını yazarsın, mikrofon iznini verirsin, o kadar. Oda bağlantısı (`https://alanadin/#oda`) paylaşılır; oda adı aynı zamanda şifredir.
- **Ses doğrudan:** Odadakiler birbirine tarayıcıdan tarayıcıya bağlanır (mesh WebRTC). Ses sunucudan geçmez; sunucu yalnızca kimin odada olduğunu söyler ve bağlantı tekliflerini iletir.
- **NAT arkasında da çalışır:** Kendi STUN/TURN sunucusu (coturn) içindedir. Doğrudan bağlanamayanların (CGNAT, simetrik NAT) sesi TURN üzerinden aktarılır. TURN şifreleri her bağlanışta yeniden üretilir ve bir gün geçerlidir; diskte saklanan şifre yoktur.
- **Odada:** Herkesin adı, bağlantı türü (doğrudan / TURN) ve gecikmesi; kişi başına susturma ve ses seviyesi; kendi mikrofonunu kapatma ve seviye göstergesi. Konuşanın noktası yanar.
- **Sınır:** Bir odada en fazla 10 kişi (`.env`'de `MAX_KISI`). Herkes herkese bağlandığı için daha fazlası tarayıcıları zorlar.
- Sunucu Node ile (tek bağımlılık `ws`), arayüz düz HTML/CSS/JS ile yazıldı. **Docker imajı** olarak dağıtılır: GitHub Actions derler, `ghcr.io`'ya yükler; sunucuda tek komutla kurulur.

## Sunucuya kur

Gerekenler: Docker ve compose eklentisi.

```sh
sudo apt install -y docker.io docker-compose-v2   # Debian 12+ / Ubuntu 24.04+
# ya da:  curl -fsSL https://get.docker.com | sudo sh
```

Kurmak da güncellemek de tek komut:

```sh
curl -fsSL https://github.com/KULLANICI/DEPO/releases/latest/download/kur.sh | sudo sh
```

`kur.sh` imajı `ghcr.io/KULLANICI/DEPO`'dan çeker, ilk seferde `/var/lib/chat/.env` oluşturur (sunucunun dış IP'si kendiliğinden bulunup yazılır) ve konteyneri açar. `main`'e her push'ta Actions imajı derler, `kur.sh` ile uçtan uca dener, `ghcr.io`'ya `v1`, `v2`… ve `latest` etiketleriyle yükler, `kur.sh`'yi GitHub sürümü olarak yayınlar.

**Depo özel ise** yukarıdaki `curl` satırı çalışmaz: sürüm dosyası yalnızca giriş yapmış kullanıcıya iner (anonim istek 404). O durumda aynı güncellemeyi SSH ile taze klon yaparak çalıştır (sunucuda GitHub'a eklenmiş bir SSH anahtarı gerekir):

```sh
rm -rf /tmp/ses-kanali && git clone --depth 1 git@github.com:KULLANICI/DEPO.git /tmp/ses-kanali \
  && sed "s|^DEPO=.*|DEPO=KULLANICI/DEPO|" /tmp/ses-kanali/kurulum/kur.sh | sudo sh
```

Bu satır da imajı `ghcr.io`'dan çeker ve `.env`'e dokunmaz; `kur.sh` çalıştıktan sonra ekrana hangi güncelleme satırının çalıştığını kendisi yazar (depo public ise `curl`, özel ise `git clone` satırı).

**İlk kurulumdan sonra bir kez:** GHCR paketi varsayılan olarak **özeldir**. Public yaparsan sunucu giriş yapmadan çekebilir: GitHub → profilin → **Packages** → `ses-kanali` → Package settings → **Change visibility** → Public. Özel kalacaksa bir kez giriş yap (token: GitHub → Settings → Developer settings → Personal access tokens → `read:packages`):

```sh
echo <token> | sudo docker login ghcr.io -u KULLANICI --password-stdin
```

Kimlik `/root/.docker/config.json`'da tutulur (`sudo` ile çalışan `docker compose pull` bunu kullanır); token'ı diskte ayrıca saklamana gerek yok.

Ayarları değiştirmek için:

```sh
sudo nano /var/lib/chat/.env
sudo docker restart ses-kanali
```

**Güvenlik duvarı:** STUN/TURN için UDP `3478` ve UDP `49152-61000` dışarıya açık olmalı. GCP'de:

```sh
gcloud compute firewall-rules create allow-turn-udp --allow=udp:3478,udp:49152-61000
```

**HTTPS** için Caddy (alan adının A kaydı sunucuyu göstermeli, 80 ve 443 açık olmalı; mikrofon izni yalnızca HTTPS'te çalışır):

```sh
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<'SON'
chat.alanadin.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
	header Strict-Transport-Security "max-age=31536000"
}
SON
sudo systemctl reload caddy
```

Alan adı Cloudflare'in arkasındaysa (turuncu bulut) sorun yok: Cloudflare yalnızca sayfayı ve WebSocket'i taşır; tarayıcılar STUN/TURN için doğrudan sunucunun IP'sine gider (`.env`'deki `DIS_IP`).

| İş | Komut |
|---|---|
| Güncelle | kurulum komutunun aynısı (`.env` kalır) |
| Eski bir sürüme dön | kurulum komutunun sonuna `-s v3` ekle |
| Günlük | `sudo docker logs -f ses-kanali` |
| Durdur / başlat | `cd /var/lib/chat && sudo docker compose down` / `up -d` |
| `.env` değişince | `sudo docker restart ses-kanali` |
| Sağlık | `curl http://127.0.0.1:8080/saglik` |

Depo özelse imaj çekilemez. Sunucuda bir kez giriş yap (token: GitHub → Settings → Developer settings → Personal access tokens → `read:packages`):

```sh
echo <token> | sudo docker login ghcr.io -u KULLANICI --password-stdin
```

Sonra yine aynı tek satırlık komut çalışır.

## Kendi bilgisayarında dene

```sh
make                        # node ile (node, npm ve coturn gerekir; coturn yoksa STUN/TURN kapalı olur)
```

ya da Docker ile:

```sh
docker compose up --build -d    # http://127.0.0.1:8080
docker compose down
```

Adresi iki sekmede aç. (Tarayıcılar mikrofonu yalnızca HTTPS'te ya da `localhost`/`127.0.0.1`'de verir.) Çalışan bir sunucuyu dışarıdan denemek için: `make test` (ya da `node test/dene.js http://adres:port`). Web sayfası, sağlık, `/api/ice`, signaling (giriş, mesh mesajları, aynı ad, oda doluluğu), STUN ve TURN (geçici şifreyle aktarım alma, yanlış şifreyle alamama) denenir.

## Nasıl çalışır

```
tarayıcı ──HTTPS──> Caddy :443 ──> 127.0.0.1:8080  konteyner ─┬─ web sayfası (web/)
                                                              ├─ /rtc   WebSocket: odalar, SDP/ICE iletimi
                                                              ├─ /api/ice  STUN/TURN adresi + geçici şifre
                                                              └─ /saglik
tarayıcı <══ses (doğrudan)══> tarayıcı
tarayıcı ──UDP 3478──> coturn (konteynerde, sunucu.js başlatır) ──UDP 49152-61000──> tarayıcı   (yalnızca doğrudan olmazsa)
```

- **İmaj:** `Dockerfile` küçük bir Debian'ı (node, node-ws, coturn) ve bu depodaki dosyaları tek bir imaja paketler; GitHub Actions `ghcr.io`'ya yükler. Sunucuda derleme yoktur, yalnızca çekme.
- **Konteyner:** Tek süreç: `sunucu.js` web sayfasını ve signaling'i yönetir, coturn'ü kendisi başlatıp izler (biri düşerse konteyner iki saniyede yeniden başlar). Kök olmayan kullanıcı (uid 1000) ile çalışır; ayrıcalığı yoktur. Sunucunun ağını paylaşır (`network_mode: host`): TURN çok sayıda UDP portu kullanır ve gerçek IP'yi duyurması gerekir.
- **Ayarlar:** Sunucudaki `/var/lib/chat` konteynerde `/veri` olur; içinde `.env` ve `docker-compose.yml` vardır. Güncellemede `.env` korunur.
- **TURN şifreleri:** coturn `use-auth-secret` ile çalışır; sır her açılışta bellekte üretilir. `/api/ice` her istekte bir günlük kullanıcı adı ve HMAC şifresi verir. İç ağa (10/8, 172.16/12, 192.168/16, 127/8...) aktarım yasaktır; kullanıcı ve toplam aktarım sayısı ile bant genişliği sınırlıdır.
- **Signaling protokolü** (`/rtc`, JSON):
  - istemci → sunucu: `join {room, name, id}`, `sdp {to, sdp}`, `ice {to, ice}`, `ping`
  - sunucu → istemci: `joined {room, peers, max}`, `peer-joined {name}`, `peer-left {name}`, `sdp {from, sdp}`, `ice {from, ice}`, `error {message}`, `pong`
  - Her çiftte teklifi adı alfabetik olarak büyük olan yapar (çakışma olmaz). Aynı sekme (`id`) yeniden bağlanırsa eski bağlantısı düşürülür; başka biri aynı adı alamaz.

## Dosyalar

| Yol | Ne |
|---|---|
| `Dockerfile`, `docker-compose.yml` | çalışma imajı (node + coturn) ve yerel çalıştırma |
| `kurulum/kur.sh` | sunucuda kur / güncelle / eski sürüme dön |
| `kurulum/Caddyfile` | HTTPS örneği |
| `sunucu/sunucu.js` | web, signaling, coturn yönetimi, `/api/ice`, `/saglik` |
| `web/` | sayfa (`index.html`, `ana.js`, `stil.css`, simgeler) |
| `.env.example` | ayarlar (sunucuda `/var/lib/chat/.env`) |
| `test/dene.js` | çalışan sunucuyu uçtan uca dener |
| `.github/workflows/docker.yml` | push → derle, `kur.sh` ile dene, ghcr.io'ya yükle, sürüm çıkar |

## Sınırlar

- Mesh olduğu için her kişi odadaki herkese ayrı ses gönderir: 10 kişide her biri 9 bağlantı (~9 × 64 kbps yukarı). Daha kalabalık odalar için SFU (ör. LiveKit, mediasoup) gerekir.
- Oda adı bilen herkes girer; hesap, şifre, yasaklama yok.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~64 kbps).
- Yalnızca IPv4 TURN.
