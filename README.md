# Ses Kanalı

Hesapsız, tarayıcıdan girilen Discord'umsu sunucu: **yazılı kanallar** (geçmişi veritabanında tutulur,
dosya paylaşılabilir) + **sesli kanallar** (ses tarayıcılar arasında doğrudan, P2P akar).

- **Giriş:** Yalnızca adını yazarsın. Hesap, şifre, davet yok. Bütün kanallar açılır.
- **Arayüz:** Solda yazılı (`#genel`, `#muhabbet`) ve sesli (Sesli Sohbet, Müzik, Oyun) kanallar;
  ortada sohbet; sağda çevrimiçi kişiler; sesli kanaldayken altta katılımcı kartı.
- **Kanal ekle / sil:** Her bölümün başındaki `＋` ile yazılı veya sesli kanal açılır; kanal adının
  yanındaki `✕` ile silinir (yazılı kanal silinince mesajları ve dosyaları da gider, sesli kanal
  silinince içindekiler çıkarılır). Tek sunucu olduğu için en solda sunucu şeridi yoktur.
- **Yazılı kanallar sunucudan geçer ve saklanır:** mesajlar SQLite'ta (`/veri/sohbet.db`), paylaşılan
  dosyalar `/veri/yuklemeler/` altında. Geçmiş sayfa yenilenince de yerinde durur.
- **Dosya paylaşımı:** ataç düğmesi, sürükle-bırak ya da panodan yapıştırma; en fazla `DOSYA_MB` (varsayılan 25 MB).
  Resim/ses/video önizlemesi satır içinde, diğerleri indirme bağlantısı olarak gösterilir.
- **Ses doğrudan (P2P):** Sesli kanaldakiler birbirine tarayıcıdan tarayıcıya bağlanır (mesh WebRTC).
  Ses sunucudan geçmez; sunucu yalnızca kimin hangi kanalda olduğunu söyler ve bağlantı tekliflerini iletir.
  Doğrudan bağlanamayanların (CGNAT, simetrik NAT) sesi TURN üzerinden aktarılır.
- **Sesli kanalda:** Kişi başına susturma ve ses seviyesi, bağlantı türü (doğrudan / TURN) ve gecikme,
  kendi mikrofonunu kapatma, konuşanın noktasının yanması.
