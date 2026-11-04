# Ses Kanalı

Hesapsız, tarayıcıdan girilen Discord'umsu sunucu: **yazılı kanallar** (geçmişi veritabanında tutulur,
dosya paylaşılabilir) + **sesli kanallar** (ses tarayıcılar arasında doğrudan, P2P akar). Arayüzde
sunucunun adı **Diszort** (logo: üstü kırmızı çarpıyla çizilmiş Discord yüzü; sekme başlığı ve simge de).

- **Giriş (beyaz liste):** Adını yazarsın; içerideki herkese *"X girmek istiyor"* diye sorulur. Biri kabul
  ederse sana **yalnızca sende olan bir anahtar** verilir ve tarayıcında saklanır — sonraki girişlerde soru
  sorulmaz. Reddedilirsen ya da içeride kimse yoksa giremezsin. Beyaz liste en fazla **10 kişi** alır
  (`.env`: `MAX_KULLANICI`); içeridekiler bu limiti sağdaki **− / +** düğmeleriyle arttırıp azaltabilir
  (değer veritabanına yazılır, yeniden başlatmada korunur).
- **Atma:** İçeridekiler birbirini atabilir (sağdaki üye listesinde `✕`); atılanın anahtarı iptal edilir.
- **İlk anahtar:** Beyaz liste boşken sunucu ilk anahtarı üretir ve `/var/lib/chat/ilk-anahtar.txt` dosyasına
  yazar. Bağlantıyı bir kez açmak yeter: `https://…/#anahtar=<anahtar>` anahtarı tarayıcıya kaydeder.
- **Arayüz:** Solda yazılı (`#genel`, `#muhabbet`) ve sesli (Sesli Sohbet, Müzik, Oyun) kanallar;
  ortada sohbet (aynı kişinin ardışık mesajları gruplanır, bağlantılar tıklanabilir, resimler büyütülür,
  yukarı kaydırınca eski mesajlar yüklenir, aşağıda değilken gelen mesaj için "Yeni mesaj" düğmesi);
  sağda üyeler (önce çevrimiçiler, altında beyaz listede olup **çevrimdışı** olanlar); sesli kanaldayken
  sohbetin altında katılımcı kartı (konuşma halkası, kişi başı ses seviyesi, mikrofon/sağırlaştır/ayrıl,
  küçültülebilir). Telefonda kanallar ☰ ile, üyeler sağ üstteki düğmeyle yandan açılır; masaüstünde aynı
  düğme üye panelini gizler. Kapıyı çalan kayıtlı bir adla gelirse istek kartında uyarı çıkar.
- **Kanal ekle / sil:** Her bölümün başındaki `＋` ile yazılı veya sesli kanal açılır; kanal adının
  yanındaki `✕` ile silinir (yazılı kanal silinince mesajları ve dosyaları da gider, sesli kanal
  silinince içindekiler çıkarılır). Tek sunucu olduğu için en solda sunucu şeridi yoktur.
- **Yazılı kanallar sunucudan geçer ve saklanır:** mesajlar SQLite'ta (`/veri/sohbet.db`), paylaşılan
  dosyalar `/veri/yuklemeler/` altında. Geçmiş sayfa yenilenince de yerinde durur.
- **Dosya paylaşımı:** ataç düğmesi, sürükle-bırak ya da panodan yapıştırma; en fazla `DOSYA_MB` (varsayılan 25 MB).
  Resim/ses/video önizlemesi satır içinde, diğerleri indirme bağlantısı olarak gösterilir.
- **Ses doğrudan (P2P):** Sesli kanaldakiler birbirine tarayıcıdan tarayıcıya bağlanır (mesh WebRTC).
  Ses sunucudan geçmez; sunucu yalnızca kimin hangi kanalda olduğunu söyler ve bağlantı tekliflerini iletir.
  Doğrudan bağlanamayanların (CGNAT, simetrik NAT) sesi TURN üzerinden aktarılır (UDP; UDP'yi engelleyen
  ağlar için TCP 3478 yedeği).
