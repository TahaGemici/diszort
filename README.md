# Diszort

Arkadaş grupları için tarayıcıdan girilen, Discord benzeri küçük bir sohbet sunucusu. Yazılı kanallar
sunucuda saklanır; sesli kanallarda ses ve ekran paylaşımı (ekranlı ya da ekransız, yalnızca ses)
kişiler arasında doğrudan (P2P) akar, doğrudan bağlanamayanlar için sunucudaki TURN aktarır. Dosyalar
da sunucuya yüklenmez, paylaşandan doğrudan alınır. İçeri yalnızca içeridekilerin onayıyla girilir.

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
- **Ekran paylaşımı ve birlikte dinleme** (ses kartındaki paylaş düğmesi):
  - *Ekranını paylaş*: ekran, pencere ya da sekme; istenirse sesiyle. İstemeyen görüntüyü kapatır
    (ona hiç gönderilmez, ses yine gelir).
  - *Ekransız paylaş*: bilgisayarın ya da Spotify/YouTube çalan sekmenin sesini paylaşmak da bir ekran
    paylaşımıdır, yalnızca ekran kimseye gönderilmez: ses kanala stereo ve yüksek kalitede gider.
    Paylaşan ekranı sonradan yeniden seçmeden gösterip gizleyebilir. Firefox ve Safari ekran
    paylaşımında ses vermediği için orada ses bir ses aygıtından alınır (Linux'ta bilgisayarın sesi
    "Monitor of …" aygıtıdır). Kanaldakilerin konuşması bu sesten çıkarılır: sayfa ne çaldığını
    bilir, gecikmesini ve seviyesini bulup yakalanan sesten çıkarır (tarayıcının yankı engelleyicisi
    kullanılmaz, müzik eşiksiz ve kesilmeden gider).
  - Paylaşım, kanaldakilerde bir yayın kartı olarak görünür (CANLI): ekranlıysa görüntü, sesliyse ses
    satırı. Herkes paylaşımın sesini kendi için susturur ya da kısar; ses geldikçe kart ışır.
  - İzlemek ve dinlemek her cihazda olur (telefonda görüntüyü kapatıp yalnızca dinlenebilir).
    Paylaşmak tarayıcıya bağlıdır: paylaş düğmesi yalnızca tarayıcı ekran paylaşımı sunuyorsa görünür
    (masaüstü tarayıcılar; iPhone'da yok, Android'de tarayıcıya göre).
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
| Yedek | `/var/lib/chat` (ayarlar, `sohbet.db*`) |
| Sohbeti temizle | arayüzde sol üstteki veritabanı simgesi → *Sohbeti temizle* |

## Geliştirme

```sh
make            # node ile çalıştır (node, npm ve coturn gerekir) → http://127.0.0.1:8080
make docker     # ya da Docker ile
make test       # sunucu denemeleri (çalışan sunucuya karşı, ILK_ANAHTAR ile)
make arayuz     # arayüz denemeleri (jsdom)
make yanki      # paylaşılan sesten kanaldakilerin sesini çıkarma (benzetim)
make tarayici   # gerçek Chromium'la sesli kanal denemeleri (Playwright)
```

`main`'e her gönderimde GitHub Actions arayüz ve ses çıkarma denemelerini çalıştırır, imajı derler,
sunucu ve tarayıcı denemelerini imaja karşı çalıştırır, `ghcr.io`'ya yükler ve sürüm çıkarır.

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
  toplam ~6 Mbit/s); görüntüyü kapatana ve ekransız paylaşımda kimseye gönderilmez (paylaşımın sesi
  kişi başı ~160 kbps). Daha kalabalık odalar için SFU gerekir.
- Ekran ve ses paylaşımı tarayıcıya bağlıdır: Chrome/Edge'de en iyisi (sekmenin sesi her işletim
  sisteminde, tüm bilgisayarın sesi Windows'ta "Tüm ekran" seçilince). Firefox ve Safari ekranla
  birlikte ses vermez: ses bir ses aygıtından alınır (Linux'ta "Monitor of …"; Windows'ta "Stereo
  Karışımı" açılmalı, Mac'te BlackHole gibi sanal bir aygıt gerekir). Telefon tarayıcılarının çoğu hiç
  paylaşamaz. İzlemek ve dinlemek her yerde olur. Hoparlörden dinleyenin mikrofonu çalan sesi de alır;
  kulaklık önerilir.
- P2P dosya, paylaşanın sayfası açıkken alınabilir. Chrome/Edge (masaüstü) büyük dosyayı doğrudan seçilen
  yere yazar; diğer tarayıcılar önce tarayıcının dosya alanına (kotası diskin bir kısmı) yazar.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~100 kbps); TURN'den geçen dosya
  aktarımı ~0,5 MB/sn ile sınırlıdır (doğrudan bağlanabilenler sınırsız). Yalnızca IPv4.
