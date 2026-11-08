# Diszort

Arkadaş grupları için tarayıcıdan girilen, Discord benzeri küçük bir sohbet sunucusu. Yazılı kanallar
sunucuda saklanır; sesli kanallarda ses, ekran ve sekme sesi paylaşımı kişiler arasında doğrudan (P2P) akar,
doğrudan bağlanamayanlar için sunucudaki TURN aktarır. Dosyalar da sunucuya yüklenmez, paylaşandan
doğrudan alınır. İçeri yalnızca içeridekilerin onayıyla girilir.

## Özellikler

- **Beyaz liste:** Yeni gelen adını yazar; içeridekilerden biri onaylarsa tarayıcısına kişisel bir
  anahtar kaydedilir ve sonraki girişlerde soru sorulmaz. İçeridekiler birbirini atabilir.
- **Yazılı kanallar:** mesaj geçmişi, bahsetme, tıklanabilir bağlantılar, resim büyüteci.
- **P2P dosya paylaşımı, boyut sınırı yok:** dosya sunucuya yüklenmez; sohbete yalnızca adı ve boyutu
  düşer, isteyen doğrudan paylaşanın tarayıcısından alır. Paylaşan sayfayı açık tuttukça indirilebilir
  (sayfayı yenilerse "Yeniden paylaş" ile aynı dosyayı yeniden sunar). Kopan aktarım kaldığı yerden
  sürer; büyük dosyalar belleğe değil doğrudan diske yazılır. Küçük resimler sohbette önizlenir.
- **Sesli kanallar:** kanal başına 10 kişiye kadar, yüksek kaliteli Opus (~96 kbps), konuşma göstergesi,
  kişi başı ses seviyesi, susturma ve sağırlaştırma, mikrofon/hoparlör seçimi, gürültü bastırma.