- **Sesli kanalda:** Konuşanın avatarı yeşil halkayla yanar; kişi başına (yalnızca sende) susturma ve ses
  seviyesi (kalıcı), bağlantı türü (P2P / TURN), gecikme ve kayıp; kendi mikrofonunu kapatma ve
  **sağırlaştırma** (gelen sesleri kapat) — kenar çubuğunda ve ses kartında düğme, `Ctrl+Shift+M` /
  `Ctrl+Shift+D`. Susturulmuş/sağır olanlar diğerlerine simgeyle görünür. Mikrofonu olmayan ya da izin
  vermeyen kanala **dinleyici** olarak girer.
- **Ses ayarları** (sol alttaki kaydırıcı simgesi): mikrofon ve hoparlör seçimi, mikrofon seviyesi
  (%0–200), "Mikrofonu dene" seviye göstergesi, gürültü bastırma / yankı engelleme / otomatik ses düzeyi
  (AGC) anahtarları, gönderilen kalite (48 / 96 / 128 kbps), giriş/çıkış sesleri. Tarayıcıda saklanır.
- **Kopmalara dayanıklı:** Sunucu bağlantısı koparsa (ağ değişti, sunucu güncellendi) ses bağlantıları
  kapanmaz — P2P konuşma sürer; arayüz kendiliğinden yeniden bağlanır ve sesli kanala "devam" eder.
  Bozulan eş bağlantıları kendiliğinden onarılır (önce ICE yenileme, olmazsa baştan kurma). Sunucu yeni
  sürüme geçince açık sekmeler kendini yeniler, sesli kanala ve yazılmakta olan mesaja geri döner.
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

**Güvenlik duvarı:** STUN/TURN için UDP `3478`, TCP `3478` (UDP'yi engelleyen okul/iş/otel ağları için
yedek) ve UDP `49152-61000` dışarıya açık olmalı. GCP'de:

```sh
gcloud compute firewall-rules create allow-turn --allow=udp:3478,tcp:3478,udp:49152-61000
# Eski kurulumda UDP kuralı zaten varsa yalnızca TCP'yi ekle:
gcloud compute firewall-rules create allow-turn-tcp --allow=tcp:3478
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
| `/var/lib/chat/sohbet.db` (+ `-wal`, `-shm`) | beyaz liste (kişiler + anahtarlar), kanal listesi, mesajlar ve dosya kayıtları (SQLite) |
| `/var/lib/chat/ilk-anahtar.txt` | beyaz liste boşken üretilen ilk anahtar (okuduktan sonra silinebilir) |
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

Üç deneme takımı var; GitHub Actions her push'ta üçünü de Docker imajına karşı çalıştırır:

- **Sunucu** — `make test` (ya da `node test/dene.js http://adres:port`), 31 deneme: beyaz liste (anahtarlı
  giriş, kapıyı çalma, kabul/red, geçersiz/eski biçim anahtar, kimse yokken giriş, atma, liste doluluğu,
  giriş freni kovası, kişi limiti, aynı isteği iki kişinin kabul etmesi, sonradan gelene bekleyen istekler,
  kayıtlı ad uyarısı, aynı anahtarla ikinci sekmenin oturumu devralması) + web sayfası, sağlık, `/api/ice`
  (yalnızca oturumla), STUN, TURN (doğru/yanlış şifre), yazılı sohbet (gönderme, iletme, geçmiş, hız sınırı),
  dosya paylaşımı, sesli kanal signaling'i (oturum/yenile iletimi, kopanın askıda kalıp geri dönmesi ve
  süresi dolunca çıkarılması, doluluk — dolu kanala geçemeyen eski kanalında kalır), kanal ekleme/silme.
  **Not:** denemeler gerçek veritabanına birkaç `(deneme)` mesajı ve küçük bir dosya bırakır.
- **Arayüz (tarayıcısız)** — `make arayuz` (jsdom), 150 denetim: giriş akışları, mesaj çizimi (gruplama,
  bahsetme, tıklanabilir bağlantılar, HTML'in çalışmaması), kanal/üye/istek arayüzü, sesli kanal (mikrofon
  kısıtları, teklif/yanıt + oturum kimliği, Opus ayarları, yinelenen teklif), susturma/sağırlaştırma,
  istatistikler, sunucu koparken ses bağlantılarının korunması, giriş freninde uygulamada kalma, oturum
  devri, atılma, ses ayarları.