- **Sınır:** Bir sesli kanalda en fazla 10 kişi (`.env`'de `MAX_KISI`). Herkes herkese bağlandığı için
  daha fazlası tarayıcıları zorlar. Yazılı kanal sayısında sınır yok.
- Sunucu Node ile (bağımlılıklar Debian paketi: `node-ws`, `node-sqlite3`), arayüz düz HTML/CSS/JS.
  **Docker imajı** olarak dağıtılır: GitHub Actions derler, `ghcr.io`'ya yükler; sunucuda tek komutla kurulur.

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

`kur.sh` imajı `ghcr.io/KULLANICI/DEPO`'dan çeker, ilk seferde `/var/lib/chat/.env` oluşturur (sunucunun
dış IP'si kendiliğinden bulunup yazılır) ve konteyneri açar. `main`'e her push'ta Actions imajı derler,
`kur.sh` ile uçtan uca dener, `ghcr.io`'ya `v1`, `v2`… ve `latest` etiketleriyle yükler, `kur.sh`'yi
GitHub sürümü olarak yayınlar.

**Depo özel ise** yukarıdaki `curl` satırı çalışmaz: sürüm dosyası yalnızca giriş yapmış kullanıcıya iner
(anonim istek 404). O durumda aynı güncellemeyi SSH ile taze klon yaparak çalıştır:

```sh
rm -rf /tmp/ses-kanali && git clone --depth 1 git@github.com:KULLANICI/DEPO.git /tmp/ses-kanali \
  && sed "s|^DEPO=.*|DEPO=KULLANICI/DEPO|" /tmp/ses-kanali/kurulum/kur.sh | sudo sh
```

**İlk kurulumdan sonra bir kez:** GHCR paketi varsayılan olarak **özeldir**. Public yaparsan sunucu giriş
yapmadan çekebilir: GitHub → profilin → **Packages** → `ses-kanali` → Package settings → **Change visibility**.
Özel kalacaksa bir kez giriş yap (token: GitHub → Settings → Developer settings → Personal access tokens →
`read:packages`):

```sh
echo <token> | sudo docker login ghcr.io -u KULLANICI --password-stdin
```

Ayarları değiştirmek için:

```sh
sudo nano /var/lib/chat/.env
sudo docker restart ses-kanali
```

**Güvenlik duvarı:** STUN/TURN için UDP `3478` ve UDP `49152-61000` dışarıya açık olmalı. GCP'de:

```sh
gcloud compute firewall-rules create allow-turn-udp --allow=udp:3478,udp:49152-61000
```

**HTTPS** için Caddy (alan adının A kaydı sunucuyu göstermeli, 80 ve 443 açık olmalı; mikrofon izni
yalnızca HTTPS'te çalışır):

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

| İş | Komut |
|---|---|
| Güncelle | kurulum komutunun aynısı (`.env` ve veritabanı kalır) |
| Eski bir sürüme dön | kurulum komutunun sonuna `-s v3` ekle |
| Günlük | `sudo docker logs -f ses-kanali` |
| Durdur / başlat | `cd /var/lib/chat && sudo docker compose down` / `up -d` |
| `.env` değişince | `sudo docker restart ses-kanali` |
| Sağlık | `curl http://127.0.0.1:8080/saglik` |
| Veritabanı yedeği | `sudo cp /var/lib/chat/sohbet.db* /yedek/` (WAL dosyalarıyla birlikte) |

## Veriler nerede durur

| Yol (sunucu) | İçinde |
|---|---|
| `/var/lib/chat/.env` | ayarlar |
| `/var/lib/chat/sohbet.db` (+ `-wal`, `-shm`) | kanal listesi, yazılı kanalların mesajları ve dosya kayıtları (SQLite) |
| `/var/lib/chat/yuklemeler/` | paylaşılan dosyaların kendisi (`<id>` adıyla) |

Hepsi `/var/lib/chat` altında, konteynerde `/veri`. Konteyner silinse/yeniden kurulsa da korunur;
sunucu (VM) silinirse gider. Yedek: yukarıdaki iki satırı kopyala.

## Kendi bilgisayarında dene

```sh
make                        # node ile (node, npm ve coturn gerekir; coturn yoksa STUN/TURN kapalı olur)
```

ya da Docker ile:

```sh
docker compose up --build -d    # http://127.0.0.1:8080
docker compose down
```

Adresi iki sekmede aç. (Tarayıcılar mikrofonu yalnızca HTTPS'te ya da `localhost`/`127.0.0.1`'de verir.)
Çalışan bir sunucuyu dışarıdan denemek için: `make test` (ya da `node test/dene.js http://adres:port`).
18 deneme yapılır: web sayfası, sağlık, `/api/ice`, STUN, TURN (doğru/yanlış şifre), giriş, yazılı sohbet
(gönderme, iletme, geçmiş, hız sınırı), dosya paylaşımı (yetki, yükleme, indirme), sesli kanal signaling'i,
aynı ad reddi, kanal doluluğu, kanal ekleme/silme (yazılı + sesli, doğrulama) ve çık-gir sonrası yeniden
bağlanma. **Not:** denemeler gerçek veritabanına birkaç `(deneme)` mesajı ve küçük
bir dosya bırakır.

Arayüzü de tarayıcı açmadan deneyebilirsin: `make arayuz` (jsdom; giriş, kanal ekleme/silme penceresi,
kanal seçimi, mesaj çizimi, sesli kanal satırları, bağlantı istatistikleri, çık-gir — toplam 72 denetim).
Bu VPS'te gerçek tarayıcı çalıştırılmaz.

## Nasıl çalışır

```
tarayıcı ──HTTPS──> Caddy :443 ──> 127.0.0.1:8080  konteyner ─┬─ web sayfası (web/)
                                                              ├─ /rtc       WebSocket: sohbet + kanallar + SDP/ICE
                                                              ├─ /api/yukle dosya yükleme (jetonlu)
                                                              ├─ /dosya/<id> yüklenen dosyayı sun
                                                              ├─ /api/ice   STUN/TURN adresi + geçici şifre
                                                              └─ /saglik
tarayıcı <══ses (doğrudan)══> tarayıcı
tarayıcı ──UDP 3478──> coturn (konteynerde, sunucu.js başlatır) ──UDP 49152-61000──> tarayıcı   (yalnızca doğrudan olmazsa)
```

- **İmaj:** `Dockerfile` küçük bir Debian'ı (node, node-ws, node-sqlite3, coturn) ve bu depodaki dosyaları
  tek imaja paketler; GitHub Actions `ghcr.io`'ya yükler. Sunucuda derleme yoktur, yalnızca çekme.
- **Konteyner:** Tek süreç: `sunucu.js` web sayfasını, sohbeti, dosyaları ve signaling'i yönetir; coturn'ü
  kendisi başlatıp izler (biri düşerse konteyner iki saniyede yeniden başlar). Kök olmayan kullanıcı
  (uid 1000) ile çalışır. Sunucunun ağını paylaşır (`network_mode: host`): TURN çok sayıda UDP portu kullanır.
- **Kanallar:** Veritabanındaki `kanal` tablosunda (id, ad, tur, sıra). İlk kurulumda varsayılanlar
  yazılır; sonrasında arayüzden eklenip silinir (en fazla 40, ad 24 karakter, aynı türde aynı ad yok).
  Kanal kimliği addan üretilir ("Sesli Sohbet" → `sesli-sohbet`), çakışırsa sonuna sayı eklenir.
  Silme: yazılı kanalın mesaj/dosya kayıtları silinir ve dosyaları diskten kaldırılır; sesli kanaldaysa
  içindekilere `ses-kapatildi` gönderilir. Son yazılı/sesli kanal silinemez.
- **Veritabanı:** `sunucu/veritabani.js`, `sohbet.db` (WAL). Tablolar: `mesaj` (kanal, ad, metin, dosya_id,
  zaman) ve `dosya` (id, kanal, ad, boyut, tur, zaman). Ölçek küçük: tek dosya, indeks `(kanal, id)`.
- **Dosya güvenliği:** yükleme `Authorization: Bearer <jeton>` ister (jeton oturum açınca verilir, sayfa
  yenilenince yenilenir). Dosya adı temizlenir, dosyalar `<id>` olarak saklanır (yol oyunu imkânsız),
  yalnızca resim/ses/video uzantıları satır içi sunulur; HTML/SVG gibi türler `Content-Disposition: attachment`
  ile indirilir, yanıt `nosniff` + `default-src 'none'` başlıkları taşır. Toplam boyut `DOSYA_MB`, sunucuda
  300 MB'dan az boş yer kalırsa yükleme reddedilir.
- **Yazma hızı:** kişi başı 10 saniyede 12 mesaj; mesaj uzunluğu 2000 karakter.
- **TURN şifreleri:** coturn `use-auth-secret` ile çalışır; sır her açılışta bellekte üretilir. `/api/ice`
  her istekte bir günlük kullanıcı adı ve HMAC şifresi verir. İç ağa aktarım yasaktır; kullanıcı ve toplam
  aktarım sayısı ile bant genişliği sınırlıdır.

### WebSocket protokolü (`/rtc`, JSON)

| İstemci → sunucu | Anlamı |
|---|---|
| `giris {ad, id}` | adı al (bir kez). `id` sekme kimliği: aynı sekme yeniden bağlanınca eski bağlantı düşer |
| `yazi {kanal, metin}` | yazılı kanala mesaj gönder (veritabanına yazılır, herkese iletilir) |
| `gecmis {kanal, once}` | son 50 mesaj; `once` verilirse ondan daha eskiler |
| `yaziyor {kanal}` | "yazıyor" göstergesi |
| `ses-gir {kanal}` / `ses-cik` | sesli kanala gir / çık |
| `kanal-ekle {tur, ad}` / `kanal-sil {kanal}` | yazılı (`yazi`) veya sesli (`ses`) kanal ekle / sil |
| `sdp {to, sdp}` / `ice {to, ice}` | WebRTC (aynı sesli kanaldaki kişiye) |
| `sessiz {sessiz}` | mikrofon kapalı mı (diğerlerine gösterilir) |
| `ping` | bağlantı canlı tutma |

| Sunucu → istemci | Anlamı |
|---|---|
| `hazir {ad, kanallar, kimler, max, dosyaMb, jeton}` | giriş kabul edildi; kanal listesi + yükleme jetonu |
| `kanallar` / `kimler` | kanal doluluğu / çevrimiçi kişiler değişti |
| `yazi {kanal, mesaj}` / `gecmis {kanal, mesajlar, bitti}` | yeni mesaj / geçmiş |
| `yaziyor`, `sessiz` | göstergeler |
| `ses-girdi {kanal, kisiler}`, `ses-kisi-girdi`, `ses-kisi-cikti` | sesli kanal üyeleri |
| `ses-kapatildi {kanal}` | sesli kanal silindi, çıkarıldın |
| `sdp {from, sdp}` / `ice {from, ice}` | WebRTC |
| `hata {message}` | reddedildi / sorun |

Her çiftte teklifi adı alfabetik olarak büyük olan yapar (çakışma olmaz). Adlar sunucu genelinde benzersizdir.

## Dosyalar

| Yol | Ne |
|---|---|
| `Dockerfile`, `docker-compose.yml` | çalışma imajı (node + sqlite + coturn) ve yerel çalıştırma |
| `kurulum/kur.sh` | sunucuda kur / güncelle / eski sürüme dön |
| `kurulum/Caddyfile` | HTTPS örneği |
| `sunucu/sunucu.js` | web, sohbet, dosyalar, signaling, coturn yönetimi, `/api/ice`, `/saglik` |
| `sunucu/veritabani.js` | SQLite (mesaj + dosya kayıtları) |
| `web/` | arayüz (`index.html`, `ana.js`, `stil.css`, simgeler) |
| `.env.example` | ayarlar (sunucuda `/var/lib/chat/.env`) |
| `test/dene.js` | çalışan sunucuyu uçtan uca dener (18 deneme) |
| `test/arayuz.js` | arayüzü tarayıcısız dener (jsdom; 72 denetim) |
| `.github/workflows/docker.yml` | push → derle, `kur.sh` ile dene, ghcr.io'ya yükle, sürüm çıkar |

## Sınırlar

- Mesh olduğu için her kişi kanaldaki herkese ayrı ses gönderir: 10 kişide her biri 9 bağlantı
  (~9 × 64 kbps yukarı). Daha kalabalık odalar için SFU (ör. LiveKit, mediasoup) gerekir.
- Adı bilen herkes girer; hesap, şifre, yasaklama, moderasyon yok. Adlar sunucu genelinde benzersiz.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~64 kbps).
- Yalnızca IPv4 TURN.
- Ses/görüntü **hiçbir yere kaydedilmez**; yalnızca yazılı mesajlar ve paylaşılan dosyalar saklanır.

### Ses kalitesi

Ses **hiçbir eşikten/süzgeçten geçmez** (VAD, gate, gain yok): mikrofon akışı doğrudan WebRTC'ye verilir,
seviye ölçümü ayrı bir analiz düğümünde yapılır. Yani kesilmeler eşikten değil, ağdan gelir. Arayüzde her
kişi için `P2P/TURN · gecikme · %kayıp · kbps` gösterilir (titreşim/jitter değeri başlıkta). Kayıp %1'in
altındaysa yeşil, %1–5 turuncu, üstü kırmızı görünür.

- **TURN aktarım sınırı 512 kbps.** Eskiden 96 kbps idi; relay üzerinden giden görüşmelerde gelen+giden
  toplamı bu sınıra dayanıp ses kesiliyordu.
- **Tek `AudioContext`.** Her katılımcı için yeni ses bağlamı açmak tarayıcının bağlam sınırına takılıyor,
  çık-gir sonrası ölçüm/ses sorun çıkarıyordu.
- **Ses kanalı her zaman açılır.** `addTransceiver` ile teklif/yanıt mikrofon hazır olmasa bile üretilir;
  mikrofon sonradan gelirse `replaceTrack` ile bağlanır (çık-gir sonrası "ses gelmiyor" hatasının kaynağı).
- **Yankı/gürültü giderme açık kalır.** Ses WebAudio'dan geçirilmez; geçirilirse tarayıcının AEC/NS/AGC
  özellikleri kapanır ve ses robotikleşir.