- **Ekran paylaşımı ve birlikte müzik** (ses kartındaki paylaş düğmesi, masaüstünde):
  - *Ekranını paylaş*: ekran, pencere ya da sekme; istenirse sesiyle. İstemeyen görüntüyü kapatır
    (ona hiç gönderilmez).
  - *Sekme sesini paylaş*: Spotify/YouTube çalan sekmenin (Windows'ta istenirse tüm bilgisayarın) sesi
    kanala stereo ve yüksek kalitede gider. Kanalda ayrı bir kişi gibi görünür: sesi taha paylaşıyorsa
    **taha - YouTube** (adı paylaşırken yazılır, son ad hatırlanır). Herkes onu bir kişi gibi kendi için
    susturur ya da sesini ayarlar; ses gelince konuşma halkası yanar.
  - Telefon tarayıcıları (Android, iOS) ekranı da telefonun sesini de yakalayamaz; telefondan
    paylaşılanlar izlenir ve dinlenir.
- **Bağlantı göstergesi:** yalnızca ses gerçekten bozulunca (alıcının uydurmak zorunda kaldığı ses) uyarır;
  tek kişinin bağlantısı kötüyse yalnızca onun kutusunda görünür.
- **Sunucu penceresi** (sol üstteki veritabanı simgesi): veritabanının boyutu ve mesaj sayısı;
  *Sohbeti temizle* tüm kanallarda ya da tek kanalda, hepsini ya da belli bir süreden eskileri siler.
  Yalnızca yazılı mesajlar silinir; beyaz liste, kanallar ve ayarlar kalır.
- **Kopmalara dayanıklı:** sunucu bağlantısı koparsa ya da telefon siteyi arka plana alırsa ses sürer,
  bağlantı kendiliğinden geri gelir.
- Kanallar arayüzden eklenip silinir; masaüstünde ve telefonda çalışır.

## Kurulum

Gerekenler: Docker (compose eklentisiyle) ve HTTPS için bir alan adı.

```sh
curl -fsSL https://github.com/TahaGemici/diszort/releases/latest/download/kur.sh | sudo sh
```

Betik imajı `ghcr.io/tahagemici/diszort`'tan çeker, ayarları ve veritabanını `/var/lib/chat` altında
oluşturur ve `diszort` konteynerini başlatır. Güncellemek için aynı komut çalıştırılır; belirli bir
sürüme dönmek için sonuna `-s v23` gibi bir sürüm eklenir.

**Açık olması gereken portlar:** TCP 80 ve 443 (HTTPS), UDP ve TCP 3478 (STUN/TURN), UDP 49152–61000
(TURN aktarımı).

**HTTPS:** Mikrofon yalnızca HTTPS'te çalışır. Caddy ile örnek: [`kurulum/Caddyfile`](kurulum/Caddyfile)
(`/etc/caddy/Caddyfile`, alan adı → `127.0.0.1:8080`). TURN Caddy'den geçmez.

**İlk giriş:** Beyaz liste boşken sunucu ilk anahtarı üretir ve giriş bağlantısıyla birlikte
`/var/lib/chat/ilk-anahtar.txt` dosyasına yazar. Bağlantı bir kez açılınca anahtar tarayıcıya kaydedilir;
dosya sonra silinebilir.

## Ayarlar

`/var/lib/chat/.env` dosyasında; değişiklikten sonra `sudo docker restart diszort`. Hepsi isteğe bağlıdır.

| Ayar | Varsayılan | Anlamı |
|---|---|---|
| `MAX_KULLANICI` | 10 | beyaz listedeki en fazla kişi (arayüzden de değiştirilebilir) |
| `MAX_KISI` | 10 | sesli kanal başına en fazla kişi |
| `YONETICI_ADI` | taha | ilk anahtarın sahibi |
| `SITE_ADRESI` | | ilk anahtar bağlantısındaki site adresi |
| `GIRIS_ARALIK_MS`, `GIRIS_KOVA` | 10000, 1 | giriş freni: sunucu genelinde 10 saniyede 1 deneme |
| `SES_ASKI_MS` | 60000 | bağlantısı kopanın sesli kanaldaki yeri bu kadar korunur |
| `DIS_IP`, `TURN_ADRESI` | kendiliğinden | TURN'ün duyurduğu adres |
| `TANI` | 1 | ses teşhis satırlarını günlüğe yaz (0: kapalı) |

Tam liste ve açıklamalar: [`.env.example`](.env.example).

## Yönetim

| İş | Komut |
|---|---|
| Günlük | `sudo docker logs -f diszort` |
| Yeniden başlatma | `sudo docker restart diszort` |
| Sağlık | `curl http://127.0.0.1:8080/saglik` (veritabanı boyutu dahil) |
| Yedek | `/var/lib/chat` (ayarlar, `sohbet.db*`; eski sürümün yüklediği dosyalar `yuklemeler/`) |
| Sohbeti temizle | arayüzde sol üstteki veritabanı simgesi → *Sohbeti temizle* |

## Geliştirme

```sh
make            # node ile çalıştır (node, npm ve coturn gerekir) → http://127.0.0.1:8080
make docker     # ya da Docker ile
make test       # sunucu denemeleri (çalışan sunucuya karşı, ILK_ANAHTAR ile)
make arayuz     # arayüz denemeleri (jsdom)
make tarayici   # gerçek Chromium'la sesli kanal denemeleri (Playwright)
```

`main`'e her gönderimde GitHub Actions imajı derler, üç deneme takımını imaja karşı çalıştırır,
`ghcr.io`'ya yükler ve sürüm çıkarır.

Yapı: `sunucu/` (Node: web, sohbet, signaling, coturn yönetimi, SQLite), `web/` (düz HTML/CSS/JS),
`kurulum/` (kurulum betiği, Caddy örneği), `test/`. WebSocket protokolü `sunucu/sunucu.js` içinde
açıklanmıştır.

## Güvenlik

- Depoda gizli bilgi yoktur. Beyaz liste anahtarları yalnızca sunucudaki veritabanında ve kişinin
  tarayıcısında durur. TURN sırrı her açılışta yeniden üretilir ve konteynerin dışına yazılmaz.
- `ILK_ANAHTAR` yalnızca testler içindir, üretimde boş kalmalıdır. CI'daki anahtar herkesin bildiği bir
  test değeridir.
- Ses, görüntü ve dosyaların içeriği sunucuya gelmez ve hiçbir yere kaydedilmez; yalnızca yazılı mesajlar
  ve paylaşılan dosyaların adı/boyutu saklanır.

## Sınırlar

- Ses ve yayın mesh ile taşınır: herkes kanaldaki herkese ayrı akış gönderir, bu yüzden kanal başına
  ~10 kişi. Ekran paylaşan, izleyen her kişiye ayrı görüntü gönderir (kişi başı en fazla 2,5 Mbit/s,
  toplam ~6 Mbit/s); yayını kapatana gönderilmez. Daha kalabalık odalar için SFU gerekir.
- Ekran ve sekme sesi paylaşımı tarayıcıya bağlıdır: Chrome/Edge'de en iyisi (Windows'ta tüm
  bilgisayarın sesi de, macOS ve Linux'ta sekme sesi); Firefox ve Safari ses paylaşamaz; telefon
  tarayıcıları hiç paylaşamaz. İzlemek ve dinlemek her yerde olur. Tarayıcı paylaşılan sekmenin adını
  sayfaya söylemediği için ad ("YouTube") paylaşırken sorulur. Hoparlörden dinleyenin mikrofonu çalan
  sesi de alır; kulaklık önerilir.
- P2P dosya, paylaşanın sayfası açıkken alınabilir. Chrome/Edge (masaüstü) büyük dosyayı doğrudan seçilen
  yere yazar; diğer tarayıcılar önce tarayıcının dosya alanına (kotası diskin bir kısmı) yazar.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~100 kbps); TURN'den geçen dosya
  aktarımı ~0,5 MB/sn ile sınırlıdır (doğrudan bağlanabilenler sınırsız). Yalnızca IPv4.