- **Gerçek tarayıcı** — `make tarayici` (Playwright + Chromium, sahte mikrofona konuşmaya benzeyen ses
  verilir; kendi sunucusunu açar), 12 deneme: arayüzden giriş, üç kişilik mesh'te herkesin herkesi
  duyması (gelen sesin **enerjisi** ölçülür, yalnızca bayt değil), ~96 kbps Opus, susturma/sağırlaştırmanın
  sesi gerçekten kesmesi, kişi başı ses seviyesi, çık-gir, mikrofon aygıtı çıkarılınca kendiliğinden yeniden
  alma, sayfa yenileme, **sunucu yeniden başlarken P2P sesin kesilmemesi** ve herkesin (10 sn frenle)
  kendiliğinden dönmesi, yalnızca TURN (relay) ile bağlantı ve coturn yeniden başlayınca taze şifreyle
  ICE yenilemesi (~3 sn), ikinci sekmenin oturumu devralması. Çalışan sunucuya karşı:
  `ILK_ANAHTAR=… YENIDEN_BASLAT='komut' node test/tarayici.js http://adres:port`.
  Gerçek tarayıcıyı VPS'te çalıştırmak gerekmez; CI'da çalışır.

## Nasıl çalışır

```
tarayıcı ──HTTPS──> Caddy :443 ──> 127.0.0.1:8080  konteyner ─┬─ web sayfası (web/)
                                                              ├─ /rtc       WebSocket: sohbet + kanallar + SDP/ICE
                                                              ├─ /api/yukle dosya yükleme (jetonlu)
                                                              ├─ /dosya/<id> yüklenen dosyayı sun
                                                              ├─ /api/ice   STUN/TURN adresi + geçici şifre (yalnızca jetonla)
                                                              └─ /saglik
tarayıcı <══ses (doğrudan)══> tarayıcı
tarayıcı ──UDP/TCP 3478──> coturn (konteynerde, sunucu.js başlatır) ──UDP 49152-61000──> tarayıcı   (yalnızca doğrudan olmazsa)
```

- **İmaj:** `Dockerfile` küçük bir Debian'ı (node, node-ws, node-sqlite3, coturn) ve bu depodaki dosyaları
  tek imaja paketler; GitHub Actions `ghcr.io`'ya yükler. Sunucuda derleme yoktur, yalnızca çekme.
- **Konteyner:** Tek süreç: `sunucu.js` web sayfasını, sohbeti, dosyaları ve signaling'i yönetir; coturn'ü
  kendisi başlatıp izler (biri düşerse konteyner iki saniyede yeniden başlar). Kök olmayan kullanıcı
  (uid 1000) ile çalışır. Sunucunun ağını paylaşır (`network_mode: host`): TURN çok sayıda UDP portu kullanır.
- **Beyaz liste:** `kisi` tablosu (`ad` birincil anahtar, `anahtar` kişiye özel). Onayda **512 bit**
  (128 hex) anahtar üretilir; aynı ad yeniden onaylanırsa anahtar döner (cihaz değişti). Anahtar
  `localStorage`'da tutulur, HTTPS üzerinden gönderilir. **Yalnızca 512 bit anahtarlar kabul edilir**;
  eski/kısa biçimdeki anahtar geçersiz sayılır ve kapıyı çalma akışına düşer.
- **Giriş freni (sunucu tarafı):** TÜM giriş denemeleri sunucu genelinde **10 saniyede 1** ile sınırlıdır —
  bağlantı, kişi, ilk deneme ayrımı yok; geçerli anahtarla yapılan deneme de freni bekler. Fren tek bir
  jeton kovasıdır: kova her `GIRIS_ARALIK_MS`'de bir dolar, en fazla `GIRIS_KOVA` jeton birikir (varsayılan
  10000 ms ve **1**). Fren yalnızca sunucuda uygulanır (istemci kodu değiştirilerek aşılamaz) ve bekleme
  sunucuda tutulmaz: istek anında reddedilir ve ne kadar bekleneceği söylenir (`giris-red {kod:'fren',
  bekle}`); arayüz o kadar bekleyip **kendiliğinden yeniden dener** (eskiden giriş ekranına atıyor,
  mikrofonu da açık bırakıyordu). Sunucu yeniden başlayınca (her güncellemede) içeridekiler bu yüzden 10'ar
  saniye arayla döner; P2P ses bu arada kesilmez, TURN'den geçen ses iki taraf da dönünce yenilenir.
  **Testler için arttırılabilir:** `GIRIS_KOVA=N` ile N deneme birikir (yeniden başlatmada N kişi
  beklemeden döner); testler `GIRIS_ARALIK_MS`'yi de küçültür.
