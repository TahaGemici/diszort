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
- **Susturunca mikrofon tamamen kapanır** (her cihazda; sağırlaştırınca da): tarayıcının kayıt
  göstergesi söner. Telefonda açık mikrofon telefonu görüşme kipinde tutar (Bluetooth kulaklık tek
  kanallı, boğuk görüşme sesine geçer; çalan ses telefonun görüşme işlemlerinden geçer): susturulmuş
  dinleyende paylaşılan müzik tam kalitede çalar. Açınca mikrofon bir anda yeniden alınır.
- **Telefonda:** sesli kanaldayken ekran kendiliğinden kapanmaz. Android'de sayfa arka planda ve ekran
  kilitliyken de çalışır: sesli kanaldayken döngüde sessiz bir ses çalınır, tarayıcı bildirimde bir
  oynatıcı gösterir (Android, oynatmayan ya da kayıt yapmayan uygulamayı arka planda dondurur).
  Bildirimdeki duraklat bir şey yapmaz; başka bir uygulama sesi alırsa (müzik, arama) o sesin üstüne
  çıkılmaz. Paket gelip ses çalınmıyorsa (arka plandan dönünce görülen) ses kendiliğinden yeniden bağlanır.
  Kulaklıkla konuşurken çalan ses görüşme kalitesine düşmez: Chrome (Samsung Internet vb. de) Android'de
  yankı engellemeli bir mikrofon açılınca telefonu görüşme kipine alır, Bluetooth kulaklık tek kanallı
  görüşme profiline geçer; yankı engellemesi kapalı mikrofonda almaz (Chromium kaynağı). Kulaklık
  takılıyken yankı engelleme kapalı istenir (kulaklıkta yankı olmaz); Bluetooth kulaklıkta ses
  telefonun kendi mikrofonundan alınır (kulaklığın mikrofonu onu yine görüşme profiline geçirirdi),
  telefon konuşana yakın olmalı. Konuşurken kulaklık takılıp çıkarılırsa (Bluetooth bağlanıp
  koparsa) mikrofon yeni duruma göre yeniden açılır (kulaklık çıkınca ses hoparlörden çalar, yankı
  engelleme gerekir). Ses ayarlarında mikrofon seçildiyse ona dokunulmaz. Klasik Bluetooth kulaklık
  zaten aynı anda hem stereo müzik çalıp hem mikrofonunu kullanamaz (her uygulamada mikrofon devreye
  girince görüşme sesine düşer); telefonun mikrofonunu kullanmak bunun bilinen çözümüdür. Görüşme
  kipinde Android başka uygulamalarınki de dahil bütün sesleri görüşme yoluna verir, A2DP'yi hiç
  kullanmaz (Android ses politikası: frameworks/av, enginedefault/src/Engine.cpp). Bu yol konuşma
  için yapılmıştır (tek kanal, 8 kHz'e kadar): konuşmada bozulma pek fark edilmez, müzikte barizdir.
  Ses bağlamının gecikmesi de bunu gösterir: A2DP'de ~250 ms, görüşme kipinde ~100 ms.
- **Kayıplara karşı yedek (RED):** her ses paketi (konuşma da paylaşılan ses de) bir öncekinin kopyasını
  da taşır; tek tük kaybolan paket bir sonrakinden yerine konur. Alıcının uydurmak zorunda kaldığı ses
  %5 rastgele paket kaybında ~%5'ten ~%0,2'ye, %10'da ~%6'dan ~%1'e iner; bedeli bit hızının iki katı.
  RED gönderemeyen tarayıcı (ör. Firefox) düz Opus gönderir (Opus'un kendi, daha zayıf yedeğiyle).
- **Ekran paylaşımı ve birlikte dinleme** (ses kartındaki paylaş düğmesi):
  - *Ekranını paylaş*: ekran, pencere ya da sekme; istenirse sesiyle. İstemeyen görüntüyü kapatır
    (ona hiç gönderilmez, ses yine gelir).
  - *Ekransız paylaş*: bilgisayarın ya da Spotify/YouTube çalan sekmenin sesini paylaşmak da bir ekran
    paylaşımıdır, yalnızca ekran kimseye gönderilmez: ses kanala stereo ve yüksek kalitede gider.
    Paylaşan ekranı sonradan yeniden seçmeden gösterip gizleyebilir. Firefox ve Safari ekran
    paylaşımında ses vermediği için orada ses bir ses aygıtından alınır: tarayıcının çaldığı hoparlörün
    (ses ayarlarında seçilen ya da sistemin varsayılanı) "Monitor of …" aygıtı sorulmadan seçilir;
    bulunamazsa (Windows'ta "Stereo Karışımı", Mac'te sanal aygıt) sorulur. Kanaldakilerin
    konuşması bu sesten çıkarılır: sayfa ne çaldığını
    bilir, gecikmesini ve seviyesini bulup yakalanan sesten çıkarır (tarayıcının yankı engelleyicisi
    kullanılmaz, müzik eşiksiz ve kesilmeden gider). Paylaşılan aygıt tarayıcının ilk açtığı ses
    girişi olmalı: Firefox sonradan açılan ikinci aygıtı ayrı bir arabellekten geçiriyor (ölçümde
    mikrofon önce açıkken yakalama 0,8-0,9 sn gecikti, dinleyen ~4 sn gecikme ve 1-5 sn'lik boşluklar
    duydu; aygıt önce açılınca 79 ms, sonradan açılan mikrofonla da). Bu yüzden Firefox'ta mikrofon
    açıkken paylaşım başlatılırsa mikrofon bir an (~0,5 sn) bırakılıp geri alınır. Firefox'ta yakalama
    gecikmesi ölçülür (duyulmayacak kadar tiz, kısık bir sesle); 300 ms'yi aşarsa yakalama aynı
    sırayla kendiliğinden yeniden açılır.
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
- **Gecikme birikmez:** sesi çalan çıkış bir an durursa (telefonda mikrofon açılıp kapanınca Android ses
  kipini değiştirir; çalma ilk başlarken de olabiliyor) gelen ses alıcının tamponunda birikir;
  tarayıcı bunu ancak sesi hızlandırarak eritir (2 sn'lik duruş gerçek müzikte de konuşmada da
  ~10 sn sürdü, ses bu sürede yer yer %45'e kadar hızlı çaldı; bir telefonda paylaşılan müzikte
  1,4-1,6 sn birikme ölçüldü). Tampon hedefinin 350 ms üstünde ~4 sn kalırsa o kişiyle bağlantı
  kendiliğinden yeniden kurulur (yerel ağda ~30 ms'lik bir kesinti).
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
| `TANI` | 1 | ses teşhis satırlarını günlüğe yaz (0: kapalı); bkz. Yönetim |

Tam liste ve açıklamalar: [`.env.example`](.env.example).

## Yönetim

| İş | Komut |
|---|---|
| Günlük | `sudo docker logs -f diszort` |
| Ses teşhisi | `sudo docker logs diszort 2>&1 \| grep -a '\[tanı\]' \| tail -20` |
| Yeniden başlatma | `sudo docker restart diszort` |
| Sağlık | `curl http://127.0.0.1:8080/saglik` (veritabanı boyutu dahil) |
| Yedek | `/var/lib/chat` (ayarlar, `sohbet.db*`) |
| Sohbeti temizle | arayüzde sol üstteki veritabanı simgesi → *Sohbeti temizle* |

Ses teşhisi: sesli kanaldaki her tarayıcı 10 saniyede bir (ve önemli olaylarda) kendi gördüğünü
gönderir, sunucu yalnızca günlüğe yazar (`[tanı] ad: {…}`). Kişi başı: bağlantı durumu ve türü,
konuşmasının ve paylaşımının gelen bit hızı, kaybı, uydurulan sesi, alıcı tamponunun tuttuğu süre
(`tamponMs`, sese eklenen gecikme) ve hedefi, tamponu eritmek/doldurmak için sesten atılan/eklenen
süre (`hizlandirmaMs`/`yavaslatmaMs`, müzikte duyulur), uydurma olayları, titreşim, çalıyor mu;
paylaştığım sesin o kişiye gidişi (`yayinGiden`: kbps, paket/sn — düzenliyse 50); sayfa önde mi,
ekran açık mı; mikrofonun ve paylaşılan sesin aygıtı, yakalamadaki kopukluklar (`kopukluk`).
Olaylar: `arka-plan` / `one-geldi` (dönüşten ~6 sn sonra durumun tamamı, `arkaPlanSn`),
`birikme` / `yeniden-kur-istendi`, `calma-takildi`, `durum`, `yeniden-kur`, `teklif-hata`. Ses
aygıtından paylaşanda: `yakalama-gecikmesi` (Firefox; sayfa kendi çıkışına duyulmayacak kadar tiz ve kısık,
40 ms'lik bir ses çalar, paylaşılan "Monitor"da kaç ms sonra göründüğünü ölçer: çıkış yolu
`cikisMs` + yakalama yolu; paylaşım başında, 3 dakikada bir ve mikrofon açılıp kapanınca;
`mikrofon`: o an mikrofon açık mı), `yakalama-tazele` (gecikme yüksek ölçüldü: mikrofon bırakılıp
yakalama yeniden açıldı), `yayin-aygit` (`mikOnceBirakildi`: aygıt açılırken mikrofon bir an
bırakıldı) ve `yakalama-kopuklugu` (yakalanan sesteki tam sessizlikler, ms; `*` 200 ms'den uzun;
müzikteki gerçek sessizlikleri de sayar). Sorun sürerken iki cihazın satırlarına birlikte bakılır.

## Geliştirme

```sh
make            # node ile çalıştır (node, npm ve coturn gerekir) → http://127.0.0.1:8080
make docker     # ya da Docker ile
make test       # sunucu denemeleri (çalışan sunucuya karşı, ILK_ANAHTAR ile)
make arayuz     # arayüz denemeleri (jsdom)
make yanki      # paylaşılan sesten kanaldakilerin sesini çıkarma (benzetim)
make tarayici   # gerçek Chromium'la sesli kanal denemeleri (Playwright)
make kayip      # paket kaybında RED'in etkisi (gerçek Chromium, araya paket düşüren UDP aracısı)
```

`main`'e her gönderimde GitHub Actions arayüz, ses çıkarma ve paket kaybı denemelerini çalıştırır,
imajı derler, sunucu ve tarayıcı denemelerini imaja karşı çalıştırır, `ghcr.io`'ya yükler ve sürüm
çıkarır.

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
  toplam ~6 Mbit/s); görüntüyü kapatana ve ekransız paylaşımda kimseye gönderilmez. Ses RED'le hatta
  iki katıdır: konuşma kişi başı ~190 kbps, paylaşımın sesi ~320 kbps (kalabalık kanalda kişi başı
  düşer). Daha kalabalık odalar için SFU gerekir.
- Ekran ve ses paylaşımı tarayıcıya bağlıdır: Chrome/Edge'de en iyisi (sekmenin sesi her işletim
  sisteminde, tüm bilgisayarın sesi Windows'ta "Tüm ekran" seçilince). Firefox ve Safari ekranla
  birlikte ses vermez: ses bir ses aygıtından alınır (Linux'ta "Monitor of …"; Windows'ta "Stereo
  Karışımı" açılmalı, Mac'te BlackHole gibi sanal bir aygıt gerekir). Telefon tarayıcılarının çoğu hiç
  paylaşamaz. İzlemek ve dinlemek her yerde olur. Hoparlörden dinleyenin mikrofonu çalan sesi de alır;
  kulaklık önerilir.
- Konuşma algılayan kulaklıklar (AirPods'un Konuşma Farkındalığı, Sony'nin Speak-to-Chat'i, Pixel Buds,
  Galaxy Buds'ın ses algılaması) takan kişi konuşunca çalan sesi kısar ya da durdurur, konuşma bitince
  birkaç saniyede geri getirir: paylaşılan müzik "konuşunca kısılıyor" gibi duyulur. Bu kulaklığın
  özelliğidir; ayarlarından kapatılır.
- P2P dosya, paylaşanın sayfası açıkken alınabilir. Chrome/Edge (masaüstü) büyük dosyayı doğrudan seçilen
  yere yazar; diğer tarayıcılar önce tarayıcının dosya alanına (kotası diskin bir kısmı) yazar.
- TURN'den geçen ses sunucunun bant genişliğini kullanır (kişi başı ~200 kbps); TURN'den geçen dosya
  aktarımı ~0,5 MB/sn ile sınırlıdır (doğrudan bağlanabilenler sınırsız). Yalnızca IPv4.