- **Aynı anahtar ikinci sekmede:** son giren kazanır; eski sekmeye haber verilir ve o sekme kendiliğinden
  yeniden bağlanmaz ("Bu sekmede devam et" düğmesi çıkar). Eskiden "başka bir cihazdan bağlı" diye
  reddediliyordu: ağ değişince kopan eski bağlantı sunucu fark edene kadar kişiyi dışarıda bırakıyordu.
  Ayrı olarak kapıyı çalma istekleri IP başına dakikada 600, atma işlemleri 60 ile sınırlı. Kişi limiti
  çalışırken değiştirilebilir (`ayar` tablosunda `kisi_limiti`); `.env` yalnızca varsayılanı verir.
- **Kanallar:** Veritabanındaki `kanal` tablosunda (id, ad, tur, sıra). İlk kurulumda varsayılanlar
  yazılır; sonrasında arayüzden eklenip silinir (en fazla 40, ad 24 karakter, aynı türde aynı ad yok).
  Kanal kimliği addan üretilir ("Sesli Sohbet" → `sesli-sohbet`), çakışırsa sonuna sayı eklenir.
  Silme: yazılı kanalın mesaj/dosya kayıtları silinir ve dosyaları diskten kaldırılır; sesli kanaldaysa
  içindekilere `ses-kapatildi` gönderilir. Son yazılı/sesli kanal silinemez.
- **Veritabanı:** `sunucu/veritabani.js`, `sohbet.db` (WAL). Tablolar: `mesaj` (kanal, ad, metin, dosya_id,
  zaman), `dosya` (id, kanal, ad, boyut, tur, zaman), `kisi` (beyaz liste), `kanal` (kanal listesi) ve
  `ayar` (ad, deger — çalışırken değişen ayarlar, ör. `kisi_limiti`). Ölçek küçük: tek dosya, indeks `(kanal, id)`.
- **Dosya güvenliği:** yükleme `Authorization: Bearer <jeton>` ister (jeton oturum açınca verilir, sayfa
  yenilenince yenilenir). Dosya adı temizlenir, dosyalar `<id>` olarak saklanır (yol oyunu imkânsız),
  yalnızca resim/ses/video uzantıları satır içi sunulur; HTML/SVG gibi türler `Content-Disposition: attachment`
  ile indirilir, yanıt `nosniff` + `default-src 'none'` başlıkları taşır. Toplam boyut `DOSYA_MB`, sunucuda
  300 MB'dan az boş yer kalırsa yükleme reddedilir.
- **Yazma hızı:** kişi başı 10 saniyede 12 mesaj; mesaj uzunluğu 2000 karakter.
- **TURN şifreleri:** coturn `use-auth-secret` ile çalışır; sır her açılışta bellekte üretilir. Bir günlük
  kullanıcı adı + HMAC şifresi **yalnızca içeridekilere** verilir (`hazir` ve `ses-girdi` mesajlarında, ya da
  `Authorization: Bearer <jeton>` ile `/api/ice`): eskiden `/api/ice` herkese açıktı, beyaz listede olmayan
  biri de sunucuyu ücretsiz aktarıcı olarak kullanabiliyordu. İstemci her bağlanışta taze şifre alır (eskiden
  sayfa açılışındaki şifreyi saklıyordu → her güncellemeden sonra TURN'e muhtaç olanlar sayfayı yenileyene
  kadar bağlanamıyordu). Sunucu coturn hazır olunca dinlemeye başlar (yoksa hemen bağlanan istemci boş
  liste alıyordu). İç ağa aktarım yasaktır (`TURN_IZINLI_IP` ile tek tek açılabilir, yalnızca özel
  kurulum/test); kullanıcı ve toplam aktarım sayısı ile bant genişliği (aktarım başına 512000 B/s) sınırlıdır.
- **Kopan bağlantı askıda:** sesli kanaldayken bağlantısı beklenmedik şekilde kopanın yeri `SES_ASKI_MS`
  (varsayılan 20 sn) askıda tutulur; bu sürede geri gelip `ses-gir {devam:true}` derse diğerlerine çıktı/girdi
  denmez ve P2P konuşma kesilmeden sürer. Sekmeyi kapatan açıkça `ses-cik` gönderir (hemen çıkar).

### WebSocket protokolü (`/rtc`, JSON)

| İstemci → sunucu | Anlamı |
|---|---|
| `giris {ad, id, anahtar, ses}` | anahtar geçerliyse doğrudan girer; yoksa kapıyı çalar (`bekleniyor`). Sunucu genelinde jeton kovası (`giris-red {kod:'fren', bekle}`). `ses`: yeniden bağlanırken sürdürülecek sesli kanal (askıdaki yer korunur) |
| `giris-karari {id, kabul}` | içerideki biri isteği kabul/red eder (kabulde anahtar üretilir) |
| `giris-iptal` | kapıyı çalan isteğini geri çeker |
| `at {ad}` | kişiyi beyaz listeden atar (anahtarı iptal edilir, bağlantısı düşer) |
| `beyaz-liste` | beyaz listeyi ister (içeridekiler görebilir) |
| `kisi-limiti {deger}` | beyaz listedekiler kişi limitini değiştirir (2–50; veritabanına yazılır, herkese duyurulur) |
| `yazi {kanal, metin}` | yazılı kanala mesaj gönder (veritabanına yazılır, herkese iletilir) |
| `gecmis {kanal, once}` | son 50 mesaj; `once` verilirse ondan daha eskiler |
| `yaziyor {kanal}` | "yazıyor" göstergesi |
| `ses-gir {kanal, devam, sessiz, sagir}` / `ses-cik` | sesli kanala gir / çık. `devam`: eş bağlantıları ayakta (kopup geri gelindi), diğerleri de yeniden kurmasın |
| `kanal-ekle {tur, ad}` / `kanal-sil {kanal}` | yazılı (`yazi`) veya sesli (`ses`) kanal ekle / sil |
| `sdp {to, sdp, oturum}` / `ice {to, ice, oturum}` | WebRTC (aynı sesli kanaldaki kişiye). `oturum`: eş bağlantısının kimliği (teklif eden üretir; eskisine ait yanıt/aday ayıklanır) |
| `yenile {to, oturum}` | yanıtlayan taraf: "bağlantımız bozuk ya da bende yok" → teklif eden ICE'yi yeniler ya da baştan kurar |
| `sessiz {sessiz, sagir}` | mikrofon kapalı / sağırlaştırılmış mı (diğerlerine gösterilir) |
| `ice-iste` | taze STUN/TURN şifresi (`ice-sunuculari {ice}` döner) |
| `tani {veri}` | hata ayıklama: ses durumu (sunucu yalnızca günlüğe yazar, `TANI=0` ile kapalı) |
| `ping` | bağlantı canlı tutma |

| Sunucu → istemci | Anlamı |
|---|---|
| `hazir {ad, kanallar, kimler, beyazListeAdlari, max, dosyaMb, jeton, ice, surum, turnNesli, anahtar?}` | giriş kabul edildi; `anahtar` yalnızca yeni verildiğinde gelir. `surum` değişirse sekme kendini yeniler; `turnNesli` değişirse coturn yeniden başlamıştır (TURN bağlantıları hemen yenilenir) |
| `bekleniyor {ad, anahtarGecersiz}` | kapıyı çaldın, içeridekilerin kararı bekleniyor |
| `giris-red {message, kod, bekle?}` | giriş reddedildi; `kod`: `fren` (bekle ms sonra yeniden dene), `anahtar`, `ad`, `ad-kullaniliyor`, `dolu`, `kimse-yok`, `reddedildi`, `cok-istek`, `zaman-asimi` |
| `giris-istegi {id, ad, kayitli}` / `istek-kapandi {id, kabul}` | içeridekilere gelen onay isteği ve sonucu. `kayitli`: ad zaten beyaz listede (kabul edilirse eski cihazın anahtarı iptal olur; kartta uyarı çıkar). Sonradan gelen/geri bağlanan da bekleyen istekleri alır |
| `atildi {message}` | beyaz listeden atıldın (anahtarın iptal edildi) |
| `oturum-devralindi {message}` | aynı anahtarla başka sekmede girildi; bu sekme durur |
| `kanallar` / `kimler` | kanal doluluğu / çevrimiçi kişiler değişti (`kimler` ayrıca `beyazListe`, `beyazListeAdlari` ve `maxKullanici` taşır) |
| `yazi {kanal, mesaj}` / `gecmis {kanal, mesajlar, bitti}` | yeni mesaj / geçmiş |
| `yaziyor`, `sessiz` | göstergeler |
| `ses-girdi {kanal, kisiler, ice, devam}`, `ses-kisi-girdi {ad, devam}`, `ses-kisi-cikti` | sesli kanal üyeleri (`kanallar` yayınında kopan kişi `askida:true` görünür) |
| `ses-kapatildi {kanal}` | sesli kanal silindi, çıkarıldın |
| `sdp {from, sdp, oturum}` / `ice {from, ice, oturum}` / `yenile {from, oturum}` | WebRTC |
| `hata {message, kod?}` | reddedildi / sorun (`ses-dolu`, `ses-kanal-yok`) |

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
| `test/dene.js` | çalışan sunucuyu uçtan uca dener (31 deneme; giriş frenine uyar) |
| `test/arayuz.js` | arayüzü tarayıcısız dener (jsdom; 150 denetim) |
| `test/tarayici.js` | gerçek Chromium'la sesli kanalı dener (Playwright; 12 deneme, sesin enerjisi ölçülür) |
| `.github/workflows/docker.yml` | push → derle, `kur.sh` ile kur, üç deneme takımını çalıştır, ghcr.io'ya yükle, sürüm çıkar |

## Sınırlar

- Mesh olduğu için her kişi kanaldaki herkese ayrı ses gönderir: kişi başı gönderim hızı kalabalık
  kanalda kendiliğinden düşer (toplam ~640 kbps'yi geçmesin: 6 kişiye kadar 96, 10 kişide ~71 kbps).
  Daha kalabalık odalar için SFU (ör. LiveKit, mediasoup) gerekir.
- İçeri yalnızca içeridekilerin onayıyla girilir; hesap/şifre yok, içerideki herkes herkesi atabilir.
  Adlar sunucu genelinde benzersiz.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~100 kbps).
- Yalnızca IPv4 TURN.
- Ses/görüntü **hiçbir yere kaydedilmez**; yalnızca yazılı mesajlar ve paylaşılan dosyalar saklanır.

### Ses kalitesi

Ölçümler gerçek Chromium'da (`test/tarayici.js`) yapıldı; ses **eşikten/kapıdan geçmez** (VAD, gate yok).

- **Opus ~96 kbps (eskiden fiilen ~28 kbps).** Tarayıcılar Opus'u kendiliğinden ~32 kbps'de tutar; eski kod
  yalnızca `setParameters(maxBitrate)` kullanıyordu, bu da yalnızca Chrome'da işe yarıyordu (iPhone/Safari ve
  Firefox ~30 kbps'de kalıyordu). Artık karşı tarafın SDP'sindeki Opus parametreleri ayarlanıyor
  (`maxaveragebitrate`, `useinbandfec=1` kayıpta yedek veri, `usedtx=0` sessizlikte kesip açma yok,
  `maxplaybackrate=48000` tam bant) — bu yol bütün tarayıcılarda geçerli; `maxBitrate` de ayrıca ayarlanıyor.
  Ayarlardan 48 / 96 / 128 kbps seçilebilir; kalabalık kanalda kişi başı hız kendiliğinden düşer.
- **Yankı engelleme ve gürültü bastırma açık, otomatik kazanç (AGC) kapalı** (AGC konuşma boyunca mikrofon
  düzeyini oynatıyordu). Üçü de ses ayarlarından açılıp kapatılabilir; kulaklık kullanan yankı engellemeyi
  kapatırsa ses biraz daha doğal olur. Sessiz mikrofonu olan kendi **mikrofon seviyesini** %200'e kadar
  açabilir: seviye %100 değilse ses WebAudio kazancından geçer (yankı/gürültü giderme yakalamada uygulandığı
  için kapanmaz); %100'de mikrofon izi doğrudan gönderilir. Ses bağlamı askıya alınırsa (iOS arka plan)
  kazanç zinciri sessizlik üretmesin diye ham ize geri dönülür.
- **Konuşma göstergesi** RMS ile ölçülür (-48 dBFS eşik, 350 ms bekleme): kelime arasında yanıp sönmez.
- **Kopmalara dayanıklılık:** sunucu bağlantısı koparken ses bağlantıları korunur (P2P konuşma sürer);
  bozulan bağlantıyı teklif eden önce **ICE yenilemesiyle** (DTLS korunur) onarır, iki denemede olmazsa
  baştan kurar; yanıtlayan `yenile` ister. coturn yeniden başlarsa (`turnNesli` değişir) TURN'den geçen
  bağlantılar ölmeleri beklenmeden taze şifreyle yenilenir (ölçüm: ~3 sn). İki önemli hata giderildi:
  ICE yenilemesinde yanıtlayan taraf eski TURN şifresiyle aday topluyordu (relay hiç gelmiyordu) ve aynı
  ICE yenileme teklifi iki kez uygulanınca yeni aday çifti seçildiği halde ses akmıyordu.
- **"Takılma kurtarma" hiç çalışmıyordu:** sayaç başlangıç değeri olmadığı için (`undefined + 1 = NaN`) hiç
  bağlanamamış bağlantılar için ICE yenilemesi hiç denenmiyordu.
- **Tek yönlü ses:** yanıtlayan taraf ses kanalını önceden açmaz (teklifin m-line'ıyla eşleşmiyor, yanıt
  "recvonly" çıkıyordu); teklifteki kanalın yönü her zaman `sendrecv` yapılır, mikrofon yoksa bile
  (eskiden mikrofonsuz yanıt "recvonly" kalıyor, mikrofon sonradan gelince hiç gönderilmiyordu).
- **Mikrofon aygıtı çıkarılırsa / izi biterse** (kulaklık takıldı, telefon araması) kendiliğinden yeniden
  alınır ve eşlere yeniden anlaşmadan bağlanır.
- **Gelen ses** `<audio>` öğesiyle çalınır (yankı engelleme referansı olarak); öğeler görünmez ama çizilir
  (iOS Safari `display:none` öğeyi çalmıyor). Ses başlamazsa ses kartında görünen **"Sesi başlat (dokun)"**
  düğmesi çıkar; bir gözcü 1 saniyede bir çalmayanı yeniden dener. Eskiden iOS için her tuşa/dokunuşa sessiz
  bir ses çalınıyordu: sitenin kendi CSP'si (`media-src 'self' blob:`) bunu her seferinde engelliyordu
  (hiç çalışmamıştı) ve iOS'ta arka plandaki müziği durdurabilirdi; kaldırıldı.
- **Bağlantı bilgisi:** her kişi için `P2P/TURN · gecikme` (kayıp %1'i geçerse o da) görünür: doğrudan
  (P2P) bağlananlar yeşil, **TURN (relay) üzerinden bağlananlar turuncu**, ciddi sorun (≥%5 kayıp,
  mikrofon gitmiyor) kırmızı; ipucunda kayıp, gelen/giden kbps, titreşim. Sol alttaki ses panelinin rengi
  genel durumu gösterir.
- **Uzaktan teşhis:** istemci 10 saniyede bir kendi ses durumunu (`yön`, `in/out kbps`, `kayıp`, oturum,
  kurtarma sayısı, mikrofon ayarları, tarayıcı) `tani` mesajıyla gönderir; sunucu **yalnızca günlüğe** yazar
  (`sudo docker logs ses-kanali | grep tanı`). Veritabanına yazılmaz, kimseye dağıtılmaz; `.env`'de `TANI=0`
  ile kapatılır. Teşhis için tarayıcıda `localStorage.setItem('zorla-turn','1')` yalnızca TURN kullanır.
